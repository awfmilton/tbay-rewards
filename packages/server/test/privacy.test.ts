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
  it('finds no trace of the address or the name in any table', async () => {
    const email = 'needle-in-haystack@example.com';
    const name = 'Zebediah Haystack';

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
          WHERE "${column.column_name}"::text ILIKE $1 OR "${column.column_name}"::text ILIKE $2
          LIMIT 1`,
        [`%${email}%`, `%${name}%`],
      );
      if (rows.length > 0) hits.push(`${column.table_name}.${column.column_name}`);
    }

    expect(hits).toEqual([]);
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
