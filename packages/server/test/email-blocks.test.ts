import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import {
  blocksToText,
  renderBlocks,
  renderDocument,
  segmentsUsed,
  validateBlocks,
} from '../src/services/email-blocks.js';
import { buildSegment } from '../src/services/segments.js';
import { sendBroadcastBatch, startBroadcast } from '../src/services/broadcasts.js';
import { fire } from '../src/services/automations.js';
import { getTemplate } from '../src/services/email.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

async function authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('validating blocks', () => {
  it('rejects an unknown block type rather than dropping it', () => {
    expect(() => validateBlocks([{ type: 'iframe', src: 'https://x.test' }])).toThrow(/unknown type/i);
  });

  it('drops fields the renderer will never read', () => {
    const [block] = validateBlocks([{ type: 'text', text: 'Hi', onclick: 'steal()' }]);
    expect(block).toEqual({ type: 'text', text: 'Hi' });
  });

  it('refuses a javascript: link', () => {
    // Inert in most mail clients, live in the wp-admin preview, which renders
    // the same HTML inside an admin's session.
    expect(() =>
      validateBlocks([{ type: 'button', label: 'Go', url: 'javascript:alert(1)' }]),
    ).toThrow(/http, https or mailto/i);
  });

  it('refuses a data: link', () => {
    expect(() =>
      validateBlocks([{ type: 'image', src: 'data:text/html;base64,PHNjcmlwdD4=' }]),
    ).toThrow(/http, https or mailto/i);
  });

  it('allows a merge field where a URL goes', () => {
    const [block] = validateBlocks([{ type: 'button', label: 'Rewards', url: '{{rewards_url}}' }]);
    expect(block).toMatchObject({ url: '{{rewards_url}}' });
  });

  it('refuses a segment key that is not one', () => {
    expect(() =>
      validateBlocks([{ type: 'divider', visibleTo: "vip'; DROP TABLE contacts; --" }]),
    ).toThrow(/is not a segment key/i);
  });

  it('caps the number of blocks and products', () => {
    const many = Array.from({ length: 61 }, () => ({ type: 'divider' }));
    expect(() => validateBlocks(many)).toThrow(/at most 60 blocks/i);

    const products = Array.from({ length: 13 }, (_, i) => ({ title: `P${i}` }));
    expect(() => validateBlocks([{ type: 'products', items: products }])).toThrow(/at most 12/i);
  });
});

