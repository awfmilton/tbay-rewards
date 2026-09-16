import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  DESKTOP_UA,
  closeApp,
  closeDb,
  db,
  ids,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { flushEmailQueue, outbox, setEmailTransport } from '../src/services/email.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  setEmailTransport(null);
  outbox().length = 0;
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

async function authed(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('contact timeline', () => {
  it('merges orders, points, email and sessions into one list', async () => {
    const app = await testApp();
    const { visitor, session } = ids();

    // A visit, identified to the contact.
    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        visitor,
        session,
        url: 'https://shop.example.com/shop',
        events: [{ type: 'pageview', url: 'https://shop.example.com/shop' }],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-tbay-key': tenant.publicKey },
      // No `session` key: /v1/identify is a strict schema, which is what stops
      // an extra field being smuggled into an identity change.
      payload: { visitor, email: 'shopper@example.com' },
    });

    await authed('POST', '/v1/orders', {
      orderRef: 'ord-1',
      email: 'shopper@example.com',
      totalCents: 12_500,
      subtotalCents: 12_500,
    });

    await authed('PUT', '/v1/email/templates/hello', {
      subject: 'Hello there', html: '<p>Hi</p>', transactional: true,
    });
    const contactId = JSON.parse(
      (await authed('POST', '/v1/contacts', { email: 'shopper@example.com' })).body,
    ).contact_id;

    const { queueEmail } = await import('../src/services/email.js');
    await queueEmail({
      tenantId: tenant.id,
      contactId,
      templateKey: 'hello',
      to: 'shopper@example.com',
      subject: 'Hello there',
      html: '<p>Hi</p>',
      dedupeKey: 'hello-1',
    });
    await flushEmailQueue();

    const response = await authed(
      'GET',
      `/v1/contacts/timeline?email=${encodeURIComponent('shopper@example.com')}`,
    );
    const body = JSON.parse(response.body);

    const kinds = body.timeline.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toContain('order');
    expect(kinds).toContain('points');
    expect(kinds).toContain('email_sent');
    expect(kinds).toContain('session');

    // Newest first, so the most recent thing is what a support agent reads.
    const times = body.timeline.map((e: { occurred_at: string }) => new Date(e.occurred_at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('summarises the numbers a support agent needs first', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'ord-1', email: 'spend@example.com', totalCents: 20_000, subtotalCents: 20_000,
    });
    await authed('POST', '/v1/orders', {
      orderRef: 'ord-2', email: 'spend@example.com', totalCents: 30_000, subtotalCents: 30_000,
    });

    const response = await authed(
      'GET',
      `/v1/contacts/timeline?email=${encodeURIComponent('spend@example.com')}`,
    );
    const { summary } = JSON.parse(response.body);

    expect(summary.orders).toBe(2);
    expect(summary.total_spent_cents).toBe(50_000);
    // 500 from the two orders at 1 point per currency unit, plus 50 for the
    // account the first order created.
    expect(summary.lifetime_points).toBe(550);
  });

  it('filters by kind', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'ord-1', email: 'filter@example.com', totalCents: 1_000, subtotalCents: 1_000,
    });

    const response = await authed(
      'GET',
      `/v1/contacts/timeline?email=${encodeURIComponent('filter@example.com')}&kinds=order`,
    );
    const body = JSON.parse(response.body);
    expect(body.timeline.every((e: { kind: string }) => e.kind === 'order')).toBe(true);
  });

  it('does not let a noisy source crowd out a rare one', async () => {
    const app = await testApp();
    await authed('POST', '/v1/orders', {
      orderRef: 'ord-1', email: 'noisy@example.com', totalCents: 1_000, subtotalCents: 1_000,
    });

    const identify = await authed('POST', '/v1/contacts', { email: 'noisy@example.com' });
    const contactId = JSON.parse(identify.body).contact_id;

    // Sixty sessions against one order. Each arm is limited before the union,
    // so the order survives into the first page.
    for (let i = 0; i < 60; i += 1) {
      const { visitor, session } = ids();
      await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
        payload: { visitor, session, url: 'https://shop.example.com/', events: [] },
      });
      await db().query('UPDATE visitors SET contact_id = $1 WHERE contact_id IS NULL', [contactId]);
    }

    const response = await authed(
      'GET',
      `/v1/contacts/timeline?email=${encodeURIComponent('noisy@example.com')}&kinds=order`,
    );
    expect(JSON.parse(response.body).timeline).toHaveLength(1);
  });

  it('rejects an unparseable before cursor', async () => {
    await authed('POST', '/v1/contacts', { email: 'x@example.com' });
    const response = await authed(
      'GET',
      `/v1/contacts/timeline?email=${encodeURIComponent('x@example.com')}&before=yesterday`,
    );
    expect(response.statusCode).toBe(400);
  });
});
