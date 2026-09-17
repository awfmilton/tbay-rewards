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
import { upsertContact } from '../src/services/contacts.js';
import { award, getBalance, spend } from '../src/services/points.js';
import { recordOrder } from '../src/services/commissions.js';
import { getTenantById } from '../src/services/tenants.js';
import {
  eraseContact,
  exportContact,
  getRetentionPolicy,
  isErased,
  runRetentionSweep,
  setRetentionPolicy,
} from '../src/services/privacy.js';
import { upsertPointType } from '../src/services/point-types.js';
import { flushEmailQueue, outbox, queueEmail, setEmailTransport } from '../src/services/email.js';
import { unsubscribeRequestUrl } from '../src/services/newsletter.js';
import { preferencesUrl } from '../src/services/preferences.js';
import { suppress } from '../src/services/deliverability.js';

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

const authed = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

/** A member with history across most of the schema. */
async function seedMember(email = 'erase-me@example.com') {
  const contact = await upsertContact(tenant.id, {
    email,
    name: 'Erase Me',
    phone: '+1 807 555 0100',
    externalRef: 'wp-77',
    attributes: { plan: 'gold' },
    tags: ['vip'],
    marketingConsent: true,
  });

  const tenantRow = (await getTenantById(tenant.id))!;
  await recordOrder(tenantRow, {
    orderRef: `order-${Date.now()}`,
    totalCents: 12_000,
    contactId: contact.id,
  });

  await db().query(
    `INSERT INTO notifications (tenant_id, contact_id, type, title, body)
     VALUES ($1, $2, 'test', 'Hello Erase Me', 'Your points are ready')`,
    [tenant.id, contact.id],
  );

  await db().query(
    `INSERT INTO email_messages (
       tenant_id, contact_id, template_key, to_email, subject, html, text, status, dedupe_key
     ) VALUES ($1, $2, 'welcome', $3, 'Welcome, Erase Me', '<p>Hi Erase Me</p>', 'Hi Erase Me', 'sent', $4)`,
    [tenant.id, contact.id, email, `welcome:${contact.id}`],
  );

  return contact;
}

