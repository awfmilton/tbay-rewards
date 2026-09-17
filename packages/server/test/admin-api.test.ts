import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeApp,
  closeDb,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';

/**
 * Every call the wp-admin screens make.
 *
 * The plugin cannot be exercised here, so this pins the contract from the
 * server side: if one of these routes is renamed or its shape changes, an
 * admin screen goes blank and this test is what catches it.
 */

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

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('screens the admin renders', () => {
  it('serves every read the screens make', async () => {
    const reads = [
      '/v1/contacts/timeline?email=nobody%40example.com',
      '/v1/rewards/ledger?limit=100',
      '/v1/rewards/rules',
      '/v1/rewards/exclusions',
      '/v1/rewards/product-rules',
      '/v1/gamification/badges/admin',
      '/v1/gamification/ranks/admin',
      '/v1/segments',
      '/v1/broadcasts',
      '/v1/email/templates',
      '/v1/email/engagement',
      '/v1/email/suppressions',
    ];

    for (const url of reads) {
      const response = await call('GET', url);
      // The timeline 404s for an unknown address, which the screen shows as a
      // notice. Everything else must answer.
      expect([200, 404]).toContain(response.statusCode);
    }
  });

  it('serves each read with the shape the screen destructures', async () => {
    const shapes: Array<[string, string]> = [
      ['/v1/rewards/rules', 'rules'],
      ['/v1/rewards/exclusions', 'exclusions'],
      ['/v1/rewards/product-rules', 'rules'],
      ['/v1/gamification/badges/admin', 'badges'],
      ['/v1/gamification/ranks/admin', 'ranks'],
      ['/v1/segments', 'segments'],
      ['/v1/broadcasts', 'broadcasts'],
      ['/v1/email/templates', 'templates'],
      ['/v1/email/suppressions', 'suppressions'],
    ];

    for (const [url, key] of shapes) {
      const body = JSON.parse((await call('GET', url)).body);
      expect(Array.isArray(body[key]), `${url} should return ${key}[]`).toBe(true);
    }

    const engagement = JSON.parse((await call('GET', '/v1/email/engagement')).body);
    expect(Array.isArray(engagement.templates)).toBe(true);

    const ledger = JSON.parse((await call('GET', '/v1/rewards/ledger')).body);
    expect(Array.isArray(ledger.entries)).toBe(true);
    expect(typeof ledger.total).toBe('number');
  });
});

describe('actions the admin forms post', () => {
  it('adjusts a balance with a generated idempotency key', async () => {
    const contact = JSON.parse(
      (await call('POST', '/v1/contacts', { email: 'adjust@example.com' })).body,
    ).contact_id;

    const response = await call('POST', '/v1/rewards/adjust', {
      contactId: contact,
      points: 250,
      reason: 'Goodwill after a delayed order',
      idempotencyKey: 'wpadmin-1-0e2a3c4d-1111-2222-3333-444455556666',
    });
    expect(response.statusCode).toBe(200);
  });

  it('saves a rule with a cap cleared to null', async () => {
    // An empty cap box means "no cap". Sending 0 would mean "can never earn".
    const response = await call('PUT', '/v1/rewards/rules', {
      key: 'review',
      points: 80,
      dailyCap: null,
      enabled: true,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).rule.daily_cap).toBeNull();
  });

  it('adds and removes an exclusion', async () => {
    const added = await call('POST', '/v1/rewards/exclusions', {
      kind: 'email',
      value: 'staff@example.com',
      note: 'shop owner',
    });
    expect(added.statusCode).toBe(200);

    const id = JSON.parse(added.body).exclusion.id;
    const removed = await call('DELETE', `/v1/rewards/exclusions/${id}`);
    expect(JSON.parse(removed.body).removed).toBe(true);
  });

  it('adds and removes a product rule in each mode', async () => {
    for (const body of [
      { matchKind: 'product', matchValue: 'canoe', mode: 'multiplier', multiplier: 2 },
      { matchKind: 'product', matchValue: 'gift-card', mode: 'exclude' },
      { matchKind: 'category', matchValue: 'clearance', mode: 'fixed', points: 5 },
    ]) {
      const response = await call('POST', '/v1/rewards/product-rules', body);
      expect(response.statusCode).toBe(200);
    }

    const rules = JSON.parse((await call('GET', '/v1/rewards/product-rules')).body).rules;
    expect(rules).toHaveLength(3);

    const removed = await call('DELETE', `/v1/rewards/product-rules/${rules[0].id}`);
    expect(JSON.parse(removed.body).removed).toBe(true);
  });

  it('saves a badge and a rank in the shape the form builds', async () => {
    const badge = await call('PUT', '/v1/gamification/badges/regular', {
      name: 'Regular',
      criteria: { type: 'order_count' },
      tiers: [{ level: 1, threshold: 3 }],
      pointsPerTier: 100,
    });
    expect(badge.statusCode).toBe(200);

    const rank = await call('PUT', '/v1/gamification/ranks/gold', {
      name: 'Gold',
      minPoints: 1000,
      maxPoints: null,
    });
    expect(rank.statusCode).toBe(200);
    expect(JSON.parse(rank.body).rank.max_points).toBeNull();
  });

  it('recalculates everyone from an empty body', async () => {
    // The WordPress client sends {} rather than omitting the body.
    const response = await call('POST', '/v1/gamification/reevaluate', {});
    expect(response.statusCode).toBe(200);
    expect(typeof JSON.parse(response.body).contacts).toBe('number');
  });

  it('creates, builds and reads back a one-condition segment', async () => {
    await call('POST', '/v1/contacts', { email: 'buyer@example.com' });
    await call('POST', '/v1/orders', {
      orderRef: 'o1', email: 'buyer@example.com', totalCents: 1_000, subtotalCents: 1_000,
    });

    const saved = await call('PUT', '/v1/segments/buyers', {
      name: 'Buyers',
      definition: {
        match: 'all',
        filters: [{ field: 'order_count', operator: 'gte', value: 1 }],
      },
    });
    expect(saved.statusCode).toBe(200);

    const built = await call('POST', '/v1/segments/buyers/build', {});
    expect(JSON.parse(built.body).members).toBe(1);
  });

  it('drafts, sends and cancels a broadcast', async () => {
    await call('PUT', '/v1/email/templates/promo', { subject: 'Sale', html: '<p>Sale</p>' });
    await call('PUT', '/v1/segments/all', { name: 'Everyone' });
    await call('POST', '/v1/segments/all/build', {});

    const draft = await call('PUT', '/v1/broadcasts/spring', {
      name: 'Spring sale',
      segmentKey: 'all',
      templateKey: 'promo',
    });
    expect(draft.statusCode).toBe(200);

    const sent = await call('POST', '/v1/broadcasts/spring/send', {});
    expect(sent.statusCode).toBe(200);

    const cancelled = await call('POST', '/v1/broadcasts/spring/cancel', {});
    expect(cancelled.statusCode).toBe(200);
  });

  it('edits a template and reads it back for the editor', async () => {
    const saved = await call('PUT', '/v1/email/templates/newsletter_welcome', {
      subject: 'Welcome to our shop',
      html: '<p>Hello {{name}}</p>',
      transactional: true,
    });
    expect(saved.statusCode).toBe(200);

    const read = JSON.parse((await call('GET', '/v1/email/templates/newsletter_welcome')).body);
    expect(read.template.subject).toBe('Welcome to our shop');
    expect(read.template.transactional).toBe(true);
  });

  it('reads a built-in template that has never been overridden', async () => {
    // The editor opens on templates the tenant has not customised, which means
    // the GET has to fall back to the shipped default rather than 404.
    const read = await call('GET', '/v1/email/templates/cart_recovery_1');
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body).template.html).toContain('<');
  });

  it('suppresses and un-suppresses an address with an encoded path', async () => {
    const added = await call('POST', '/v1/email/suppressions', {
      email: 'bad@example.com',
      reason: 'manual',
      detail: 'Added from wp-admin',
    });
    expect(added.statusCode).toBe(200);

    // The screen builds this path with rawurlencode, so the @ arrives encoded.
    const removed = await call(
      'DELETE',
      `/v1/email/suppressions/${encodeURIComponent('bad@example.com')}`,
    );
    expect(JSON.parse(removed.body).removed).toBe(true);
  });
});