describe('rendering blocks', () => {
  it('escapes everything somebody types', () => {
    const html = renderBlocks(
      validateBlocks([
        { type: 'heading', text: '<script>alert(1)</script>' },
        { type: 'text', text: 'Tom & Jerry <b>sale</b>' },
      ]),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Tom &amp; Jerry');
  });

  it('leaves merge fields intact through escaping', () => {
    const html = renderBlocks(validateBlocks([{ type: 'text', text: 'Hello {{name}}' }]));
    expect(html).toContain('{{name}}');
  });

  it('turns blank lines into paragraphs', () => {
    const html = renderBlocks(validateBlocks([{ type: 'text', text: 'One\n\nTwo' }]));
    expect(html.match(/<p /g)).toHaveLength(2);
  });

  it('frames a document with the unsubscribe footer', () => {
    // A bare fragment is marketing with no visible way out of it.
    const html = renderDocument(validateBlocks([{ type: 'text', text: 'Hi' }]));
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toContain('{{preferences_url}}');
  });

  it('hides a preheader from the body but shows it to the client', () => {
    const html = renderDocument(validateBlocks([{ type: 'text', text: 'Hi' }]), new Set(), 'Sale ends Friday');
    expect(html).toContain('Sale ends Friday');
    expect(html).toContain('display:none');
    expect(html.indexOf('Sale ends Friday')).toBeLessThan(html.indexOf('Hi'));
  });

  it('writes a plain-text copy without markup', () => {
    const text = blocksToText(
      validateBlocks([
        { type: 'heading', text: 'Sale' },
        { type: 'button', label: 'Shop', url: 'https://shop.test/sale' },
      ]),
    );
    expect(text).toContain('Sale');
    expect(text).toContain('https://shop.test/sale');
    expect(text).not.toContain('<');
  });
});

describe('dynamic content', () => {
  const conditional = [
    { type: 'text', text: 'Everybody gets this' },
    { type: 'text', text: 'VIP early access', visibleTo: 'vip' },
    { type: 'text', text: 'Join our VIP tier', hiddenFrom: 'vip' },
  ];

  it('collects the segments a block list refers to', () => {
    expect(segmentsUsed(validateBlocks(conditional)).sort()).toEqual(['vip']);
  });

  it('shows a member the visibleTo block and hides the hiddenFrom one', () => {
    const blocks = validateBlocks(conditional);
    const member = renderBlocks(blocks, new Set(['vip']));
    expect(member).toContain('VIP early access');
    expect(member).not.toContain('Join our VIP tier');

    const other = renderBlocks(blocks, new Set());
    expect(other).not.toContain('VIP early access');
    expect(other).toContain('Join our VIP tier');
  });

  it('keeps the plain-text copy in step with the HTML', () => {
    const blocks = validateBlocks(conditional);
    expect(blocksToText(blocks, new Set(['vip']))).not.toContain('Join our VIP tier');
  });
});

describe('composed templates', () => {
  it('stores the blocks and the HTML rendered from them', async () => {
    const response = await authed('PUT', '/v1/email/templates/composed', {
      subject: 'This month at {{tenant_name}}',
      preheader: 'Three things we think you will like',
      blocks: [
        { type: 'heading', text: 'New in' },
        { type: 'products', items: [{ title: 'Maple syrup', price: '$12', url: 'https://shop.test/p1' }] },
        { type: 'button', label: 'Shop', url: 'https://shop.test' },
      ],
    });
    expect(response.statusCode).toBe(200);

    const template = await getTemplate(tenant.id, 'composed');
    expect(template?.html).toContain('Maple syrup');
    expect(template?.html).toContain('<!doctype html>');
    expect(template?.preheader).toBe('Three things we think you will like');
    // Kept so the builder can reopen what somebody wrote — generated HTML
    // cannot be parsed back into blocks.
    expect(Array.isArray(template?.blocks)).toBe(true);
    expect((template?.blocks as unknown[]).length).toBe(3);
  });

  it('refuses a template with neither html nor blocks', async () => {
    const response = await authed('PUT', '/v1/email/templates/empty', { subject: 'Nothing' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a bad block without saving anything', async () => {
    const response = await authed('PUT', '/v1/email/templates/bad', {
      subject: 'Bad',
      blocks: [{ type: 'button', label: 'Go', url: 'javascript:alert(1)' }],
    });
    expect(response.statusCode).toBe(400);
    expect(await getTemplate(tenant.id, 'bad')).toBeNull();
  });
});

describe('previewing', () => {
  it('renders a named contact their own copy', async () => {
    await authed('POST', '/v1/contacts', { email: 'vip@example.com', tags: ['vip'] });
    await authed('POST', '/v1/contacts', { email: 'other@example.com', tags: [] });
    await authed('PUT', '/v1/segments/vip', {
      name: 'VIPs',
      definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: ['vip'] }] },
    });
    await buildSegment(tenant.id, 'vip');

    const { rows } = await db().query<{ id: string; email: string }>(
      'SELECT id, email FROM contacts WHERE tenant_id = $1 ORDER BY email',
      [tenant.id],
    );
    const vip = rows.find((row) => row.email === 'vip@example.com')!;
    const other = rows.find((row) => row.email === 'other@example.com')!;

    const blocks = [
      { type: 'text', text: 'Everybody gets this' },
      { type: 'text', text: 'VIP early access', visibleTo: 'vip' },
    ];

    const asVip = await authed('POST', '/v1/email/preview', { blocks, as: vip.id, subject: 'Hi' });
    expect(asVip.json().html).toContain('VIP early access');
    expect(asVip.json().segments_matched).toEqual(['vip']);

    const asOther = await authed('POST', '/v1/email/preview', { blocks, as: other.id });
    expect(asOther.json().html).not.toContain('VIP early access');
    expect(asOther.json().segments_used).toEqual(['vip']);
    expect(asOther.json().segments_matched).toEqual([]);
  });

  it('never gives the preview a working unsubscribe link', async () => {
    const response = await authed('POST', '/v1/email/preview', {
      blocks: [{ type: 'text', text: 'Hi' }],
    });
    const html = response.json().html as string;
    expect(html).not.toContain('{{unsubscribe_url}}');
    expect(html).toContain('href="#"');
  });

  it('describes every block type it will accept', async () => {
    const response = await authed('GET', '/v1/email/blocks');
    const types = (response.json().blocks as Array<{ type: string }>).map((block) => block.type);
    expect(types).toContain('products');
    expect(types).toContain('points');
    // Every block carries the audience fields, so a builder need not know to
    // add them itself.
    for (const block of response.json().blocks as Array<{ fields: Array<{ name: string }> }>) {
      const names = block.fields.map((field) => field.name);
      expect(names).toContain('visibleTo');
      expect(names).toContain('hiddenFrom');
    }
  });
});

