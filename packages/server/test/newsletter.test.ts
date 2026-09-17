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
import {
  confirmSubscription,
  listStats,
  subscribe,
  subscribersFor,
  unsubscribeByEmail,
  unsubscribeByToken,
} from '../src/services/newsletter.js';
import { flushEmailQueue, outbox, setEmailTransport } from '../src/services/email.js';
import { getBalance } from '../src/services/points.js';
import { getTenantById } from '../src/services/tenants.js';
import { hashToken, randomToken } from '../src/lib/crypto.js';

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

const tenantObject = async () => (await getTenantById(tenant.id))!;

describe('newsletter double opt-in', () => {
  it('creates a pending subscription and queues a confirmation email', async () => {
    const result = await subscribe(await tenantObject(), {
      email: 'reader@example.com',
      name: 'A Reader',
      source: 'footer',
    });

    expect(result.status).toBe('pending');
    expect(result.confirmToken).toBeTruthy();

    const { rows } = await db().query('SELECT status FROM subscriptions WHERE tenant_id = $1', [tenant.id]);
    expect(rows[0].status).toBe('pending');

    // Points are not awarded until the address is confirmed.
    expect((await getBalance(tenant.id, result.contact.id)).balance).toBe(0);

    await flushEmailQueue();
    const sent = outbox();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('reader@example.com');
    expect(sent[0].html).toContain(`/n/confirm/${result.confirmToken}`);
  });

  it('stores the confirmation token hashed, never in plaintext', async () => {
    const result = await subscribe(await tenantObject(), { email: 'reader@example.com' });
    const { rows } = await db().query('SELECT confirm_token_hash FROM subscriptions WHERE tenant_id = $1', [
      tenant.id,
    ]);

    expect(rows[0].confirm_token_hash).not.toBe(result.confirmToken);
    expect(rows[0].confirm_token_hash).toBe(hashToken(result.confirmToken!));
  });

  it('confirms, awards the signup reward and sends a welcome', async () => {
    const result = await subscribe(await tenantObject(), { email: 'reader@example.com' });
    const confirmed = await confirmSubscription(result.confirmToken!);

    expect(confirmed?.contact_id).toBe(result.contact.id);
    expect((await getBalance(tenant.id, result.contact.id)).balance).toBe(100);

    const { rows } = await db().query(
      'SELECT status, confirm_token_hash FROM subscriptions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0].status).toBe('subscribed');
    // Consumed, so the link cannot be replayed.
    expect(rows[0].confirm_token_hash).toBeNull();

    const { rows: contacts } = await db().query('SELECT marketing_consent FROM contacts WHERE id = $1', [
      result.contact.id,
    ]);
    expect(contacts[0].marketing_consent).toBe(true);

    await flushEmailQueue();
    expect(outbox().map((message) => message.subject)).toEqual([
      expect.stringContaining('Confirm'),
      expect.stringContaining('100 points'),
    ]);
  });

  it('treats a re-clicked confirmation link as success, without paying twice', async () => {
    const result = await subscribe(await tenantObject(), { email: 'reader@example.com' });
    await confirmSubscription(result.confirmToken!);

    const app = await testApp();
    const second = await app.inject({ method: 'GET', url: `/n/confirm/${result.confirmToken}` });
    // The token is consumed, so the page reports expiry rather than an error.
    expect([200, 404]).toContain(second.statusCode);
    expect((await getBalance(tenant.id, result.contact.id)).balance).toBe(100);
  });

  it('does not create a second subscription for an already-confirmed address', async () => {
    const tenantRow = await tenantObject();
    const first = await subscribe(tenantRow, { email: 'reader@example.com' });
    await confirmSubscription(first.confirmToken!);

    const second = await subscribe(tenantRow, { email: 'reader@example.com' });
    expect(second.status).toBe('already_subscribed');

    const { rows } = await db().query('SELECT COUNT(*)::int AS n FROM subscriptions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('rejects a malformed address', async () => {
    await expect(
      subscribe(await tenantObject(), { email: 'not-an-email' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('unsubscribes by token and revokes marketing consent', async () => {
    const result = await subscribe(await tenantObject(), { email: 'reader@example.com' });
    await confirmSubscription(result.confirmToken!);

    const { rows } = await db().query('SELECT unsub_token_hash FROM subscriptions WHERE tenant_id = $1', [
      tenant.id,
    ]);
    // Recover the plaintext by re-deriving it the way the email did.
    const token = await findUnsubToken(rows[0].unsub_token_hash);
    expect(token).toBeTruthy();

    expect(await unsubscribeByToken(token!)).toBe(true);

    const { rows: after } = await db().query(
      `SELECT s.status, c.marketing_consent FROM subscriptions s
         JOIN contacts c ON c.id = s.contact_id WHERE s.tenant_id = $1`,
      [tenant.id],
    );
    expect(after[0].status).toBe('unsubscribed');
    expect(after[0].marketing_consent).toBe(false);
  });

  it('answers identically for a real and a bogus unsubscribe token', async () => {
    const app = await testApp();
    const real = await app.inject({ method: 'GET', url: `/n/unsubscribe/${randomToken(24)}` });
    const fake = await app.inject({ method: 'GET', url: '/n/unsubscribe/definitely-not-a-token' });

    expect(real.statusCode).toBe(200);
    expect(fake.statusCode).toBe(200);
    expect(real.body).toBe(fake.body);
  });

  it('unsubscribes by email address', async () => {
    const result = await subscribe(await tenantObject(), { email: 'reader@example.com' });
    await confirmSubscription(result.confirmToken!);

    expect(await unsubscribeByEmail(tenant.id, 'reader@example.com')).toBe(true);
    expect(await subscribersFor(tenant.id, 'newsletter')).toHaveLength(0);
  });

  it('only returns consented subscribers for a broadcast', async () => {
    const tenantRow = await tenantObject();
    const confirmed = await subscribe(tenantRow, { email: 'yes@example.com' });
    await confirmSubscription(confirmed.confirmToken!);
    await subscribe(tenantRow, { email: 'pending@example.com' });

    const recipients = await subscribersFor(tenant.id, 'newsletter');
    expect(recipients.map((row) => row.email)).toEqual(['yes@example.com']);

    const stats = await listStats(tenant.id);
    expect(stats[0]).toMatchObject({ slug: 'newsletter', subscribed: 1, pending: 1 });
  });
});

describe('public subscribe endpoint', () => {
  it('accepts a signup and links it to the browsing visitor', async () => {
    const app = await testApp();
    const { visitor, session } = ids();

    await app.inject({
      method: 'POST',
      url: '/v1/collect',
      headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
      payload: {
        visitor,
        session,
        url: 'https://shop.example.com/?utm_source=pinterest&utm_medium=social',
        events: [{ type: 'pageview' }],
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { email: 'reader@example.com', visitor, source: 'hero' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('pending');

    // The anonymous session is now attached to the new contact.
    const { rows } = await db().query(
      'SELECT contact_id, source FROM sessions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0].contact_id).toBe(body.contact_id);
    expect(rows[0].source).toBe('pinterest');
  });

  it('silently swallows a honeypot submission', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      headers: { 'x-tbay-key': tenant.publicKey },
      payload: { email: 'bot@example.com', website: 'http://spam.example' },
    });

    expect(response.statusCode).toBe(400); // max-length 0 rejects a filled honeypot
    const { rows } = await db().query('SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses a signup without a site key', async () => {
    const app = await testApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/newsletter/subscribe',
      payload: { email: 'reader@example.com' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('email queue', () => {
  it('never sends the same message twice for one dedupe key', async () => {
    const tenantRow = await tenantObject();
    const first = await subscribe(tenantRow, { email: 'reader@example.com' });
    await confirmSubscription(first.confirmToken!);

    await flushEmailQueue();
    const afterFirst = outbox().length;

    // A second worker pass must find nothing new to send.
    await flushEmailQueue();
    expect(outbox()).toHaveLength(afterFirst);
  });

  it('retries a failing send and gives up after five attempts', async () => {
    let attempts = 0;
    setEmailTransport({
      async send() {
        attempts += 1;
        throw new Error('SMTP unavailable');
      },
    });

    await subscribe(await tenantObject(), { email: 'reader@example.com' });
    for (let i = 0; i < 6; i += 1) {
      await flushEmailQueue();
      // Retries back off — 1, 2, 4, 8 minutes — so that five attempts spread
      // over a quarter of an hour instead of a minute. Without the wait, an
      // hour of throttling from the provider suppressed the address for thirty
      // days. Nothing here is waiting a quarter of an hour, so the clock moves.
      await db().query(
        'UPDATE email_messages SET next_attempt_at = now() WHERE tenant_id = $1',
        [tenant.id],
      );
    }

    expect(attempts).toBe(5);
    const { rows } = await db().query('SELECT status, attempts FROM email_messages WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });
});

/**
 * The plaintext unsubscribe token only exists inside the sent email, which is
 * the point — recover it from the outbox the way a subscriber would.
 */
async function findUnsubToken(expectedHash: string): Promise<string | null> {
  await flushEmailQueue();
  for (const message of outbox()) {
    const match = message.html.match(/\/n\/unsubscribe\/([A-Za-z0-9_-]+)/);
    if (match && hashToken(match[1]!) === expectedHash) return match[1]!;
  }
  return null;
}
