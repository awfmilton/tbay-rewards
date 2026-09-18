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
  ensureList,
  unsubscribeByToken,
} from '../src/services/newsletter.js';
import { flushEmailQueue, outbox, setEmailTransport } from '../src/services/email.js';
import { isSuppressed, suppress } from '../src/services/deliverability.js';
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

describe('leaving and coming back (HIGH)', () => {
  it('does not unsubscribe somebody because a link scanner opened their mail', async () => {
    // sendConfirmationEmail puts /n/unsubscribe/<token> in the double opt-in
    // email, and that route acted on a bare GET. Every corporate mail gateway
    // that matters -- Outlook Safe Links, Proofpoint, Mimecast, Barracuda --
    // fetches every link in an inbound message to check it, so the scanner
    // unsubscribed the person before they had opened the mail, and the
    // Confirm button they then pressed put them on a list they were already
    // off.
    const result = await subscribe(await tenantObject(), { email: 'scanned@example.com' });
    const { rows } = await db().query<{ unsub_token_hash: string }>(
      'SELECT unsub_token_hash FROM subscriptions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.unsub_token_hash).toBeTruthy();

    await flushEmailQueue();
    const confirmationEmail = outbox().find((m) => m.to === 'scanned@example.com');
    expect(confirmationEmail).toBeDefined();
    const unsubUrl = /\/n\/unsubscribe\/([A-Za-z0-9._-]+)/.exec(confirmationEmail!.html)?.[1];
    expect(unsubUrl).toBeTruthy();

    const app = await testApp();

    // The scanner: a plain GET, which must ask rather than act.
    const scanned = await app.inject({ method: 'GET', url: `/n/unsubscribe/${unsubUrl}` });
    expect(scanned.statusCode).toBe(200);
    expect(scanned.body).toContain('<form method="post"');

    const afterScan = await db().query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(afterScan.rows[0]!.status).toBe('pending');

    // Confirming still works, because nothing was done behind their back.
    await confirmSubscription(result.confirmToken!);
    const afterConfirm = await db().query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(afterConfirm.rows[0]!.status).toBe('subscribed');

    // And a real one-click unsubscribe -- the POST a mail client sends
    // because somebody pressed its button -- still acts immediately. That is
    // what List-Unsubscribe-Post advertises and the law requires.
    const clicked = await app.inject({ method: 'POST', url: `/n/unsubscribe/${unsubUrl}` });
    expect(clicked.statusCode).toBe(200);
    const afterClick = await db().query<{ status: string }>(
      'SELECT status FROM subscriptions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(afterClick.rows[0]!.status).toBe('unsubscribed');
  });

  it('lets somebody who unsubscribed join again', async () => {
    // Unsubscribing from an email link writes a permanent `manual`
    // suppression, which is right -- the decision must survive a re-import or
    // a second subscription row. But it also blocked the double opt-in
    // confirmation, the one message that can put somebody back on, so anyone
    // who ever left could never return: the form accepted them, the
    // confirmation was suppressed at send time, and neither side was told.
    // Only a retailer with admin access could undo it.
    await suppress(tenant.id, 'returning@example.com', 'manual', 'Unsubscribed from an email link');
    expect(await isSuppressed(tenant.id, 'returning@example.com')).not.toBeNull();

    const again = await subscribe(await tenantObject(), { email: 'returning@example.com' });
    await flushEmailQueue();
    const confirmation = outbox().find((m) => m.to === 'returning@example.com');
    expect(confirmation).toBeDefined();

    // Confirming is what lifts it -- an unconfirmed address stays suppressed.
    expect(await isSuppressed(tenant.id, 'returning@example.com')).not.toBeNull();
    await confirmSubscription(again.confirmToken!);
    expect(await isSuppressed(tenant.id, 'returning@example.com')).toBeNull();

    // And the welcome mail that follows actually reaches them, rather than
    // landing in `suppressed` while the list row says subscribed.
    await flushEmailQueue();
    const { rows } = await db().query<{ status: string }>(
      `SELECT status FROM email_messages
        WHERE tenant_id = $1 AND to_email = 'returning@example.com'
        ORDER BY created_at`,
      [tenant.id],
    );
    expect(rows.every((r) => r.status !== 'suppressed')).toBe(true);
  });

  it('never lets a form submission undo a hard bounce or a complaint', async () => {
    // The narrowness is the point. A hard bounce is a fact about a mailbox
    // and a complaint is a statement of intent; neither is a decision a
    // signup form may reverse.
    for (const reason of ['hard_bounce', 'complaint'] as const) {
      const email = `${reason}@example.com`;
      await suppress(tenant.id, email, reason, 'from the relay');
      const joined = await subscribe(await tenantObject(), { email });
      await confirmSubscription(joined.confirmToken!);
      expect(await isSuppressed(tenant.id, email), reason).not.toBeNull();
    }
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

  it('retries a failing send and gives up after six attempts', async () => {
    let attempts = 0;
    setEmailTransport({
      async send() {
        attempts += 1;
        throw new Error('550 5.7.1 Message rejected by policy');
      },
    });

    await subscribe(await tenantObject(), { email: 'reader@example.com' });
    for (let i = 0; i < 8; i += 1) {
      await flushEmailQueue();
      // Retries back off — 5m, 15m, 1h, 4h, 12h — so the six attempts spread
      // over most of a day rather than a quarter of an hour. Without that, an
      // afternoon of throttling from the provider suppressed the address for
      // thirty days. Nothing here waits, so the clock moves instead.
      await db().query(
        'UPDATE email_messages SET next_attempt_at = now() WHERE tenant_id = $1',
        [tenant.id],
      );
    }

    expect(attempts).toBe(6);
    const { rows } = await db().query('SELECT status, attempts FROM email_messages WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 6 });
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

describe('a form cannot answer for somebody who said no (MEDIUM)', () => {
  /**
   * On a single-opt-in list, subscribing granted consent outright. The form is
   * in the page source and takes an address, so anyone could undo an
   * unsubscribe that the person had made deliberately -- and rewrite the
   * consent provenance with whatever `source` they typed while doing it.
   */
  it('makes a returning unsubscriber confirm by email', async () => {
    const tenantRow = await tenantObject();

    // Single opt-in, which is where this bites: subscribing grants consent
    // outright, with nothing to click and nobody to check it was them.
    await subscribe(tenantRow, { email: 'seed@example.com' });
    await db().query('UPDATE lists SET double_optin = false WHERE tenant_id = $1', [tenant.id]);

    const first = await subscribe(tenantRow, { email: 'left@example.com' });
    expect(first.status).toBe('subscribed');

    const { rows: subs } = await db().query<{ unsub_token_hash: string }>(
      `SELECT s.unsub_token_hash FROM subscriptions s
         JOIN contacts c ON c.id = s.contact_id
        WHERE s.tenant_id = $1 AND c.email_normalised = 'left@example.com'`,
      [tenant.id],
    );
    await unsubscribeByToken((await findUnsubToken(subs[0]!.unsub_token_hash))!);

    expect(await consentOf('left@example.com')).toMatchObject({ marketing_consent: false });

    // Somebody types their address into the public form again.
    const again = await subscribe(
      tenantRow,
      { email: 'left@example.com', source: 'attacker_form' },
      undefined,
      { fillOnly: true },
    );

    // Not subscribed, not consented, and the provenance is untouched.
    expect(again.status).toBe('pending');
    const held = await consentOf('left@example.com');
    expect(held.marketing_consent).toBe(false);
    expect(held.consent_source).not.toBe('attacker_form');

    // They can still come back -- by clicking the link in their own inbox.
    expect(again.confirmToken).toBeTruthy();
    await confirmSubscription(again.confirmToken!);
    expect(await consentOf('left@example.com')).toMatchObject({ marketing_consent: true });
  });
});

async function consentOf(email: string) {
  const { rows } = await db().query<{ marketing_consent: boolean; consent_source: string | null }>(
    'SELECT marketing_consent, consent_source FROM contacts WHERE email_normalised = $1',
    [email],
  );
  return rows[0]!;
}

describe('a signup form never takes consent away (HIGH)', () => {
  /**
   * The guard that makes a returning unsubscriber confirm asked "has this
   * address ever unsubscribed from anything here", and its answer was passed
   * to upsertContact as `marketingConsent`. So a customer who left one list
   * and later used the on-site widget for a different list they were still
   * subscribed to had `false` written over a live `true`: unmailable account
   * wide, with the subscription row still reading `subscribed` and
   * `confirmed_at` set, so nothing looked wrong. Even the welcome email was
   * suppressed, for the consent that submission had just cleared.
   */
  it('leaves a live subscriber alone when they re-submit a form', async () => {
    const tenantRow = await tenantObject();

    // Two single-opt-in lists, created before anyone joins them, so joining
    // grants consent outright. (ensureList defaults to double opt-in, and a
    // list created by the first subscribe would make that subscribe pending.)
    await ensureList(tenant.id, 'deals');
    await ensureList(tenant.id, 'news');
    await db().query('UPDATE lists SET double_optin = false WHERE tenant_id = $1', [tenant.id]);

    await subscribe(tenantRow, { email: 'both@example.com', listSlug: 'deals' });
    await subscribe(tenantRow, { email: 'both@example.com', listSlug: 'news' });
    expect((await consentOf('both@example.com')).marketing_consent).toBe(true);

    // They leave one of the two, per list, the way the preference centre does
    // it -- account-level consent is untouched, because they still want the
    // other list. (unsubscribeByToken is the account-level exit and clears
    // consent by design; that is not this case.)
    await db().query(
      `UPDATE subscriptions SET status = 'unsubscribed', unsubscribed_at = now()
        WHERE id IN (
          SELECT s.id FROM subscriptions s
            JOIN lists l ON l.id = s.list_id
            JOIN contacts c ON c.id = s.contact_id
           WHERE l.slug = 'deals' AND c.email_normalised = 'both@example.com'
        )`,
      [],
    );

    const afterLeaving = await consentOf('both@example.com');
    // Still mailable: they left a list, not the shop.
    expect(afterLeaving.marketing_consent).toBe(true);

    // Now they re-submit the form for the list they never left. Server side,
    // which is how the WordPress plugin posts a form: `fillOnly` is the public
    // site key's restriction, and it happens to protect consent, so the damage
    // only showed on the path a retailer's own integration uses.
    const again = await subscribe(tenantRow, { email: 'both@example.com', listSlug: 'news' });

    const held = await consentOf('both@example.com');
    expect(held.marketing_consent).toBe(afterLeaving.marketing_consent);
    expect(again.status).not.toBe('pending');

    // And the list they did leave is still left.
    const { rows } = await db().query<{ slug: string; status: string }>(
      `SELECT l.slug, s.status FROM subscriptions s
         JOIN lists l ON l.id = s.list_id
         JOIN contacts c ON c.id = s.contact_id
        WHERE c.email_normalised = 'both@example.com' ORDER BY l.slug`,
      [],
    );
    expect(rows.map((row) => [row.slug, row.status])).toEqual([
      ['deals', 'unsubscribed'],
      ['news', 'subscribed'],
    ]);
  });
});