describe('a broadcast that composes its own body', () => {
  async function seedAudience(): Promise<void> {
    for (const [email, tags] of [
      ['vip@example.com', ['promo', 'vip']],
      ['plain@example.com', ['promo']],
    ] as const) {
      await authed('POST', '/v1/contacts', { email, tags, marketingConsent: true });
    }
    for (const [key, tag] of [
      ['promo', 'promo'],
      ['vip', 'vip'],
    ] as const) {
      await authed('PUT', `/v1/segments/${key}`, {
        name: key,
        definition: { match: 'all', filters: [{ field: 'tags', operator: 'contains', value: [tag] }] },
      });
      await buildSegment(tenant.id, key);
    }
  }

  it('sends without a template, and gives each recipient their own copy', async () => {
    await seedAudience();

    const saved = await authed('PUT', '/v1/broadcasts/september', {
      name: 'September newsletter',
      segmentKey: 'promo',
      subject: 'September at {{tenant_name}}',
      preheader: 'Your points, and what is new',
      blocks: [
        { type: 'heading', text: 'September' },
        { type: 'points', heading: 'Your balance' },
        { type: 'text', text: 'VIP early access opens Friday', visibleTo: 'vip' },
      ],
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().broadcast.template_key).toBeNull();

    await startBroadcast(tenant.id, 'september');
    const result = await sendBroadcastBatch(tenant.id, 'september', 50);
    expect(result.queued).toBe(2);

    const { rows } = await db().query<{ to_email: string; html: string; subject: string; template_key: string }>(
      'SELECT to_email, html, subject, template_key FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    const vip = rows.find((row) => row.to_email === 'vip@example.com')!;
    const plain = rows.find((row) => row.to_email === 'plain@example.com')!;

    expect(vip.html).toContain('VIP early access opens Friday');
    expect(plain.html).not.toContain('VIP early access opens Friday');

    // The subject's merge fields are resolved, the preheader is in the body,
    // and both recipients still get a real unsubscribe link.
    expect(vip.subject).not.toContain('{{');
    expect(plain.html).toContain('Your points, and what is new');
    // The link is there and resolved — click tracking has rewritten the href
    // into a tracked redirect, which is what it does to every other template.
    expect(plain.html).toContain('Unsubscribe');
    expect(plain.html).not.toContain('{{unsubscribe_url}}');
    // Reporting groups by this, and a composed send has no template to name.
    expect(plain.template_key).toBe('broadcast:september');
  });

  it("shows the retailer's default currency, whatever it is called", async () => {
    await seedAudience();
    // A store whose default currency is not keyed "points".
    await db().query(
      `UPDATE point_types SET is_default = false WHERE tenant_id = $1`,
      [tenant.id],
    );
    await db().query(
      `INSERT INTO point_types (tenant_id, key, name, singular, plural, is_default)
       VALUES ($1, 'credits', 'Credits', 'credit', 'credits', true)`,
      [tenant.id],
    );
    const { rows } = await db().query<{ id: string }>(
      "SELECT id FROM contacts WHERE tenant_id = $1 AND email = 'plain@example.com'",
      [tenant.id],
    );
    await db().query(
      `INSERT INTO points_balances (tenant_id, contact_id, point_type, balance)
       VALUES ($1, $2, 'credits', 420)`,
      [tenant.id, rows[0]!.id],
    );

    await authed('PUT', '/v1/broadcasts/balances', {
      name: 'Balances',
      segmentKey: 'promo',
      subject: 'Your balance',
      blocks: [{ type: 'points', heading: 'You have' }],
    });
    await startBroadcast(tenant.id, 'balances');
    await sendBroadcastBatch(tenant.id, 'balances', 50);

    const sent = await db().query<{ html: string }>(
      "SELECT html FROM email_messages WHERE tenant_id = $1 AND to_email = 'plain@example.com'",
      [tenant.id],
    );
    expect(sent.rows[0]!.html).toContain('420');
  });

  it('needs a subject when it has no template to take one from', async () => {
    const response = await authed('PUT', '/v1/broadcasts/nosubject', {
      name: 'No subject',
      blocks: [{ type: 'text', text: 'Hi' }],
    });
    expect(response.statusCode).toBe(400);
  });

  it('switching to a template clears the composed body, and back again', async () => {
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Our sale', html: '<p>Sale</p>' });

    await authed('PUT', '/v1/broadcasts/switch', {
      name: 'Switcher',
      subject: 'Hello',
      blocks: [{ type: 'text', text: 'Composed' }],
    });

    const toTemplate = await authed('PUT', '/v1/broadcasts/switch', { templateKey: 'promo' });
    expect(toTemplate.json().broadcast.blocks).toBeNull();
    expect(toTemplate.json().broadcast.template_key).toBe('promo');

    const back = await authed('PUT', '/v1/broadcasts/switch', {
      subject: 'Hello',
      blocks: [{ type: 'text', text: 'Composed again' }],
    });
    expect(back.json().broadcast.template_key).toBeNull();
    expect(back.json().broadcast.blocks).toHaveLength(1);
  });

  it('refuses to arm a composed broadcast nobody has written yet', async () => {
    await seedAudience();
    // The state the "prepare a send" form leaves behind when no template is
    // named: a draft with a subject and an empty body.
    await authed('PUT', '/v1/broadcasts/blank', {
      name: 'Blank',
      segmentKey: 'promo',
      subject: 'Nothing yet',
      blocks: [],
    });
    await expect(startBroadcast(tenant.id, 'blank')).rejects.toThrow(/no message yet/i);
  });

  it('refuses to arm a broadcast whose template has been deleted', async () => {
    await seedAudience();
    await authed('PUT', '/v1/email/templates/temp', { subject: 'Temp', html: '<p>Temp</p>' });
    await authed('PUT', '/v1/broadcasts/armed', {
      name: 'Armed',
      segmentKey: 'promo',
      templateKey: 'temp',
    });
    await authed('DELETE', '/v1/email/templates/temp');

    // Caught at arm time rather than halfway through the audience.
    await expect(startBroadcast(tenant.id, 'armed')).rejects.toThrow(/No email template/);
  });
});

describe('composed templates in an automation', () => {
  it('fills in the balance a points block asks for', async () => {
    const created = await authed('POST', '/v1/contacts', {
      email: 'earner@example.com',
      name: 'Erin',
      marketingConsent: true,
    });
    const contactId = created.json().contact_id as string;

    await db().query(
      `INSERT INTO points_balances (tenant_id, contact_id, point_type, balance)
       VALUES ($1, $2, 'points', 1250)`,
      [tenant.id, contactId],
    );

    await authed('PUT', '/v1/email/templates/balance_note', {
      subject: 'Where you stand',
      transactional: true,
      blocks: [
        { type: 'heading', text: 'Where you stand' },
        { type: 'points', heading: 'Your balance' },
      ],
    });

    await authed('PUT', '/v1/automations/balance_note', {
      name: 'Balance note',
      triggerType: 'contact.created',
      actions: [{ type: 'send_email', template: 'balance_note' }],
    });

    // The trigger carries no balance — the message has to find it.
    await fire(tenant.id, 'contact.created', {
      contact: { id: contactId, email: 'earner@example.com', name: 'Erin' } as never,
      data: {},
      dedupeKey: `contact:${contactId}`,
    });

    const { rows } = await db().query<{ html: string }>(
      "SELECT html FROM email_messages WHERE tenant_id = $1 AND to_email = 'earner@example.com'",
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.html).toContain('1250');
    expect(rows[0]!.html).not.toContain('{{points_balance}}');
  });
});