describe('erasure keeps the retailer’s books', () => {
  it('leaves nothing that re-links the erased record to the address', async () => {
    // `members` links one person's contacts across every retailer on the
    // platform, keyed by a hash of their address. Stripping the contact row
    // and leaving that intact meant hashing the address again found the row
    // pointing straight back at the contact that was supposed to be forgotten.
    const contact = (await upsertContact(tenant.id, { email: 'relink@example.com' })).id;
    const before = await db().query<{ member_id: string | null }>(
      'SELECT member_id FROM contacts WHERE id = $1',
      [contact],
    );
    const memberId = before.rows[0]!.member_id;
    expect(memberId).not.toBeNull();

    await eraseContact(tenant.id, contact, { reason: 'request' });

    const after = await db().query<{ member_id: string | null }>(
      'SELECT member_id FROM contacts WHERE id = $1',
      [contact],
    );
    expect(after.rows[0]!.member_id).toBeNull();

    const { rows: member } = await db().query<{ email_hash: string | null; wallet_address: string | null }>(
      'SELECT email_hash, wallet_address FROM members WHERE id = $1',
      [memberId],
    );
    // This was their only contact, so the identifiers go with it.
    expect(member[0]!.email_hash).toBeNull();
    expect(member[0]!.wallet_address).toBeNull();
  });

  it('takes the address out of the audit log too', async () => {
    // The audit log records who did what, and its target is the address an
    // operator typed — including on the erase request itself.
    const contact = (await upsertContact(tenant.id, { email: 'audited@example.com' })).id;
    await db().query(
      `INSERT INTO audit_log (tenant_id, action, status, target)
       VALUES ($1, 'POST /v1/privacy/erase', 200, 'audited@example.com')`,
      [tenant.id],
    );

    await eraseContact(tenant.id, contact, { reason: 'request' });

    const { rows } = await db().query<{ target: string }>(
      'SELECT target FROM audit_log WHERE tenant_id = $1',
      [tenant.id],
    );
    for (const row of rows) {
      expect(row.target).not.toContain('audited@example.com');
    }
    expect(rows.some((row) => row.target.startsWith('erased:'))).toBe(true);
  });

  it('strips every identifier while the ledger survives', async () => {
    const contact = await seedMember();
    const before = await db().query(
      'SELECT COUNT(*)::int AS n FROM points_ledger WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(before.rows[0]!.n).toBeGreaterThan(0);

    const result = await eraseContact(tenant.id, contact.id, { reason: 'request' });

    const { rows } = await db().query(
      'SELECT * FROM contacts WHERE tenant_id = $1 AND id = $2',
      [tenant.id, contact.id],
    );
    const row = rows[0]!;
    expect(row.email).toBeNull();
    expect(row.email_normalised).toBeNull();
    expect(row.name).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.external_ref).toBeNull();
    expect(row.attributes).toEqual({});
    expect(row.tags).toEqual([]);
    expect(row.marketing_consent).toBe(false);
    expect(row.erased_at).not.toBeNull();
    expect(row.erased_email_hash).toBeTruthy();
    // The hash is not the address.
    expect(row.erased_email_hash).not.toContain('@');

    // The retailer's financial record is intact: deleting it would be the
    // opposite of what most jurisdictions require.
    const after = await db().query(
      'SELECT COUNT(*)::int AS n FROM points_ledger WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(after.rows[0]!.n).toBeGreaterThanOrEqual(before.rows[0]!.n);

    const orders = await db().query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(orders.rows[0]!.n).toBe(1);

    expect(result.points_forfeited).toBeGreaterThan(0);
  });

  it('deletes the behavioural rows and the email body, keeping delivery metadata', async () => {
    const contact = await seedMember();
    await eraseContact(tenant.id, contact.id);

    const notifications = await db().query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(notifications.rows[0]!.n).toBe(0);

    const email = await db().query(
      'SELECT html, text, subject, to_email, status FROM email_messages WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, contact.id],
    );
    expect(email.rows[0]!.html).toBe('');
    expect(email.rows[0]!.text).toBeNull();
    expect(email.rows[0]!.subject).toBe('[erased]');
    expect(email.rows[0]!.to_email).toBe('');
    // Still knowable that something was sent, and whether it landed.
    expect(email.rows[0]!.status).toBe('sent');
  });

  it('zeroes every currency and says so in the ledger', async () => {
    await upsertPointType(tenant.id, { key: 'status', name: 'Status' });
    const contact = await seedMember('multi@example.com');
    await award(tenant.id, {
      contactId: contact.id,
      points: 300,
      reason: 'Status',
      idempotencyKey: 'erase-status',
      pointType: 'status',
    });

    await eraseContact(tenant.id, contact.id);

    expect((await getBalance(tenant.id, contact.id)).balance).toBe(0);
    expect((await getBalance(tenant.id, contact.id, undefined, 'status')).balance).toBe(0);

    const { rows } = await db().query(
      `SELECT point_type, delta_points, reason FROM points_ledger
        WHERE tenant_id = $1 AND contact_id = $2 AND ref_type = 'erasure'
        ORDER BY point_type`,
      [tenant.id, contact.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.reason === 'Balance forfeited on erasure')).toBe(true);
    expect(rows.every((row) => row.delta_points < 0)).toBe(true);
  });

  it('cancels a pending award so the release worker cannot credit an erased member', async () => {
    const contact = await upsertContact(tenant.id, { email: 'pending@example.com' });
    await award(tenant.id, {
      contactId: contact.id,
      points: 200,
      reason: 'On hold',
      idempotencyKey: 'erase-pending',
      holdSeconds: 3600,
    });
    expect((await getBalance(tenant.id, contact.id)).pending).toBe(200);

    await eraseContact(tenant.id, contact.id);

    const balance = await getBalance(tenant.id, contact.id);
    expect(balance.pending).toBe(0);
    expect(balance.balance).toBe(0);

    const { rows } = await db().query(
      `SELECT COUNT(*)::int AS n FROM points_ledger
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'pending'`,
      [tenant.id, contact.id],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('leaves a balance alone when the retailer says it will settle it', async () => {
    const contact = await seedMember('settle@example.com');
    const before = (await getBalance(tenant.id, contact.id)).balance;
    expect(before).toBeGreaterThan(0);

    const result = await eraseContact(tenant.id, contact.id, { forfeitPoints: false });
    expect(result.points_forfeited).toBe(0);
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(before);
  });

  it('refuses to erase the same person twice', async () => {
    const contact = await seedMember();
    await eraseContact(tenant.id, contact.id);
    await expect(eraseContact(tenant.id, contact.id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('records that the erasure happened, without recording who', async () => {
    const contact = await seedMember();
    await eraseContact(tenant.id, contact.id, { reason: 'request', requestedBy: 'ticket-4471' });

    const { rows } = await db().query('SELECT * FROM erasure_log WHERE tenant_id = $1', [tenant.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact_id).toBe(contact.id);
    expect(rows[0]!.reason).toBe('request');
    expect(rows[0]!.requested_by).toBe('ticket-4471');
    // The log itself must not become a copy of what was erased.
    expect(JSON.stringify(rows[0])).not.toContain('erase-me@example.com');
    expect(JSON.stringify(rows[0])).not.toContain('Erase Me');
  });
});

describe('an erased person stays erased', () => {
  it('refuses to re-add them by email', async () => {
    const contact = await seedMember('gone@example.com');
    await eraseContact(tenant.id, contact.id);

    await expect(
      upsertContact(tenant.id, { email: 'gone@example.com', name: 'Back Again' }),
    ).rejects.toMatchObject({ statusCode: 422 });

    const tenantRow = (await getTenantById(tenant.id))!;
    expect(await isErased(tenantRow, 'gone@example.com')).toBe(true);
    expect(await isErased(tenantRow, 'someone-else@example.com')).toBe(false);
  });

  it('refuses the public identify endpoint too', async () => {
    const contact = await seedMember('public-gone@example.com');
    await eraseContact(tenant.id, contact.id);

    const res = await (await testApp()).inject({
      method: 'POST',
      url: '/v1/identify',
      payload: { key: tenant.publicKey, email: 'public-gone@example.com' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('does not leak an erasure at one retailer to another', async () => {
    const other = await makeTenant();
    const contact = await seedMember('shared@example.com');
    await eraseContact(tenant.id, contact.id);

    // The same person is still a perfectly ordinary contact next door.
    const elsewhere = await upsertContact(other.id, { email: 'shared@example.com' });
    expect(elsewhere.id).toBeTruthy();

    const otherRow = (await getTenantById(other.id))!;
    expect(await isErased(otherRow, 'shared@example.com')).toBe(false);
  });
});

describe('subject access export', () => {
  it('returns what is held, across the schema', async () => {
    const contact = await seedMember('export@example.com');
    const data = await exportContact(tenant.id, contact.id);

    expect((data.contact as Record<string, unknown>).email).toBe('export@example.com');
    expect(Array.isArray(data.orders)).toBe(true);
    expect((data.orders as unknown[]).length).toBe(1);
    expect((data.points_ledger as unknown[]).length).toBeGreaterThan(0);
    // The order earns points and a first-purchase badge, each of which notifies.
    expect((data.notifications as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(data.counts).toBeTruthy();
  });

  it('is reachable over the API by email alone', async () => {
    await seedMember('api-export@example.com');
    const res = await authed('GET', '/v1/privacy/export?email=api-export@example.com');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).contact.email).toBe('api-export@example.com');
  });
});

describe('retention', () => {
  it('keeps everything until a retailer says otherwise', async () => {
    const policy = await getRetentionPolicy(tenant.id);
    expect(policy.event_days).toBeNull();
    expect(policy.session_days).toBeNull();

    const contact = await seedMember('keep@example.com');
    await db().query(
      `INSERT INTO events (tenant_id, contact_id, type, path, occurred_at)
       VALUES ($1, $2, 'custom', '/ancient', now() - interval '900 days')`,
      [tenant.id, contact.id],
    );

    await runRetentionSweep();
    const { rows } = await db().query(
      'SELECT COUNT(*)::int AS n FROM events WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('sweeps what is past the window and leaves what is inside it', async () => {
    const contact = await seedMember('sweep@example.com');
    await setRetentionPolicy(tenant.id, { event_days: 30, notification_days: 30 });

    await db().query(
      `INSERT INTO events (tenant_id, contact_id, type, path, occurred_at)
       VALUES ($1, $2, 'custom', '/old',   now() - interval '90 days'),
              ($1, $2, 'custom', '/fresh', now() - interval '2 days')`,
      [tenant.id, contact.id],
    );

    const swept = await runRetentionSweep();
    expect(swept.events).toBeGreaterThan(0);

    const { rows } = await db().query(
      'SELECT path FROM events WHERE tenant_id = $1 ORDER BY path',
      [tenant.id],
    );
    expect(rows.map((row) => row.path)).not.toContain('/old');
    expect(rows.map((row) => row.path)).toContain('/fresh');
  });

  it('clears an aged email body but keeps whether it was delivered', async () => {
    const contact = await seedMember('body@example.com');
    await db().query(
      `UPDATE email_messages SET created_at = now() - interval '400 days'
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );
    await setRetentionPolicy(tenant.id, { email_body_days: 90 });

    const swept = await runRetentionSweep();
    expect(swept.email_bodies).toBe(1);

    const { rows } = await db().query(
      'SELECT html, text, status, subject FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.html).toBe('');
    expect(rows[0]!.text).toBeNull();
    expect(rows[0]!.status).toBe('sent');
    // The subject is not a body; it stays so the history is still readable.
    expect(rows[0]!.subject).toBe('Welcome, Erase Me');
  });

  it('refuses a nonsensical window', async () => {
    await expect(setRetentionPolicy(tenant.id, { event_days: 0 })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(setRetentionPolicy(tenant.id, { event_days: 99_999 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('turns a window back off when a retailer clears it', async () => {
    await setRetentionPolicy(tenant.id, { event_days: 30 });
    expect((await getRetentionPolicy(tenant.id)).event_days).toBe(30);

    // Not COALESCE: null is how a retailer says "keep it after all".
    await setRetentionPolicy(tenant.id, { event_days: null });
    expect((await getRetentionPolicy(tenant.id)).event_days).toBeNull();
  });

  it('is settable over the API', async () => {
    const res = await authed('PUT', '/v1/privacy/retention', { eventDays: 45, sessionDays: 45 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).retention.event_days).toBe(45);

    const read = await authed('GET', '/v1/privacy/retention');
    expect(JSON.parse(read.body).retention.session_days).toBe(45);
  });
});

describe('erasure over the API', () => {
  it('erases, forfeits and logs in one call', async () => {
    await seedMember('api-erase@example.com');

    const res = await authed('POST', '/v1/privacy/erase', {
      email: 'api-erase@example.com',
      reason: 'request',
      requestedBy: 'ticket-9',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).points_forfeited).toBeGreaterThan(0);

    const log = await authed('GET', '/v1/privacy/erasures');
    expect(JSON.parse(log.body).erasures).toHaveLength(1);
  });

  it('will not reach another tenant’s contact', async () => {
    const other = await makeTenant();
    const theirs = await upsertContact(other.id, { email: 'theirs@example.com' });

    const res = await authed('POST', '/v1/privacy/erase', { contactId: theirs.id });
    expect(res.statusCode).toBe(404);

    const { rows } = await db().query('SELECT erased_at FROM contacts WHERE id = $1', [theirs.id]);
    expect(rows[0]!.erased_at).toBeNull();
  });

  it('spends the balance rather than deleting it, so the total still reconciles', async () => {
    const contact = await seedMember('reconcile@example.com');
    const before = (await getBalance(tenant.id, contact.id)).balance;

    await eraseContact(tenant.id, contact.id);

    // The balance is derivable from the ledger, before and after.
    const { rows } = await db().query(
      `SELECT COALESCE(SUM(delta_points), 0)::int AS total FROM points_ledger
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'cleared'`,
      [tenant.id, contact.id],
    );
    expect(rows[0]!.total).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it('does not let a forfeited balance be spent twice', async () => {
    const contact = await seedMember('double@example.com');
    await eraseContact(tenant.id, contact.id);

    await expect(
      spend(tenant.id, {
        contactId: contact.id,
        points: 1,
        reason: 'After erasure',
        idempotencyKey: 'after-erase',
      }),
    ).rejects.toThrow();
  });
});

describe('nothing identifying survives anywhere', () => {
  /**
   * The strongest test here, and the one that catches a table nobody thought
   * of: after erasing, sweep every text and jsonb column in the schema looking
   * for the address or the name. A table added next year that quietly stores a
   * contact's email fails this without anyone having to remember it exists.
   */
  it('finds no trace of the address, the name or the wallet in any table', async () => {
    const email = 'needle-in-haystack@example.com';
    const name = 'Zebediah Haystack';
    // A wallet is the strongest identifier in the schema -- a public chain
    // address, permanent, and tied to everything ever done with it. The sweep
    // searched for the email and the name only, and no fixture in it had a
    // wallet, so four surviving copies went unnoticed for three rounds. The
    // fixture also sets a phone and an external ref; those are searched for
    // now too, rather than being set and ignored.
    const wallet = '0x00000000000000000000000000000000DeaDBeef';

    const contact = await upsertContact(tenant.id, {
      email,
      name,
      phone: '+1 807 555 0199',
      externalRef: 'ext-needle',
      attributes: { nickname: name },
      tags: ['needle'],
      marketingConsent: true,
    });

    const tenantRow = (await getTenantById(tenant.id))!;
    await recordOrder(tenantRow, {
      orderRef: 'needle-order',
      totalCents: 8_000,
      contactId: contact.id,
      email,
      name,
    });
    await db().query(
      `INSERT INTO notifications (tenant_id, contact_id, type, title, body)
       VALUES ($1, $2, 'test', $3, $4)`,
      [tenant.id, contact.id, `Hello ${name}`, `We have your address, ${email}`],
    );
    await db().query(
      `INSERT INTO email_messages (
         tenant_id, contact_id, template_key, to_email, subject, html, status, dedupe_key
       ) VALUES ($1, $2, 'welcome', $3, $4, $5, 'sent', 'needle')`,
      [tenant.id, contact.id, email, `Welcome ${name}`, `<p>Hi ${name} at ${email}</p>`],
    );

    await db().query(
      'UPDATE contacts SET wallet_address = lower($2) WHERE tenant_id = $1 AND id = $3',
      [tenant.id, wallet, contact.id],
    );
    await db().query(
      `INSERT INTO token_claims (
         tenant_id, contact_id, member_id, wallet_address, contract_address,
         points_spent, token_amount_wei, chain_id, nonce, signature, status,
         expires_at, supply_mode
       )
       SELECT $1, $2, c.member_id, lower($3), '0x74eb73aca939fc911f79d9589e808f0207684d09',
              100, 1, 300, '1', '0x1', 'signed', now() + interval '1 day', 'mint'
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, wallet],
    );

    // A real bounce, because a bounce quotes the address it bounced and the
    // suppression stores that quote. Without this the sweep never touched the
    // one table that legitimately keeps the address, so its own invariant
    // ("no trace anywhere") read as true when it was not.
    await suppress(
      tenant.id,
      email,
      'hard_bounce',
      `550 5.1.1 <${email}>: User unknown in local recipient table`,
    );

    await eraseContact(tenant.id, contact.id);

    // Every text-ish column in the public schema, excluding the migration
    // bookkeeping table.
    const { rows: columns } = await db().query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name <> 'schema_migrations'
          AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')`,
    );

    const hits: string[] = [];
    for (const column of columns) {
      const { rows } = await db().query(
        `SELECT 1 FROM "${column.table_name}"
          WHERE "${column.column_name}"::text ILIKE $1
             OR "${column.column_name}"::text ILIKE $2
             OR "${column.column_name}"::text ILIKE $3
             OR "${column.column_name}"::text ILIKE $4
             OR "${column.column_name}"::text ILIKE $5
          LIMIT 1`,
        [`%${email}%`, `%${name}%`, `%${wallet}%`, '%+1 807 555 0199%', '%ext-needle%'],
      );
      if (rows.length > 0) hits.push(`${column.table_name}.${column.column_name}`);
    }

    // email_suppressions.email is kept on purpose and documented: a
    // suppression nobody can match is not a suppression. Its `detail` is not
    // part of that bargain and is cleared, because a bounce quotes the
    // address it bounced.
    expect(hits).toEqual(['email_suppressions.email']);
  });
});

describe('an erased person reads as erased', () => {
  it('says so on the timeline payload the admin screens render from', async () => {
    const contact = await seedMember('timeline-erased@example.com');

    const before = JSON.parse(
      (await authed('GET', `/v1/contacts/timeline?contactId=${contact.id}`)).body,
    );
    expect(before.contact.erased_at).toBeNull();

    await eraseContact(tenant.id, contact.id);

    // Without this the wp-admin customer screen offers "Erase this person" on
    // somebody already erased — safe, because the API refuses, but wrong.
    const after = JSON.parse(
      (await authed('GET', `/v1/contacts/timeline?contactId=${contact.id}`)).body,
    );
    expect(after.contact.erased_at).not.toBeNull();
    expect(after.contact.email).toBeNull();
  });
});

describe('retention deletes what the policy names, and no more', () => {
  it('does not take events with a session when events are kept forever', async () => {
    // `events.session_id` cascades. Deleting a session by the session policy
    // took its events too, whatever the event policy said — so "keep events
    // forever, keep sessions thirty days" quietly destroyed the events.
    const { runRetentionSweep } = await import('../src/services/privacy.js');

    await authed('PUT', '/v1/privacy/retention', { sessionDays: 30, eventDays: null });

    const { rows: visitor } = await db().query<{ id: string }>(
      `INSERT INTO visitors (tenant_id, anon_id) VALUES ($1, gen_random_uuid()::text)
       RETURNING id`,
      [tenant.id],
    );
    const { rows: session } = await db().query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, visitor_id, client_session_id, started_at, last_event_at)
       VALUES ($1, $2, 'cs-keep', now() - interval '90 days',
               now() - interval '90 days')
       RETURNING id`,
      [tenant.id, visitor[0]!.id],
    );
    await db().query(
      `INSERT INTO events (tenant_id, session_id, type, occurred_at)
       VALUES ($1, $2, 'pageview', now() - interval '90 days')`,
      [tenant.id, session[0]!.id],
    );

    await runRetentionSweep();

    const { rows: left } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM events WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(left[0]!.n)).toBe(1);
  });

  it('still sweeps a session that has no events to protect (MEDIUM)', async () => {
    // Guarding the events turned into guarding everything: the leg was gated
    // on an event policy existing at all, so a retailer who set sessions to
    // thirty days and left events alone deleted nothing -- not even sessions
    // with nothing in them to lose. The sweep reported no numbers either, so
    // it looked like there was simply nothing to do.
    const { runRetentionSweep } = await import('../src/services/privacy.js');
    await authed('PUT', '/v1/privacy/retention', { sessionDays: 1, eventDays: null });

    const { rows: visitor } = await db().query<{ id: string }>(
      `INSERT INTO visitors (tenant_id, anon_id) VALUES ($1, gen_random_uuid()::text)
       RETURNING id`,
      [tenant.id],
    );
    // One empty session, and one that still holds an event we are keeping.
    await db().query(
      `INSERT INTO sessions (tenant_id, visitor_id, client_session_id, started_at, last_event_at)
       VALUES ($1, $2, 'cs-empty', now() - interval '90 days', now() - interval '90 days')`,
      [tenant.id, visitor[0]!.id],
    );
    const { rows: withEvent } = await db().query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, visitor_id, client_session_id, started_at, last_event_at)
       VALUES ($1, $2, 'cs-full', now() - interval '90 days', now() - interval '90 days')
       RETURNING id`,
      [tenant.id, visitor[0]!.id],
    );
    await db().query(
      `INSERT INTO events (tenant_id, session_id, type, occurred_at)
       VALUES ($1, $2, 'pageview', now() - interval '90 days')`,
      [tenant.id, withEvent[0]!.id],
    );

    const swept = await runRetentionSweep();

    expect(swept.sessions).toBe(1);
    const { rows: left } = await db().query<{ client_session_id: string }>(
      'SELECT client_session_id FROM sessions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(left.map((row) => row.client_session_id)).toEqual(['cs-full']);
    // And the event it was protecting is still there.
    const { rows: events } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM events WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(events[0]!.n)).toBe(1);
  });

  it('removes the session once its events are out of retention too', async () => {
    const { runRetentionSweep } = await import('../src/services/privacy.js');
    await authed('PUT', '/v1/privacy/retention', { sessionDays: 30, eventDays: 30 });

    const { rows: visitor } = await db().query<{ id: string }>(
      `INSERT INTO visitors (tenant_id, anon_id) VALUES ($1, gen_random_uuid()::text)
       RETURNING id`,
      [tenant.id],
    );
    const { rows: session } = await db().query<{ id: string }>(
      `INSERT INTO sessions (tenant_id, visitor_id, client_session_id, started_at, last_event_at)
       VALUES ($1, $2, 'cs-sweep', now() - interval '90 days',
               now() - interval '90 days')
       RETURNING id`,
      [tenant.id, visitor[0]!.id],
    );
    await db().query(
      `INSERT INTO events (tenant_id, session_id, type, occurred_at)
       VALUES ($1, $2, 'pageview', now() - interval '90 days')`,
      [tenant.id, session[0]!.id],
    );

    await runRetentionSweep();

    const { rows: left } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM sessions WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(left[0]!.n)).toBe(0);
  });
});

describe('an erased address does not survive in a click-tracked link (HIGH)', () => {
  /**
   * The sweep above searches for the address in plaintext, which is exactly
   * why this got past it. Every marketing body carries {{unsubscribe_url}} and
   * {{preferences_url}}; the click tracker rewrote both because the exclusion
   * list named `/n/confirm` and `/n/unsubscribe` while the real routes are
   * `/n/u/` and `/n/prefs/`; and the token in each is base64url JSON with the
   * address inside it. So `email_messages.tracked_links` held the erased
   * person's address, keyed by their contact id, decodable by anyone with the
   * row and no key at all.
   */
  it('never wraps a consent link in the first place', async () => {
    const contact = await upsertContact(tenant.id, {
      email: 'tracked@example.com',
      marketingConsent: true,
    });

    const unsubscribeUrl = unsubscribeRequestUrl(tenant.id, 'tracked@example.com');
    const preferenceUrl = preferencesUrl(tenant.id, 'tracked@example.com');
    await queueEmail({
      tenantId: tenant.id,
      contactId: contact.id,
      templateKey: 'promo',
      to: 'tracked@example.com',
      subject: 'Sale',
      html: `<p><a href="https://shop.example/sale">Shop</a>
             <a href="${unsubscribeUrl}">Unsubscribe</a>
             <a href="${preferenceUrl}">Preferences</a></p>`,
      dedupeKey: 'tracked-1',
      track: true,
      unsubscribeUrl,
    });

    const { rows } = await db().query<{ tracked_links: string[]; html: string }>(
      'SELECT tracked_links, html FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );

    // The shop link is tracked; neither consent link is.
    expect(rows[0]!.tracked_links).toEqual(['https://shop.example/sale']);
    // And the unsubscribe link in the body still points straight at us, so
    // one-click unsubscribe does not depend on the redirect service being up.
    expect(rows[0]!.html).toContain(unsubscribeUrl);
  });

  it('leaves nothing decodable behind after an erasure', async () => {
    const email = 'decodable@example.com';
    const contact = await upsertContact(tenant.id, { email, marketingConsent: true });

    // A message whose tracked links do carry tokens, as any older row would.
    await queueEmail({
      tenantId: tenant.id,
      contactId: contact.id,
      templateKey: 'promo',
      to: email,
      subject: 'Sale',
      html: '<p><a href="https://shop.example/sale">Shop</a></p>',
      dedupeKey: 'decodable-1',
      track: true,
      unsubscribeUrl: unsubscribeRequestUrl(tenant.id, email),
    });
    await db().query(
      `UPDATE email_messages
          SET tracked_links = $2::jsonb, status = 'sent'
        WHERE tenant_id = $1`,
      [
        tenant.id,
        JSON.stringify([
          'https://shop.example/sale',
          unsubscribeRequestUrl(tenant.id, email),
          preferencesUrl(tenant.id, email),
        ]),
      ],
    );

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ tracked_links: unknown; tracking_token: string | null }>(
      'SELECT tracked_links, tracking_token FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.tracked_links).toEqual([]);
    expect(rows[0]!.tracking_token).toBeNull();

    // Decode every base64url run left anywhere in the row, not just the
    // plaintext: hiding in an encoding is how this got past the sweep.
    const { rows: all } = await db().query<Record<string, unknown>>(
      'SELECT * FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    const blob = JSON.stringify(all);
    for (const candidate of blob.match(/[A-Za-z0-9_-]{16,}/g) ?? []) {
      let decoded = '';
      try {
        decoded = Buffer.from(candidate, 'base64url').toString('utf8');
      } catch {
        continue;
      }
      expect(decoded).not.toContain(email);
    }
  });

  it('does not hand the transport an erased recipient', async () => {
    // A message still queued when the erasure ran had its to_email blanked and
    // was left queued, so the next flush asked SMTP to deliver to "" -- which
    // answers "No recipients defined", retries, and writes a suppression row
    // keyed on the empty string.
    const contact = await upsertContact(tenant.id, { email: 'inflight@example.com' });
    await queueEmail({
      tenantId: tenant.id,
      contactId: contact.id,
      templateKey: 'receipt',
      to: 'inflight@example.com',
      subject: 'Your order',
      html: '<p>Thanks</p>',
      dedupeKey: 'inflight-erase',
    });

    await eraseContact(tenant.id, contact.id);

    setEmailTransport(null);
    outbox().length = 0;
    expect(await flushEmailQueue(50)).toBe(0);
    expect(outbox()).toHaveLength(0);

    const { rows } = await db().query<{ status: string; error: string | null }>(
      'SELECT status, error FROM email_messages WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows[0]!.status).toBe('suppressed');
    expect(rows[0]!.error).toBe('Contact erased');
  });
});

describe('the erase request does not log the address it erased (MEDIUM)', () => {
  it('records the contact id, not what the operator typed', async () => {
    // eraseContact rewrites audit targets inside its transaction, but this
    // request's own audit row is written by the onResponse hook afterwards --
    // so the one action guaranteed to mention the address was the one entry
    // the scrub could never reach.
    const email = 'audited@example.com';
    await authed('POST', '/v1/contacts', { email });
    await authed('POST', '/v1/privacy/erase', { email });

    // The audit row is written in an onResponse hook, which runs after the
    // response is delivered -- so it may not be there the instant inject()
    // resolves. Wait for it rather than assuming.
    let rows: Array<{ action: string; target: string | null }> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      rows = (
        await db().query<{ action: string; target: string | null }>(
          'SELECT action, target FROM audit_log WHERE tenant_id = $1',
          [tenant.id],
        )
      ).rows;
      if (rows.some((row) => row.action.includes('/v1/privacy/erase'))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.target ?? '').not.toContain(email);
    }
    expect(rows.some((row) => row.action.includes('/v1/privacy/erase'))).toBe(true);
  });
});

describe('erasure never destroys money in flight (HIGH)', () => {
  /**
   * Round four overwrote every address on the chain tables with the zero
   * address, unconditionally. That destroyed funds twice over: a pending spend
   * intent is settled by matching an on-chain transfer against the addresses
   * recorded here, so blanking them meant the customer had sent their TBAY,
   * the retailer had it, and the credit could never be issued -- and a
   * `burn_verified` withdrawal has its L2 tokens already burned, with an
   * operator about to send L1 tokens to `l1_recipient`, which had just been
   * repointed at the address bridge.ts uses as its burn address.
   */
  const WALLET = '0x14dc79964da2c08b23698b3d3cc7ca32193d9955';

  async function withSpendIntent(email: string, status: string) {
    const contact = await upsertContact(tenant.id, { email });
    await db().query(
      `INSERT INTO token_spend_intents (
         tenant_id, contact_id, member_id, token_amount_wei, from_address, to_address,
         chain_id, contract_address, credit_cents, currency, status, expires_at
       )
       SELECT $1, $2, c.member_id, 1, $3, $4, 300,
              '0x74eb73aca939fc911f79d9589e808f0207684d09', 100, 'USD', $5,
              now() + interval '1 day'
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, WALLET, '0x1111111111111111111111111111111111111111', status],
    );
    return contact;
  }

  it('refuses while a token spend is still pending', async () => {
    const contact = await withSpendIntent('spender@example.com', 'pending');

    await expect(eraseContact(tenant.id, contact.id)).rejects.toThrow(
      /checkout in progress/i,
    );

    // Nothing was touched, so the intent can still settle.
    const { rows } = await db().query<{ from_address: string; to_address: string }>(
      'SELECT from_address, to_address FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    expect(rows[0]!.from_address).toBe(WALLET);
    expect(rows[0]!.to_address).toBe('0x1111111111111111111111111111111111111111');
  });

  it('erases once the spend has settled, and leaves the retailer their own wallet', async () => {
    const contact = await withSpendIntent('settled@example.com', 'verified');

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{
      from_address: string; to_address: string; member_id: string | null;
    }>(
      'SELECT from_address, to_address, member_id FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    expect(rows[0]!.from_address).not.toBe(WALLET);
    expect(rows[0]!.member_id).toBeNull();
    // `to_address` is the retailer's payout wallet, not the erased person's
    // data. Blanking it protects nobody and costs the retailer their books.
    expect(rows[0]!.to_address).toBe('0x1111111111111111111111111111111111111111');
  });

  async function withWithdrawal(email: string, status: string) {
    const contact = await upsertContact(tenant.id, { email });
    await db().query(
      `INSERT INTO bridge_withdrawals (
         tenant_id, contact_id, member_id, from_address, l1_recipient,
         l2_amount_wei, l1_amount, dust_wei, burn_tx_hash, status, l2_chain_id, l1_chain_id
       )
       SELECT $1, $2, c.member_id, $3, $3, 1, 1, 0, $4, $5, 300, 1
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, WALLET, `0xburn-${status}`, status],
    );
    return contact;
  }

  it('leaves a burned withdrawal payable without leaving it linkable (HIGH)', async () => {
    // The worst moment to lose the recipient: the L2 tokens are gone and the
    // L1 payout has not happened yet.
    //
    // Three answers came before this one. Refusing the erasure named
    // operator-only routes a retailer cannot reach. Keeping the address and
    // nulling the links closed nothing, because the re-identification join
    // never used the links. Overwriting with a well-formed 0x...ff was worse
    // again: an operator reading the listing sees a valid-looking address and
    // can send an irreversible transfer into a hole, and with nothing left to
    // check against, recovering the recipient from the burn meant trusting
    // whichever transfer the node returned first.
    //
    // A commitment is what makes recovery safe: the chain supplies the
    // candidate, the digest decides whether it is the right one.
    const contact = await withWithdrawal('bridging@example.com', 'burn_verified');

    const result = await eraseContact(tenant.id, contact.id);
    expect(result.obligations_kept).toBe(1);

    const { rows } = await db().query<{
      l1_recipient: string; from_address: string; burn_tx_hash: string;
      member_id: string | null; contact_id: string | null; status: string;
    }>(
      `SELECT l1_recipient, from_address, burn_tx_hash, member_id, contact_id, status
         FROM bridge_withdrawals WHERE burn_tx_hash = $1`,
      ['0xburn-burn_verified'],
    );
    expect(rows[0]!.status).toBe('burn_verified');
    expect(rows[0]!.member_id).toBeNull();
    expect(rows[0]!.contact_id).toBeNull();
    // Not an address at all, so nobody can mistake it for one and pay it.
    expect(rows[0]!.l1_recipient).toMatch(/^erased:[0-9a-f-]{36}:[0-9a-f]{32}$/);
    expect(rows[0]!.from_address).toBe(rows[0]!.l1_recipient);

    const { recipientFor, BURN_ADDRESS } = await import('../src/services/bridge.js');
    const { setChainClient } = await import('../src/lib/chain.js');
    const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const chainOf = (transfers: unknown[]) => ({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => transfers as never,
    });
    const burn = (from: string, value: bigint) => ({
      from, to: BURN_ADDRESS, value, blockNumber: 1, confirmations: 3,
    });

    // A transaction carrying two burns pays the one the commitment names, not
    // the one the node happens to list first.
    setChainClient(chainOf([burn(OTHER, 5n), burn(WALLET, 1n)]));
    expect(await recipientFor(rows[0]!)).toEqual({ address: WALLET.toLowerCase(), verified: true });

    // A node that answers with somebody else's burn pays nobody.
    setChainClient(chainOf([burn(OTHER, 1n)]));
    expect(await recipientFor(rows[0]!)).toEqual({ address: null, reason: 'no_match' });

    // And a node that is down, broken or has pruned the receipt says so
    // rather than throwing a provider error out of a read-only route.
    setChainClient(null);
    expect(await recipientFor(rows[0]!)).toEqual({ address: null, reason: 'chain_unavailable' });
    setChainClient({
      ...chainOf([]),
      transfersInTx: async () => {
        throw new Error('SERVER_ERROR: bad response');
      },
    });
    expect(await recipientFor(rows[0]!)).toEqual({ address: null, reason: 'chain_error' });
    setChainClient(chainOf([]));
    expect(await recipientFor(rows[0]!)).toEqual({ address: null, reason: 'burn_not_found' });
    setChainClient(null);
  });

  it('does not leave the kept wallet joinable back to the person (HIGH)', async () => {
    // `members.wallet_address` is plaintext, unique and platform-wide, and it
    // is only cleared when the erased contact was that person's last one
    // anywhere. So a wallet kept on an unsettled row joined straight back to
    // their live, fully identified record at another retailer -- one join, one
    // row, name and email. That is verbatim the failure this file's own
    // comment says it closed, reopened by keeping the join key.
    const other = await makeTenant();
    const contact = await upsertContact(tenant.id, { email: 'linkable@example.com' });
    // The same person, still a customer at a different shop, wallet on file.
    const twin = await upsertContact(other.id, {
      email: 'linkable@example.com',
      name: 'Chris Doe',
    });
    await db().query('UPDATE members SET wallet_address = $2 WHERE id = $1', [
      (await db().query<{ member_id: string }>('SELECT member_id FROM contacts WHERE id = $1', [twin.id]))
        .rows[0]!.member_id,
      WALLET.toLowerCase(),
    ]);
    await db().query(
      `INSERT INTO bridge_withdrawals (
         tenant_id, contact_id, member_id, from_address, l1_recipient,
         l2_amount_wei, l1_amount, dust_wei, burn_tx_hash, status, l2_chain_id, l1_chain_id
       )
       SELECT $1, $2, c.member_id, $3, $3, 1, 1, 0, $4, 'burn_verified', 300, 1
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, WALLET, '0xburn-linkable'],
    );

    await eraseContact(tenant.id, contact.id);

    // The join, asserted. An earlier version of this test built exactly this
    // query into a variable and ended with `void relinked` -- it computed the
    // vulnerability and threw the answer away, so it passed while the row was
    // still one join from the person's name and email.
    const relinked = await db().query(
      `SELECT c.email, c.name FROM bridge_withdrawals w
         JOIN members m  ON m.wallet_address = w.from_address
         JOIN contacts c ON c.member_id = m.id AND c.erased_at IS NULL
        WHERE w.burn_tx_hash = $1 AND w.tenant_id = $2`,
      ['0xburn-linkable', tenant.id],
    );
    expect(relinked.rowCount).toBe(0);

    // Nor through the link columns.
    const kept = await db().query<{
      contact_id: string | null; member_id: string | null; l1_recipient: string;
    }>(
      'SELECT contact_id, member_id, l1_recipient FROM bridge_withdrawals WHERE burn_tx_hash = $1',
      ['0xburn-linkable'],
    );
    expect(kept.rows[0]!.contact_id).toBeNull();
    expect(kept.rows[0]!.member_id).toBeNull();
    expect(kept.rows[0]!.l1_recipient).not.toBe(WALLET.toLowerCase());
    expect(kept.rows[0]!.l1_recipient).toMatch(/^erased:/);

    // The control that makes this a fix rather than a deletion: the money is
    // still payable, because the burn transaction says who owned the tokens
    // and that is a public record. The wallet came out of the chain to begin
    // with; it goes back to the chain to be read.
    const { recipientFor, BURN_ADDRESS } = await import('../src/services/bridge.js');
    const { setChainClient } = await import('../src/lib/chain.js');
    setChainClient({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => [
        { from: WALLET, to: BURN_ADDRESS, value: 1n, blockNumber: 1, confirmations: 3 },
      ],
    });
    const withdrawal = await db().query<{ l1_recipient: string; burn_tx_hash: string }>(
      'SELECT l1_recipient, burn_tx_hash FROM bridge_withdrawals WHERE burn_tx_hash = $1',
      ['0xburn-linkable'],
    );
    expect(await recipientFor(withdrawal.rows[0]!)).toEqual({
      address: WALLET.toLowerCase(),
      verified: true,
    });
    setChainClient(null);
  });

  it('erases a released withdrawal, and not at the burn address', async () => {
    const { BURN_ADDRESS } = await import('../src/services/bridge.js');
    const contact = await withWithdrawal('bridged@example.com', 'released');

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ l1_recipient: string; from_address: string }>(
      'SELECT l1_recipient, from_address FROM bridge_withdrawals WHERE burn_tx_hash = $1',
      ['0xburn-released'],
    );
    expect(rows[0]!.from_address).not.toBe(WALLET);
    // The zero address means "burned" in this schema, so it is the one
    // sentinel that must not be used to mean "erased".
    expect(rows[0]!.l1_recipient).not.toBe(BURN_ADDRESS);
    expect(rows[0]!.from_address).not.toBe(BURN_ADDRESS);
  });

  it('keeps an unsettled intent settleable without keeping the wallet (HIGH)', async () => {
    // SPEND_TTL_MINUTES is sixty, so "expired" is the ordinary state of an
    // intent an hour after checkout -- including one where the customer really
    // did send their TBAY and the verification never landed. Scrubbing
    // `from_address` there destroys the only handle a hand-settlement has.
    //
    // But keeping the raw wallet was wrong too: it joins back to
    // `members.wallet_address` and to that person's live record at another
    // shop, and "while it could still be settled" was in practice forever,
    // because erasure is one-shot and nothing revisits the row.
    //
    // A keyed digest settles the question without answering it.
    const recent = await withSpendIntent('recently-lapsed@example.com', 'expired');
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '2 hours'
        WHERE contact_id = $1`,
      [recent.id],
    );
    await eraseContact(tenant.id, recent.id);
    const kept = await db().query<{ from_address: string; member_id: string | null }>(
      'SELECT from_address, member_id FROM token_spend_intents WHERE contact_id = $1',
      [recent.id],
    );
    expect(kept.rows[0]!.from_address).not.toBe(WALLET);
    expect(kept.rows[0]!.from_address).toMatch(/^erased:[0-9a-f]{32}$/);
    expect(kept.rows[0]!.member_id).toBeNull();

    // Nothing in the schema can be joined back to that wallet.
    const relinked = await db().query(
      `SELECT 1 FROM token_spend_intents i JOIN members m
              ON m.wallet_address = i.from_address
        WHERE i.contact_id = $1`,
      [recent.id],
    );
    expect(relinked.rowCount).toBe(0);

    // And the settlement the digest exists for still works: the retailer
    // matches an unexplained transfer at their payout wallet against it.
    const { verifySpendIntent } = await import('../src/services/token.js');
    const { setChainClient } = await import('../src/lib/chain.js');
    const { getTenantById } = await import('../src/services/tenants.js');
    const intentRow = await db().query<{ id: string; to_address: string; token_amount_wei: string }>(
      'SELECT id, to_address, token_amount_wei FROM token_spend_intents WHERE contact_id = $1',
      [recent.id],
    );
    setChainClient({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => [
        {
          from: WALLET,
          to: intentRow.rows[0]!.to_address,
          value: BigInt(intentRow.rows[0]!.token_amount_wei),
          blockNumber: 1,
          confirmations: 3,
        },
      ],
    });
    const settled = await verifySpendIntent(
      (await getTenantById(tenant.id))!,
      intentRow.rows[0]!.id,
      '0xsettled-after-erasure',
    );
    expect(settled.intent.status).toBe('verified');
    setChainClient(null);
  });

  it('digests a lapsed intent the worker has not relabelled yet (HIGH)', async () => {
    // The erasure's digest query named only the `expired` rows while
    // verifySpendIntent claims `pending` ones too, and everything the digest
    // query missed fell through to the outright scrub. A `pending` intent past
    // its expiry is exactly that gap -- still settleable, wiped anyway.
    //
    // Not a narrow race: nothing moves an intent out of `pending` except a
    // five-minute worker that does not run at all under RUN_WORKERS=false,
    // while the erasure refusal lifts the instant `expires_at` passes. A
    // retailer retrying the erasure until it stops saying "checkout in
    // progress" lands here almost every time, and the customer's TBAY is
    // already at the payout wallet.
    const contact = await withSpendIntent('lapsed-pending@example.com', 'pending');
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '2 minutes'
        WHERE contact_id = $1`,
      [contact.id],
    );

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ from_address: string }>(
      'SELECT from_address FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    // Digested, so it can still be settled -- not overwritten with the
    // sentinel, which no transfer can ever match.
    expect(rows[0]!.from_address).toMatch(/^erased:[0-9a-f]{32}$/);
  });

  it('does not key the digest with anything the database holds (HIGH)', async () => {
    // The digest was keyed with `tenants.pii_salt`, which is a column in the
    // same database as `members.wallet_address` -- a small table holding every
    // wallet the platform knows. So the adversary the digest exists for reads
    // the salt, hashes five thousand candidate wallets and matches it in a
    // tenth of a millisecond. There is no 160-bit space to search when the
    // answers are in the next table.
    const contact = await withSpendIntent('keyed@example.com', 'expired');
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '2 hours'
        WHERE contact_id = $1`,
      [contact.id],
    );
    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ from_address: string }>(
      'SELECT from_address FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    const stored = rows[0]!.from_address;
    expect(stored).toMatch(/^erased:[0-9a-f]{32}$/);

    // The property, not three guesses. Asserting inequality against a handful
    // of hand-picked candidates and then equality with the function under test
    // is circular: an unkeyed SHA-256 over the same input -- which anybody
    // holding the database or this repository can recompute for every wallet
    // in `members` -- passed it unchanged.
    //
    // What has to be true is that the digest depends on a secret. So: compute
    // it under a *different* key and under no key at all, over exactly the
    // input the real one uses, and require both to miss.
    const { createHash, createHmac } = await import('node:crypto');
    const input = `wallet:${tenant.id}:${WALLET.toLowerCase()}`;
    const unkeyed = createHash('sha256').update(input).digest('hex').slice(0, 32);
    const otherKey = createHmac('sha256', 'a-different-token-secret')
      .update(input)
      .digest('hex')
      .slice(0, 32);
    expect(stored).not.toBe(`erased:${unkeyed}`);
    expect(stored).not.toBe(`erased:${otherKey}`);

    // And nothing in the database reproduces it either.
    const { hashPii } = await import('../src/lib/crypto.js');
    const salted = await db().query<{ pii_salt: string }>(
      'SELECT pii_salt FROM tenants WHERE id = $1',
      [tenant.id],
    );
    for (const attempt of [
      hashPii(WALLET.toLowerCase(), salted.rows[0]!.pii_salt),
      hashPii(WALLET, salted.rows[0]!.pii_salt),
      hashPii(WALLET.toLowerCase(), tenant.id),
    ]) {
      expect(stored).not.toBe(`erased:${attempt}`);
    }

    // The control, computed here rather than borrowed: the real key does
    // reproduce it, which is what keeps a hand-settlement possible.
    const withRealKey = createHmac('sha256', process.env.TOKEN_SECRET!)
      .update(input)
      .digest('hex')
      .slice(0, 32);
    expect(stored).toBe(`erased:${withRealKey}`);
  });

  it('still settles an intent erased under the previous digest key (HIGH)', async () => {
    // Both digest forms are "erased:" plus thirty-two hex characters, and the
    // addresses are gone, so a row cannot be told apart or migrated. Without a
    // fallback comparison, deploying the key change made every
    // already-erased intent permanently unsettleable -- the customer's TBAY at
    // the retailer's payout wallet and no route able to issue the credit.
    const contact = await withSpendIntent('legacy-digest@example.com', 'expired');
    const { hashPii } = await import('../src/lib/crypto.js');
    const { getTenantById: loadTenant } = await import('../src/services/tenants.js');
    const salt = (await loadTenant(tenant.id))!.pii_salt;
    const legacy = `erased:${hashPii(WALLET.toLowerCase(), salt)}`;
    const intent = await db().query<{ id: string; to_address: string; token_amount_wei: string }>(
      `UPDATE token_spend_intents
          SET from_address = $2, expires_at = now() - interval '2 hours'
        WHERE contact_id = $1
        RETURNING id, to_address, token_amount_wei`,
      [contact.id, legacy],
    );

    const { verifySpendIntent } = await import('../src/services/token.js');
    const { setChainClient } = await import('../src/lib/chain.js');
    const { getTenantById } = await import('../src/services/tenants.js');
    setChainClient({
      isNonceUsed: async () => false,
      isPaused: async () => false,
      balanceOf: async () => 0n,
      transfersInTx: async () => [
        {
          from: WALLET,
          to: intent.rows[0]!.to_address,
          value: BigInt(intent.rows[0]!.token_amount_wei),
          blockNumber: 1,
          confirmations: 3,
        },
      ],
    });
    const settled = await verifySpendIntent(
      (await getTenantById(tenant.id))!,
      intent.rows[0]!.id,
      '0xlegacy-settlement',
    );
    expect(settled.intent.status).toBe('verified');
    setChainClient(null);
  });

  it('locks a lapsed intent against a verification claiming it mid-erasure (HIGH)', async () => {
    // FOR UPDATE locks what the WHERE clause matched, and the refusal named
    // only the *live* intents -- so the lapsed ones, which are exactly the
    // population the digest query covers, were unlocked. A verification
    // claiming one between the two statements flipped it to 'verifying', which
    // matched neither predicate, and it fell through to the sentinel scrub: a
    // row nothing can ever settle, with the customer's TBAY already at the
    // retailer's payout wallet.
    //
    // The erasure is parked on a row lock taken from another connection, so
    // the interleaving is deterministic rather than hoped for.
    const contact = await withSpendIntent('raced@example.com', 'expired');
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '2 hours'
        WHERE contact_id = $1`,
      [contact.id],
    );
    await db().query(
      `INSERT INTO token_claims (
         tenant_id, contact_id, wallet_address, points_spent, token_amount_wei,
         nonce, chain_id, contract_address, signature, status, expires_at
       ) VALUES ($1, $2, $3, 1, 1, 424242, 300,
                 '0x74eb73aca939fc911f79d9589e808f0207684d09', '0xsig', 'signed',
                 now() + interval '1 day')`,
      [tenant.id, contact.id, WALLET],
    );

    const blocker = await db().connect();
    let erasing: Promise<unknown>;
    try {
      await blocker.query('BEGIN');
      // The pool sets idle_in_transaction_session_timeout, which is right for
      // production and would kill this deliberately-parked transaction.
      await blocker.query('SET LOCAL idle_in_transaction_session_timeout = 0');
      // Hold the row the erasure reaches straight after its refusal.
      await blocker.query('SELECT 1 FROM token_claims WHERE contact_id = $1 FOR UPDATE', [
        contact.id,
      ]);

      erasing = eraseContact(tenant.id, contact.id).catch((err: Error) => err);
      // Let the erasure get as far as the lock.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Now try to claim the lapsed intent, exactly as verifySpendIntent does.
      // It must block on the erasure's lock rather than slipping past it.
      const claimer = await db().connect();
      try {
        // Session-level, not SET LOCAL: outside a transaction block SET LOCAL
        // does nothing, so the claimer waited forever and the test deadlocked
        // against its own parked blocker.
        await claimer.query("SET lock_timeout = '400ms'");
        await expect(
          claimer.query(
            `UPDATE token_spend_intents SET status = 'verifying'
              WHERE tenant_id = $1 AND contact_id = $2 AND status = 'expired'`,
            [tenant.id, contact.id],
          ),
        ).rejects.toThrow(/lock timeout|canceling statement/i);
      } finally {
        claimer.release();
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }

    await erasing;
    // And the erasure still finished correctly: digested, not scrubbed.
    const { rows } = await db().query<{ from_address: string }>(
      'SELECT from_address FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    expect(rows[0]!.from_address).toMatch(/^erased:/);
  }, 20_000);

  it('does not keep a wallet on an intent nobody can act on any more (HIGH)', async () => {
    // Past the window the digest is replaced outright, so there is not even a
    // keyed value left. Erasure is one-shot -- a second call is refused -- so
    // anything it leaves behind has to be final at the moment it runs.
    const ancient = await withSpendIntent('long-lapsed@example.com', 'expired');
    await db().query(
      `UPDATE token_spend_intents SET expires_at = now() - interval '400 days'
        WHERE contact_id = $1`,
      [ancient.id],
    );
    await eraseContact(tenant.id, ancient.id);
    const scrubbed = await db().query<{ from_address: string }>(
      'SELECT from_address FROM token_spend_intents WHERE contact_id = $1',
      [ancient.id],
    );
    expect(scrubbed.rows[0]!.from_address).not.toBe(WALLET);
    expect(scrubbed.rows[0]!.from_address).not.toMatch(/^erased:/);

    // A retailer who has settled it by hand says so, which closes the question
    // immediately rather than in thirty days.
    const cancelled = await withSpendIntent('handled@example.com', 'expired');
    const { cancelSpendIntent } = await import('../src/services/token.js');
    const { rows: intentRows } = await db().query<{ id: string }>(
      'SELECT id FROM token_spend_intents WHERE contact_id = $1',
      [cancelled.id],
    );
    expect(await cancelSpendIntent(tenant.id, intentRows[0]!.id)).not.toBeNull();
    await eraseContact(tenant.id, cancelled.id);
    const closed = await db().query<{ from_address: string }>(
      'SELECT from_address FROM token_spend_intents WHERE contact_id = $1',
      [cancelled.id],
    );
    expect(closed.rows[0]!.from_address).not.toBe(WALLET);
    expect(closed.rows[0]!.from_address).not.toMatch(/^erased:/);
  });

  it('breaks the cross-tenant identity link', async () => {
    // member_id is uuid, and the schema sweep only reads text-ish columns, so
    // the headline fix had no test at all. It is the platform-wide link that
    // nulling contacts.member_id exists to break, and it survived one join
    // away in a row keyed by the erased contact id.
    const contact = await withSpendIntent('linked@example.com', 'verified');
    const before = await db().query<{ member_id: string | null }>(
      'SELECT member_id FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    expect(before.rows[0]!.member_id).not.toBeNull();

    await eraseContact(tenant.id, contact.id);

    const { rows } = await db().query<{ table_name: string; n: string }>(
      `SELECT 'token_claims' AS table_name, count(*)::text AS n
         FROM token_claims WHERE contact_id = $1 AND member_id IS NOT NULL
       UNION ALL
       SELECT 'token_spend_intents', count(*)::text
         FROM token_spend_intents WHERE contact_id = $1 AND member_id IS NOT NULL
       UNION ALL
       SELECT 'bridge_withdrawals', count(*)::text
         FROM bridge_withdrawals WHERE contact_id = $1 AND member_id IS NOT NULL`,
      [contact.id],
    );
    expect(rows.map((row) => [row.table_name, row.n])).toEqual([
      ['token_claims', '0'],
      ['token_spend_intents', '0'],
      ['bridge_withdrawals', '0'],
    ]);
  });
});

describe('an abandoned checkout does not block an erasure forever (HIGH)', () => {
  it('erases once a pending spend intent is past its expiry', async () => {
    // A spend intent is created the moment somebody taps "Pay with TBAY", and
    // nothing moved it out of `pending`: verifySpendIntent refuses an expired
    // one, and there was no cancel route, no service call and no worker. So a
    // customer who changed their mind could never be erased, and the
    // operator's only remedy was an UPDATE against production. An erasure a
    // controller cannot carry out is itself the defect.
    const contact = await upsertContact(tenant.id, { email: 'abandoned@example.com' });
    await db().query(
      `INSERT INTO token_spend_intents (
         tenant_id, contact_id, member_id, token_amount_wei, from_address, to_address,
         chain_id, contract_address, credit_cents, currency, status, expires_at
       )
       SELECT $1, $2, c.member_id, 1, $3, $4, 300,
              '0x74eb73aca939fc911f79d9589e808f0207684d09', 100, 'USD', 'pending',
              now() - interval '90 days'
         FROM contacts c WHERE c.id = $2`,
      [
        tenant.id,
        contact.id,
        '0x14dc79964da2c08b23698b3d3cc7ca32193d9955',
        '0x1111111111111111111111111111111111111111',
      ],
    );

    await expect(eraseContact(tenant.id, contact.id)).resolves.toMatchObject({
      contact_id: contact.id,
    });
  });

  it('closes out abandoned intents so they stop looking live', async () => {
    const { expireStaleSpendIntents } = await import('../src/services/token.js');
    const contact = await upsertContact(tenant.id, { email: 'sweepable@example.com' });
    await db().query(
      `INSERT INTO token_spend_intents (
         tenant_id, contact_id, member_id, token_amount_wei, from_address, to_address,
         chain_id, contract_address, credit_cents, currency, status, expires_at
       )
       SELECT $1, $2, c.member_id, 1, $3, $3, 300,
              '0x74eb73aca939fc911f79d9589e808f0207684d09', 100, 'USD', 'pending',
              now() - interval '1 hour'
         FROM contacts c WHERE c.id = $2`,
      [tenant.id, contact.id, '0x14dc79964da2c08b23698b3d3cc7ca32193d9955'],
    );

    expect(await expireStaleSpendIntents()).toBe(1);
    const { rows } = await db().query<{ status: string }>(
      'SELECT status FROM token_spend_intents WHERE contact_id = $1',
      [contact.id],
    );
    expect(rows[0]!.status).toBe('expired');
  });

  it('refuses on a live intent and not on a lapsed one (HIGH)', async () => {
    // Both arms, deliberately. On its own, "a pending intent twenty minutes in
    // the future is refused" is passed by `status = 'pending'` and by
    // `status = 'pending' AND expires_at > now()` alike, so it pins neither --
    // it cannot tell the fix from the bug it replaced. The pair does: drop the
    // expiry clause and the lapsed arm starts refusing; drop the predicate
    // altogether and the live arm stops.
    async function intentFor(email: string, expiresAt: string) {
      const contact = await upsertContact(tenant.id, { email });
      await db().query(
        `INSERT INTO token_spend_intents (
           tenant_id, contact_id, member_id, token_amount_wei, from_address, to_address,
           chain_id, contract_address, credit_cents, currency, status, expires_at
         )
         SELECT $1, $2, c.member_id, 1, $3, $3, 300,
                '0x74eb73aca939fc911f79d9589e808f0207684d09', 100, 'USD', 'pending',
                now() + $4::interval
           FROM contacts c WHERE c.id = $2`,
        [tenant.id, contact.id, '0x14dc79964da2c08b23698b3d3cc7ca32193d9955', expiresAt],
      );
      return contact;
    }

    const paying = await intentFor('paying@example.com', '20 minutes');
    await expect(eraseContact(tenant.id, paying.id)).rejects.toThrow(/checkout in progress/i);

    const lapsed = await intentFor('lapsed@example.com', '-20 minutes');
    await expect(eraseContact(tenant.id, lapsed.id)).resolves.toMatchObject({
      contact_id: lapsed.id,
    });

    // And a verification actually in flight is refused however long ago the
    // quote lapsed: the chain has already been asked, and the answer is about
    // to write a store credit against this contact.
    const verifying = await intentFor('verifying@example.com', '-2 days');
    await db().query(
      `UPDATE token_spend_intents SET status = 'verifying', verify_claimed_at = now()
        WHERE contact_id = $1`,
      [verifying.id],
    );
    await expect(eraseContact(tenant.id, verifying.id)).rejects.toThrow(/checkout in progress/i);
  });
});
