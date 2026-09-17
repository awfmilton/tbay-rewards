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
  describeBlocks,
  renderBlocks,
  renderDocument,
  segmentsUsed,
  validateBlocks,
  type BlockFieldSpec,
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

describe('the catalogue and the validator agree', () => {
  // The builder UI is generated from describeBlocks(). A field described here
  // that validateBlocks() drops looks, in wp-admin, like the block "not
  // saving" — and fails nowhere a developer is looking.
  const sample = (spec: BlockFieldSpec): unknown => {
    switch (spec.kind) {
      case 'url':
        return 'https://example.test/x';
      case 'choice':
        return spec.choices![spec.choices!.length - 1]!.value;
      case 'list':
        return [Object.fromEntries((spec.fields ?? []).map((sub) => [sub.name, sample(sub)]))];
      default:
        return `sample ${spec.name}`;
    }
  };

  it('keeps every field the catalogue describes', () => {
    for (const spec of describeBlocks()) {
      const input: Record<string, unknown> = { type: spec.type };
      for (const field of spec.fields) {
        input[field.name] = field.name === 'visibleTo' || field.name === 'hiddenFrom'
          ? 'some_segment'
          : sample(field);
      }

      const [block] = validateBlocks([input]) as [Record<string, unknown>];
      for (const field of spec.fields) {
        expect(
          block[field.name],
          `${spec.type}.${field.name} was described but dropped`,
        ).toBeDefined();
      }
    }
  });

  it('describes every block type the validator accepts', () => {
    const described = describeBlocks().map((spec) => spec.type);
    // Anything the validator takes but the catalogue omits is a block a
    // retailer can never reach from wp-admin.
    for (const type of ['heading', 'text', 'button', 'image', 'divider', 'spacer', 'products', 'points']) {
      expect(described).toContain(type);
    }
    expect(described).toHaveLength(8);
  });

  it('describes a choice field only with values the validator keeps', () => {
    for (const spec of describeBlocks()) {
      // A complete block, so a required field missing is not what fails.
      const base: Record<string, unknown> = { type: spec.type };
      for (const field of spec.fields) {
        if (field.name === 'visibleTo' || field.name === 'hiddenFrom') continue;
        if (field.kind !== 'choice') base[field.name] = sample(field);
      }

      for (const field of spec.fields) {
        if (field.kind !== 'choice') continue;
        for (const choice of field.choices!) {
          const [block] = validateBlocks([{ ...base, [field.name]: choice.value }]) as [
            Record<string, unknown>,
          ];
          expect(
            String(block[field.name]),
            `${spec.type}.${field.name} does not keep "${choice.value}"`,
          ).toBe(choice.value);
        }
      }
    }
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
      // Upsert: creating a contact pays the shipped signup rule now, so the
      // balance row already exists. This test wants the balance to *be* 1250.
      `INSERT INTO points_balances (tenant_id, contact_id, point_type, balance)
       VALUES ($1, $2, 'points', 1250)
       ON CONFLICT (tenant_id, contact_id, point_type)
         DO UPDATE SET balance = EXCLUDED.balance`,
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

  it('shows the balance, not the amount the order just earned', async () => {
    // `order.completed` carries `points` — what that order earned. Reading it
    // as a balance put "Your points: 50" in front of somebody holding 1050.
    const created = await authed('POST', '/v1/contacts', {
      email: 'buyer@example.com',
      marketingConsent: true,
    });
    const contactId = created.json().contact_id as string;
    await db().query(
      `INSERT INTO points_balances (tenant_id, contact_id, point_type, balance)
       VALUES ($1, $2, 'points', 1000)
       ON CONFLICT (tenant_id, contact_id, point_type)
         DO UPDATE SET balance = EXCLUDED.balance`,
      [tenant.id, contactId],
    );

    await authed('PUT', '/v1/email/templates/order_note', {
      subject: 'Thanks',
      transactional: true,
      blocks: [{ type: 'points', heading: 'Your balance' }],
    });
    await authed('PUT', '/v1/automations/order_note', {
      name: 'Order note',
      triggerType: 'order.completed',
      actions: [{ type: 'send_email', template: 'order_note' }],
    });

    await fire(tenant.id, 'order.completed', {
      contact: { id: contactId, email: 'buyer@example.com' } as never,
      data: { order_ref: 'o-1', total_cents: 5000, points: 50 },
      dedupeKey: 'order:o-1',
    });

    const { rows } = await db().query<{ html: string }>(
      "SELECT html FROM email_messages WHERE tenant_id = $1 AND to_email = 'buyer@example.com'",
      [tenant.id],
    );
    expect(rows[0]!.html).toContain('1000');
    expect(rows[0]!.html).not.toContain('>50<');
  });
});

describe('what the reviews found', () => {
  it('does not escape the subject line', async () => {
    // A store called "Bob's Bikes" was arriving as "Bob&#39;s Bikes".
    await db().query('UPDATE tenants SET name = $2 WHERE id = $1', [tenant.id, "Bob's Bikes"]);
    await authed('POST', '/v1/contacts', { email: 'sub@example.com', marketingConsent: true });
    await authed('PUT', '/v1/email/templates/greet', {
      subject: 'News from {{tenant_name}}',
      transactional: true,
      blocks: [{ type: 'text', text: 'Hello' }],
    });
    await authed('PUT', '/v1/automations/greet', {
      name: 'Greet',
      triggerType: 'contact.created',
      actions: [{ type: 'send_email', template: 'greet' }],
    });
    const created = await authed('POST', '/v1/contacts', {
      email: 'greeted@example.com',
      marketingConsent: true,
    });
    await fire(tenant.id, 'contact.created', {
      contact: { id: created.json().contact_id, email: 'greeted@example.com' } as never,
      data: {},
      dedupeKey: 'c-1',
    });

    const { rows } = await db().query<{ subject: string; text: string }>(
      "SELECT subject, text FROM email_messages WHERE to_email = 'greeted@example.com'",
    );
    expect(rows[0]!.subject).toBe("News from Bob's Bikes");
  });

  it('does not put HTML entities in the plain-text part', async () => {
    const blocks = validateBlocks([
      { type: 'text', text: "Tom & Jerry's sale" },
      { type: 'button', label: 'Shop', url: 'https://shop.test/?a=1&b=2' },
    ]);
    const text = blocksToText(blocks);
    // `&amp;` in a text-only client is a broken link and a misspelt name.
    expect(text).toContain("Tom & Jerry's sale");
    expect(text).toContain('https://shop.test/?a=1&b=2');
    expect(text).not.toContain('&amp;');
    expect(text).not.toContain('&#39;');
  });

  it('refuses a template whose block list is empty', async () => {
    const response = await authed('PUT', '/v1/email/templates/hollow', {
      subject: 'Hollow',
      blocks: [],
    });
    expect(response.statusCode).toBe(400);
    expect(await getTemplate(tenant.id, 'hollow')).toBeNull();
  });

  it('refuses a block naming a segment that does not exist', async () => {
    const response = await authed('PUT', '/v1/email/templates/typo', {
      subject: 'Typo',
      blocks: [{ type: 'text', text: 'VIP only', visibleTo: 'vips' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/no segment "vips"/i);
  });

  it('refuses a field of the wrong type rather than coercing it', () => {
    // String({a: 1}) is "[object Object]", which a retailer then finds in a
    // sent newsletter.
    expect(() => validateBlocks([{ type: 'heading', text: { a: 1 } }])).toThrow(/must be text/i);
    expect(() => validateBlocks([{ type: 'text', text: ['a', 'b'] }])).toThrow(/must be text/i);
    expect(() => validateBlocks([{ type: 'products', items: { 0: { title: 'x' } } }])).toThrow(
      /must be a list/i,
    );
    expect(() => validateBlocks([{ type: 'divider', visibleTo: ['vip'] }])).toThrow(
      /must be a segment key/i,
    );
  });

  it('refuses an empty value where the catalogue says required', () => {
    expect(() => validateBlocks([{ type: 'heading', text: '  ' }])).toThrow(/is required/i);
    expect(() => validateBlocks([{ type: 'text', text: '' }])).toThrow(/is required/i);
    expect(() => validateBlocks([{ type: 'button', label: '', url: 'https://a.test' }])).toThrow(
      /is required/i,
    );
    expect(() => validateBlocks([{ type: 'products', items: [{ title: '' }] }])).toThrow(
      /is required/i,
    );
  });

  it('does not wipe a composed body when a later save names no body', async () => {
    // The "prepare a send" form is the only screen that can change a draft's
    // segment, so it is re-submitted for sends that already have a message.
    await authed('PUT', '/v1/segments/promo', {
      name: 'Promo',
      definition: { match: 'all', filters: [{ field: 'order_count', operator: 'gte', value: 0 }] },
    });
    await authed('PUT', '/v1/broadcasts/keeper', {
      name: 'Keeper',
      segmentKey: 'promo',
      subject: 'Hello',
      blocks: [{ type: 'text', text: 'Written in the composer' }],
    });

    // Exactly what that form posts.
    const again = await authed('PUT', '/v1/broadcasts/keeper', {
      name: 'Keeper',
      segmentKey: 'promo',
      subject: 'Hello',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().broadcast.blocks).toHaveLength(1);
  });

  it('does not un-schedule a send when its message is edited', async () => {
    await authed('PUT', '/v1/segments/promo', {
      name: 'Promo',
      definition: { match: 'all', filters: [{ field: 'order_count', operator: 'gte', value: 0 }] },
    });
    await authed('PUT', '/v1/broadcasts/timed', {
      name: 'Timed',
      segmentKey: 'promo',
      subject: 'Friday',
      sendAt: '2030-01-01T10:00:00Z',
      blocks: [{ type: 'text', text: 'First draft' }],
    });

    // The composer never posts a time; it used to mean "draft, never sends".
    const edited = await authed('PUT', '/v1/broadcasts/timed', {
      name: 'Timed',
      subject: 'Friday',
      blocks: [{ type: 'text', text: 'Second draft' }],
    });
    expect(edited.json().broadcast.status).toBe('scheduled');
    expect(edited.json().broadcast.send_at).not.toBeNull();

    // And an explicit null still clears it.
    const cleared = await authed('PUT', '/v1/broadcasts/timed', { sendAt: null });
    expect(cleared.json().broadcast.status).toBe('draft');
  });

  it('refuses a template and a composed body in the same call', async () => {
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    const response = await authed('PUT', '/v1/broadcasts/confused', {
      name: 'Confused',
      subject: 'Which one',
      templateKey: 'promo',
      blocks: [{ type: 'text', text: 'Or this' }],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/not both/i);
  });

  it('refuses a preheader on a send that uses a template', async () => {
    await authed('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    const response = await authed('PUT', '/v1/broadcasts/tpl', {
      name: 'Templated',
      templateKey: 'promo',
      preheader: 'Never read',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toMatch(/preheader belongs to the message/i);
  });

  it('lets a draft exist before anybody has written it', async () => {
    await authed('PUT', '/v1/segments/promo', {
      name: 'Promo',
      definition: { match: 'all', filters: [{ field: 'order_count', operator: 'gte', value: 0 }] },
    });
    const created = await authed('PUT', '/v1/broadcasts/unwritten', {
      name: 'Unwritten',
      segmentKey: 'promo',
      subject: 'To be written',
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().broadcast.template_key).toBeNull();
    expect(created.json().broadcast.blocks).toBeNull();
    // Arming it is what is refused.
    await expect(startBroadcast(tenant.id, 'unwritten')).rejects.toThrow(/has no body|no message/i);
  });

  it('keeps the fields a save does not name', async () => {
    // wp-admin's form does not post `text`, and an API caller editing a
    // subject line posts neither `transactional` nor `topicKey`. Each omission
    // used to clear the field — and clearing `transactional` stops a receipt
    // reaching anyone without a marketing opt-in.
    await authed('PUT', '/v1/email/topics/receipts', { name: 'Receipts' });
    await authed('PUT', '/v1/email/templates/receipt', {
      subject: 'Your order',
      html: '<p>Thanks</p>',
      text: 'Thanks for your order',
      transactional: true,
      topicKey: 'receipts',
      preheader: 'Order confirmed',
    });

    const edited = await authed('PUT', '/v1/email/templates/receipt', {
      subject: 'Your order is on its way',
      html: '<p>On its way</p>',
    });
    expect(edited.statusCode).toBe(200);

    const after = await getTemplate(tenant.id, 'receipt');
    expect(after?.subject).toBe('Your order is on its way');
    expect(after?.text).toBe('Thanks for your order');
    expect(after?.transactional).toBe(true);
    expect(after?.topic_key).toBe('receipts');
    expect(after?.preheader).toBe('Order confirmed');
  });

  it('still lets each of those be cleared on purpose', async () => {
    await authed('PUT', '/v1/email/templates/clearable', {
      subject: 'Clearable', html: '<p>Hi</p>', text: 'Hi', transactional: true,
    });
    await authed('PUT', '/v1/email/templates/clearable', {
      subject: 'Clearable', html: '<p>Hi</p>', text: null, transactional: false,
    });
    const after = await getTemplate(tenant.id, 'clearable');
    expect(after?.text).toBeNull();
    expect(after?.transactional).toBe(false);
  });

  it('replaces a composed body when hand-written HTML is saved over it', async () => {
    await authed('PUT', '/v1/email/templates/wasblocks', {
      subject: 'Was blocks',
      blocks: [{ type: 'text', text: 'Composed' }],
    });
    expect((await getTemplate(tenant.id, 'wasblocks'))?.blocks).toHaveLength(1);

    await authed('PUT', '/v1/email/templates/wasblocks', {
      subject: 'Was blocks', html: '<p>Hand written</p>',
    });
    const after = await getTemplate(tenant.id, 'wasblocks');
    // Generated HTML cannot be parsed back into blocks, so keeping both would
    // leave the builder reopening something the message no longer is.
    expect(after?.blocks).toBeNull();
    expect(after?.html).toBe('<p>Hand written</p>');
  });

  it('lets a template leave every topic', async () => {
    await authed('PUT', '/v1/email/topics/offers', { name: 'Offers' });
    await authed('PUT', '/v1/email/templates/topical', {
      subject: 'Offers', html: '<p>Offers</p>', topicKey: 'offers',
    });
    expect((await getTemplate(tenant.id, 'topical'))?.topic_key).toBe('offers');

    await authed('PUT', '/v1/email/templates/topical', {
      subject: 'Offers', html: '<p>Offers</p>', topicKey: null,
    });
    expect((await getTemplate(tenant.id, 'topical'))?.topic_key).toBeNull();
  });
});