describe('the WordPress admin\'s own HTTP habits (HIGH)', () => {
  /** Exactly what class-tbay-api.php used to send on every request. */
  async function asPlugin(method: 'GET' | 'DELETE', url: string) {
    const app = await testApp();
    return app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${tenant.secretKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
    });
  }

  it('answers a DELETE that declares JSON and sends no body', async () => {
    // Nine admin buttons were dead. The plugin set Content-Type on every
    // request and attached a body only to POST, PUT and PATCH, so every
    // DELETE announced JSON and carried nothing -- and Fastify's default
    // parser rejected it with "Body cannot be empty when content-type is set
    // to 'application/json'" before any route ran. Proved against a running
    // server before it was fixed: the same DELETE was 400 with the header and
    // 200 without it.
    await call('PUT', '/v1/gamification/badges/doomed', {
      name: 'Doomed',
      criteria: { type: 'points_total' },
      tiers: [{ level: 1, threshold: 10 }],
    });

    const deleted = await asPlugin('DELETE', '/v1/gamification/badges/doomed');
    expect(deleted.statusCode).toBe(200);

    const listed = await call('GET', '/v1/gamification/badges/admin');
    expect(listed.body).not.toContain('doomed');
  });

  it('still rejects a body that is malformed rather than absent', async () => {
    // The tolerance must not turn a syntax error into a 500, or into a
    // silently empty object that a write then acts on.
    const app = await testApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/gamification/badges/broken',
      headers: {
        authorization: `Bearer ${tenant.secretKey}`,
        'content-type': 'application/json',
      },
      payload: '{"name": "unterminated',
    });
    expect(response.statusCode).toBe(400);
  });

  it('still refuses a write whose required fields are missing', async () => {
    // An empty body parses to an empty object now, so the schema is what has
    // to reject it -- not the parser. If this ever returns 2xx, the tolerance
    // has started creating records out of nothing.
    const response = await asPlugin('GET', '/v1/gamification/badges/admin');
    expect(response.statusCode).toBe(200);

    const app = await testApp();
    const empty = await app.inject({
      method: 'PUT',
      url: '/v1/gamification/badges/nameless',
      headers: {
        authorization: `Bearer ${tenant.secretKey}`,
        'content-type': 'application/json',
      },
      payload: '',
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('the site key cannot reach any of it', () => {
  it('refuses every admin route without the secret key', async () => {
    const app = await testApp();
    for (const url of [
      '/v1/rewards/ledger',
      '/v1/rewards/exclusions',
      '/v1/segments',
      '/v1/broadcasts',
      '/v1/email/templates',
      '/v1/email/suppressions',
      '/v1/contacts/timeline?email=a%40b.com',
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-tbay-key': tenant.publicKey },
      });
      expect([401, 403], `${url} must not accept a site key`).toContain(response.statusCode);
    }
  });
});
