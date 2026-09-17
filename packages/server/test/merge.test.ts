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
import { award, getBalance, releaseMaturedPoints, reverse, spend } from '../src/services/points.js';
import { recordOrder, refundOrder } from '../src/services/commissions.js';
import { getTenantById } from '../src/services/tenants.js';
import { findDuplicates, mergeContacts, previewMerge } from '../src/services/merge.js';
import { upsertPointType } from '../src/services/point-types.js';
import { setFieldValues, upsertField } from '../src/services/contact-fields.js';
import {
  awardBadgeManually,
  createCoupon,
  evaluateBadges,
  evaluateRank,
  recordStreak,
  reevaluateAll,
  redeemCoupon,
  transferPoints,
  upsertBadge,
} from '../src/services/gamification.js';
import { eraseContact } from '../src/services/privacy.js';
import { setPreferences, upsertTopic } from '../src/services/preferences.js';

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

const authed = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

describe('points are added, not picked', () => {
  it('sums both balances so the survivor still matches its own ledger', async () => {
    const keep = await upsertContact(tenant.id, { email: 'keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'lose@example.com' });

    await award(tenant.id, {
      contactId: keep.id,
      points: 300,
      reason: 'Keep side',
      idempotencyKey: 'm-keep',
    });
    await award(tenant.id, {
      contactId: lose.id,
      points: 450,
      reason: 'Lose side',
      idempotencyKey: 'm-lose',
    });
    await spend(tenant.id, {
      contactId: lose.id,
      points: 50,
      reason: 'Spent on the other record',
      idempotencyKey: 'm-lose-spend',
    });

    const result = await mergeContacts(tenant.id, keep.id, lose.id);

    const balance = await getBalance(tenant.id, keep.id);
    expect(balance.balance).toBe(700);
    expect(balance.lifetime_earned).toBe(750);
    // lifetime_spent is a positive running total, so the two sum to 50.
    expect(balance.lifetime_spent).toBe(50);
    expect(result.points_moved.points).toBe(400);

    // The ledger behind it moved too, so the balance is still derivable.
    const { rows } = await db().query(
      `SELECT COALESCE(SUM(delta_points), 0)::int AS total FROM points_ledger
        WHERE tenant_id = $1 AND contact_id = $2 AND status = 'cleared'`,
      [tenant.id, keep.id],
    );
    expect(rows[0]!.total).toBe(700);
  });

  it('sums every currency separately', async () => {
    await upsertPointType(tenant.id, { key: 'status', name: 'Status' });
    const keep = await upsertContact(tenant.id, { email: 'k@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'l@example.com' });

    await award(tenant.id, { contactId: keep.id, points: 10, reason: 'a', idempotencyKey: 'a' });
    await award(tenant.id, {
      contactId: lose.id,
      points: 20,
      reason: 'b',
      idempotencyKey: 'b',
      pointType: 'status',
    });

    await mergeContacts(tenant.id, keep.id, lose.id);

    expect((await getBalance(tenant.id, keep.id)).balance).toBe(10);
    expect((await getBalance(tenant.id, keep.id, undefined, 'status')).balance).toBe(20);
  });

  it('leaves no balance row behind', async () => {
    const keep = await upsertContact(tenant.id, { email: 'k2@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'l2@example.com' });
    await award(tenant.id, { contactId: lose.id, points: 5, reason: 'x', idempotencyKey: 'x' });

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      'SELECT 1 FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, lose.id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('rows that could collide', () => {
  it('keeps the higher badge level rather than demoting somebody for being merged', async () => {
    await upsertBadge(tenant.id, {
      key: 'collector',
      name: 'Collector',
      tiers: [
        { level: 1, threshold: 1 },
        { level: 3, threshold: 3 },
      ],
      manualOnly: true,
    });

    const keep = await upsertContact(tenant.id, { email: 'badge-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'badge-lose@example.com' });
    await awardBadgeManually(tenant.id, keep.id, 'collector', 1);
    await awardBadgeManually(tenant.id, lose.id, 'collector', 3);

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      `SELECT level FROM badge_awards ba JOIN badges b ON b.id = ba.badge_id
        WHERE ba.tenant_id = $1 AND ba.contact_id = $2 AND b.key = 'collector'`,
      [tenant.id, keep.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe(3);
  });

  it('keeps the longer streak', async () => {
    const keep = await upsertContact(tenant.id, { email: 'streak-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'streak-lose@example.com' });
    await recordStreak(tenant.id, keep.id, 'daily_login');
    await recordStreak(tenant.id, lose.id, 'daily_login');
    await db().query(
      `UPDATE streaks SET longest_length = 40 WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, lose.id],
    );

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      'SELECT longest_length FROM streaks WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, keep.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.longest_length).toBe(40);
  });

  it('does not duplicate a topic preference either side already held', async () => {
    await upsertTopic(tenant.id, { key: 'sales', name: 'Sales' });
    const keep = await upsertContact(tenant.id, { email: 'pref-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'pref-lose@example.com' });
    await setPreferences(tenant.id, keep.id, { topics: { sales: true } });
    await setPreferences(tenant.id, lose.id, { topics: { sales: false } });

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      'SELECT subscribed FROM contact_topic_prefs WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, keep.id],
    );
    // The survivor's own choice wins: it is the record the operator chose.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscribed).toBe(true);
  });

  it('takes a custom field value the survivor did not have', async () => {
    await upsertField(tenant.id, { key: 'province', kind: 'text' });
    await upsertField(tenant.id, { key: 'tier', kind: 'number' });

    const keep = await upsertContact(tenant.id, { email: 'cf-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'cf-lose@example.com' });
    await setFieldValues(tenant.id, keep.id, { province: 'Ontario' });
    await setFieldValues(tenant.id, lose.id, { province: 'Manitoba', tier: 4 });

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { getFieldValues } = await import('../src/services/contact-fields.js');
    const values = await getFieldValues(tenant.id, keep.id);
    // The survivor's own answer stands; the gap is filled.
    expect(values.province).toBe('Ontario');
    expect(values.tier).toBe(4);
  });

  it('merges a subscription without breaking its unique list constraint', async () => {
    const { ensureList, subscribe } = await import('../src/services/newsletter.js');
    const tenantRow = (await getTenantById(tenant.id))!;
    await ensureList(tenant.id);

    await subscribe(tenantRow, { email: 'sub-keep@example.com' });
    await subscribe(tenantRow, { email: 'sub-lose@example.com' });

    const keep = (await upsertContact(tenant.id, { email: 'sub-keep@example.com' })).id;
    const lose = (await upsertContact(tenant.id, { email: 'sub-lose@example.com' })).id;

    // A blind UPDATE here trips (list_id, contact_id) and takes the whole
    // merge with it — which is exactly the customer who was active on both.
    await mergeContacts(tenant.id, keep, lose);

    const { rows } = await db().query(
      'SELECT COUNT(*)::int AS n FROM subscriptions WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, keep],
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('the surviving record', () => {
  it('keeps its own id, and fills its gaps from the other', async () => {
    const keep = await upsertContact(tenant.id, {
      email: 'gaps-keep@example.com',
      name: 'Real Name',
    });
    const lose = await upsertContact(tenant.id, {
      email: 'gaps-lose@example.com',
      name: 'Other Name',
      phone: '+1 807 555 0111',
      externalRef: 'wp-99',
      tags: ['vip'],
    });

    const result = await mergeContacts(tenant.id, keep.id, lose.id);
    expect(result.kept).toBe(keep.id);

    const { rows } = await db().query('SELECT * FROM contacts WHERE id = $1', [keep.id]);
    const row = rows[0]!;
    expect(row.email).toBe('gaps-keep@example.com');
    // Whoever the operator chose to keep is the one whose details they meant.
    expect(row.name).toBe('Real Name');
    expect(row.phone).toBe('+1 807 555 0111');
    expect(row.external_ref).toBe('wp-99');
    expect(row.tags).toContain('vip');
  });

  it('holds consent if either record held it, and keeps the earlier date', async () => {
    const keep = await upsertContact(tenant.id, { email: 'consent-keep@example.com' });
    const lose = await upsertContact(tenant.id, {
      email: 'consent-lose@example.com',
      marketingConsent: true,
      consentSource: 'checkout',
    });
    await db().query(
      "UPDATE contacts SET consent_at = now() - interval '400 days' WHERE id = $1",
      [lose.id],
    );

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      'SELECT marketing_consent, consent_source, consent_at FROM contacts WHERE id = $1',
      [keep.id],
    );
    expect(rows[0]!.marketing_consent).toBe(true);
    expect(rows[0]!.consent_source).toBe('checkout');
    // Consent dates prove how long a permission has been held. Taking the
    // later one quietly shortens it.
    const age = (Date.now() - new Date(rows[0]!.consent_at).getTime()) / 86_400_000;
    expect(age).toBeGreaterThan(390);
  });

  it('takes the later pause, so merging never shortens one somebody asked for', async () => {
    const keep = await upsertContact(tenant.id, {
      email: 'pause-keep@example.com',
      marketingConsent: true,
    });
    const lose = await upsertContact(tenant.id, {
      email: 'pause-lose@example.com',
      marketingConsent: true,
    });
    await setPreferences(tenant.id, keep.id, { pauseDays: 7 });
    await setPreferences(tenant.id, lose.id, { pauseDays: 90 });

    await mergeContacts(tenant.id, keep.id, lose.id);

    const { rows } = await db().query(
      'SELECT marketing_paused_until FROM contacts WHERE id = $1',
      [keep.id],
    );
    const days = (new Date(rows[0]!.marketing_paused_until).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(80);
  });

  it('carries the orders and their commissions across', async () => {
    const tenantRow = (await getTenantById(tenant.id))!;
    const keep = await upsertContact(tenant.id, { email: 'order-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'order-lose@example.com' });

    await recordOrder(tenantRow, { orderRef: 'o-keep', totalCents: 5_000, contactId: keep.id });
    await recordOrder(tenantRow, { orderRef: 'o-lose', totalCents: 9_000, contactId: lose.id });

    const result = await mergeContacts(tenant.id, keep.id, lose.id);
    expect(result.moved.orders).toBe(1);

    const { rows } = await db().query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1 AND contact_id = $2',
      [tenant.id, keep.id],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('leaves nothing pointing at the merged record', async () => {
    const tenantRow = (await getTenantById(tenant.id))!;
    const keep = await upsertContact(tenant.id, { email: 'orphan-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'orphan-lose@example.com' });
    await recordOrder(tenantRow, { orderRef: 'o-orphan', totalCents: 7_000, contactId: lose.id });
    await recordStreak(tenant.id, lose.id, 'daily_login');

    await mergeContacts(tenant.id, keep.id, lose.id);

    // The contact row is gone, and nothing anywhere still names it.
    const gone = await db().query('SELECT 1 FROM contacts WHERE id = $1', [lose.id]);
    expect(gone.rows).toHaveLength(0);

    const { rows: columns } = await db().query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          AND c.data_type = 'uuid'
          AND c.column_name LIKE '%contact_id'`,
    );

    const orphans: string[] = [];
    for (const column of columns) {
      const { rows } = await db().query(
        `SELECT 1 FROM "${column.table_name}" WHERE "${column.column_name}" = $1 LIMIT 1`,
        [lose.id],
      );
      if (rows.length > 0) orphans.push(`${column.table_name}.${column.column_name}`);
    }
    expect(orphans).toEqual([]);
  });
});

describe('what a merge refuses', () => {
  it('will not merge a contact into itself', async () => {
    const contact = await upsertContact(tenant.id, { email: 'self@example.com' });
    await expect(mergeContacts(tenant.id, contact.id, contact.id)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('will not reach across tenants', async () => {
    const other = await makeTenant();
    const mine = await upsertContact(tenant.id, { email: 'mine@example.com' });
    const theirs = await upsertContact(other.id, { email: 'theirs@example.com' });

    await expect(mergeContacts(tenant.id, mine.id, theirs.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    const { rows } = await db().query('SELECT 1 FROM contacts WHERE id = $1', [theirs.id]);
    expect(rows).toHaveLength(1);
  });

  it('will not merge an erased record', async () => {
    const keep = await upsertContact(tenant.id, { email: 'alive@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'erased@example.com' });
    await eraseContact(tenant.id, lose.id);

    // Merging would carry what the erased record still holds onto a live one:
    // the erasure undone by another route.
    await expect(mergeContacts(tenant.id, keep.id, lose.id)).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

describe('finding and previewing', () => {
  it('spots a shared wallet, and ignores a shared name', async () => {
    await upsertContact(tenant.id, { email: 'dup1@example.com', name: 'Same Name' });
    await upsertContact(tenant.id, { email: 'dup2@example.com', name: 'Same Name' });

    // A shared name is a coincidence, and a merge is irreversible.
    expect(await findDuplicates(tenant.id)).toHaveLength(0);

    await db().query(
      `UPDATE contacts SET wallet_address = '0x1111111111111111111111111111111111111111'
        WHERE tenant_id = $1 AND email IN ('dup1@example.com','dup2@example.com')`,
      [tenant.id],
    );

    // A wallet the holder signed a challenge to bind is a proof, not a
    // resemblance.
    const found = await findDuplicates(tenant.id);
    expect(found.some((row) => row.reason === 'wallet_address')).toBe(true);
    expect(found.find((row) => row.reason === 'wallet_address')!.contact_ids).toHaveLength(2);
  });

  it('cannot report a duplicate external reference, because there cannot be one', async () => {
    await upsertContact(tenant.id, { email: 'ref1@example.com', externalRef: 'wp-7' });
    // (tenant_id, external_ref) is uniquely indexed, so the second write is
    // matched to the first contact rather than creating a duplicate.
    const second = await upsertContact(tenant.id, { externalRef: 'wp-7', name: 'Same Person' });

    const { rows } = await db().query(
      "SELECT COUNT(*)::int AS n FROM contacts WHERE tenant_id = $1 AND external_ref = 'wp-7'",
      [tenant.id],
    );
    expect(rows[0]!.n).toBe(1);
    expect(second.email).toBe('ref1@example.com');
  });

  it('shows the combined balance before anything is done', async () => {
    const keep = await upsertContact(tenant.id, { email: 'pv-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'pv-lose@example.com' });
    await award(tenant.id, { contactId: keep.id, points: 40, reason: 'a', idempotencyKey: 'pa' });
    await award(tenant.id, { contactId: lose.id, points: 60, reason: 'b', idempotencyKey: 'pb' });

    const preview = await previewMerge(tenant.id, keep.id, lose.id);
    expect(preview.combined_balances.points).toBe(100);

    // Nothing moved.
    expect((await getBalance(tenant.id, keep.id)).balance).toBe(40);
  });
});

describe('over the API', () => {
  it('merges and reports what moved', async () => {
    const keep = await upsertContact(tenant.id, { email: 'api-keep@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'api-lose@example.com' });
    await award(tenant.id, {
      contactId: lose.id,
      points: 120,
      reason: 'Theirs',
      idempotencyKey: 'api-m',
    });

    const res = await authed('POST', '/v1/contacts/merge', { keep: keep.id, merge: lose.id });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).points_moved.points).toBe(120);
    expect((await getBalance(tenant.id, keep.id)).balance).toBe(120);
  });

  it('rejects a non-uuid rather than reaching the database with it', async () => {
    const res = await authed('GET', '/v1/contacts/merge/preview?keep=nope&merge=also-nope');
    expect(res.statusCode).toBe(400);
  });
});

describe('a merge and a spend at the same moment', () => {
  it('makes a spend wait for a merge that is holding the contact', async () => {
    // The mechanism, tested directly. The merge locks the two contact rows;
    // award and spend used to lock only the balance row, so nothing made the
    // two serialise and a spend could land between the merge reading the
    // loser's balance and moving their ledger — leaving the survivor holding
    // points that were never earned.
    //
    // That interleaving is a sub-millisecond window, which is not something a
    // test can reliably provoke. What a test can check is the lock itself: a
    // spend must not proceed while a merge holds the contact row.
    const keep = (await upsertContact(tenant.id, { email: 'lock-keep@example.com' })).id;
    const loser = (await upsertContact(tenant.id, { email: 'lock-lose@example.com' })).id;
    await award(tenant.id, {
      contactId: loser,
      points: 100,
      reason: 'seed',
      idempotencyKey: 'lock-seed',
    });

    const holder = await db().connect();
    try {
      await holder.query('BEGIN');
      // What the merge takes first.
      await holder.query('SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenant.id,
        loser,
      ]);

      const spending = spend(tenant.id, {
        contactId: loser,
        points: 50,
        reason: 'blocked',
        idempotencyKey: 'lock-spend',
      });

      const outcome = await Promise.race([
        spending.then(() => 'finished'),
        new Promise((resolve) => setTimeout(() => resolve('waited'), 700)),
      ]);
      // Without the shared lock in `holdContact`, this reads 'finished'.
      expect(outcome).toBe('waited');

      await holder.query('ROLLBACK');
      await spending;
    } finally {
      holder.release();
    }
  });

  it('does not deadlock with a refund clawing points back', async () => {
    // Every writer takes the contact first. `reverse` took the ledger row
    // first and the balance second — the opposite of the merge's
    // contact → balance → ledger — so a refund racing a merge deadlocked and
    // Postgres aborted one of them. That surfaced as a 500 on
    // `POST /v1/orders/:ref/refund`, which rolled the whole refund back: the
    // points stayed with the customer and the commissions stayed payable.
    const failures: string[] = [];

    for (let round = 0; round < 8; round += 1) {
      const keep = (await upsertContact(tenant.id, { email: `dl-keep-${round}@example.com` })).id;
      const loser = (await upsertContact(tenant.id, { email: `dl-lose-${round}@example.com` })).id;
      const entry = await award(tenant.id, {
        contactId: loser,
        points: 200,
        reason: 'to be reversed',
        idempotencyKey: `dl-seed-${round}`,
      });

      const results = await Promise.allSettled([
        mergeContacts(tenant.id, keep, loser),
        reverse(tenant.id, entry.entry!.id, 'refund', undefined, { clampToBalance: true }),
      ]);

      for (const result of results) {
        if (result.status === 'rejected' && /deadlock/i.test(String(result.reason))) {
          failures.push(String(result.reason).slice(0, 80));
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('leaves the survivor with a balance that equals its own ledger', async () => {
    // A guard on the invariant rather than a reproduction of the race: after a
    // concurrent merge and spend, whatever order they land in, the survivor's
    // balance must equal the sum of its own ledger.
    const keep = (await upsertContact(tenant.id, { email: 'keep-race@example.com' })).id;
    const loser = (await upsertContact(tenant.id, { email: 'loser-race@example.com' })).id;

    await award(tenant.id, {
      contactId: loser,
      points: 100,
      reason: 'seed',
      idempotencyKey: 'race-seed',
    });

    // Staggered on purpose. The window is: the merge reads the loser's
    // balance, the spend commits, the merge then moves the loser's ledger onto
    // the survivor. Firing both at the same instant does not reach it — the
    // spend finishes before the merge has read anything — so the spend starts
    // a few milliseconds in.
    const merging = mergeContacts(tenant.id, keep, loser);
    await new Promise((resolve) => setTimeout(resolve, 3));
    const spending = spend(tenant.id, {
      contactId: loser,
      points: 50,
      reason: 'race spend',
      idempotencyKey: 'race-spend',
    });

    const [merged] = await Promise.allSettled([merging, spending]);
    // The merge itself has to have happened, or this test proves nothing.
    expect(merged.status).toBe('fulfilled');

    const { rows } = await db().query<{ balance: string; ledger: string }>(
      `SELECT b.balance,
              COALESCE((SELECT SUM(l.delta_points) FROM points_ledger l
                         WHERE l.tenant_id = b.tenant_id AND l.contact_id = b.contact_id
                           AND l.point_type = b.point_type), 0) AS ledger
         FROM points_balances b
        WHERE b.tenant_id = $1 AND b.contact_id = $2`,
      [tenant.id, keep],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.balance)).toBe(Number(row.ledger));
    }

    // And the loser is gone, so nothing of theirs is stranded.
    const { rows: left } = await db().query(
      'SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2',
      [tenant.id, loser],
    );
    expect(left).toHaveLength(0);
  });
});

describe('every writer reaches for the contact before anything else', () => {
  /**
   * The ordering rule the merge depends on: contact, then balance, then
   * ledger. Five writers still broke it -- a refund took the order row first,
   * a transfer the balances, the maturity sweep the ledger, a streak its own
   * streaks row -- and each of them deadlocked against a merge often enough to
   * see in sixteen tries.
   *
   * Asserting "it waited" is not enough, and an earlier version of this suite
   * did exactly that: the broken ordering waits too, just later and holding
   * something else. So this holds the contact, waits for the writer to block,
   * and then asks -- from a third connection, with NOWAIT -- whether the row
   * it should not have reached yet is still free. If the writer already holds
   * it, it did not stop at the contact.
   */
  async function stopsAtTheContact(
    contactId: string,
    untouched: { sql: string; params: unknown[] },
    start: () => Promise<unknown>,
  ): Promise<{ waited: boolean; tookTheOtherLockFirst: boolean }> {
    const holder = await db().connect();
    const prober = await db().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM contacts WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [
        tenant.id,
        contactId,
      ]);

      const running = start().catch(() => 'failed');
      const outcome = await Promise.race([
        running.then(() => 'finished'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 600)),
      ]);

      // The row the writer must not have taken yet. NOWAIT turns "somebody
      // else holds this" into an error instead of a wait.
      let tookTheOtherLockFirst = false;
      await prober.query('BEGIN');
      try {
        const probe = await prober.query(`${untouched.sql} FOR UPDATE NOWAIT`, untouched.params);
        // A probe that matches nothing proves nothing, so insist it found the
        // row it was asked about.
        expect(probe.rowCount).toBeGreaterThan(0);
      } catch (error) {
        if ((error as { code?: string }).code !== '55P03') throw error;
        tookTheOtherLockFirst = true;
      }
      await prober.query('ROLLBACK');

      await holder.query('ROLLBACK');
      await running;
      return { waited: outcome === 'waited', tookTheOtherLockFirst };
    } finally {
      holder.release();
      prober.release();
    }
  }

  it('makes a refund wait for the contact, not the order row', async () => {
    const contact = await upsertContact(tenant.id, { email: 'refund-order@example.com' });
    const tenantRow = (await getTenantById(tenant.id))!;
    await recordOrder(tenantRow, {
      orderRef: 'lock-refund',
      totalCents: 5_000,
      contactId: contact.id,
      email: 'refund-order@example.com',
    });

    expect(
      await stopsAtTheContact(
        contact.id,
        {
          sql: 'SELECT 1 FROM orders WHERE tenant_id = $1 AND order_ref = $2',
          params: [tenant.id, 'lock-refund'],
        },
        () => refundOrder(tenantRow, 'lock-refund'),
      ),
    ).toEqual({ waited: true, tookTheOtherLockFirst: false });
  });

  it('makes a transfer wait for the contact, not the balances', async () => {
    const from = await upsertContact(tenant.id, { email: 'from@example.com' });
    const to = await upsertContact(tenant.id, { email: 'to@example.com' });
    await award(tenant.id, {
      contactId: from.id, points: 500, reason: 'seed', idempotencyKey: 'lock-transfer-seed',
    });

    expect(
      await stopsAtTheContact(
        from.id,
        {
          sql: 'SELECT 1 FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
          params: [tenant.id, from.id],
        },
        () => transferPoints(tenant.id, {
          fromContactId: from.id, toContactId: to.id, points: 100,
        }),
      ),
    ).toEqual({ waited: true, tookTheOtherLockFirst: false });
  });

  it('makes a streak wait for the contact, not the streaks row', async () => {
    const contact = await upsertContact(tenant.id, { email: 'streaker@example.com' });
    // One run first, so there is a streaks row for the probe to ask about.
    await recordStreak(tenant.id, contact.id, 'daily_login');

    expect(
      await stopsAtTheContact(
        contact.id,
        {
          sql: `SELECT 1 FROM streaks
                 WHERE tenant_id = $1 AND contact_id = $2 AND key = 'daily_login'`,
          params: [tenant.id, contact.id],
        },
        () => recordStreak(tenant.id, contact.id, 'daily_login'),
      ),
    ).toEqual({ waited: true, tookTheOtherLockFirst: false });
  });

  it('makes the maturity sweep wait for the contact, not the ledger', async () => {
    const contact = await upsertContact(tenant.id, { email: 'maturing@example.com' });
    await award(tenant.id, {
      contactId: contact.id,
      points: 300,
      reason: 'held',
      idempotencyKey: 'lock-release-seed',
      holdSeconds: 0,
    });
    await db().query(
      `UPDATE points_ledger SET status = 'pending', available_at = now() - interval '1 minute'
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );

    expect(
      await stopsAtTheContact(
        contact.id,
        {
          sql: `SELECT 1 FROM points_ledger
                 WHERE tenant_id = $1 AND contact_id = $2 AND status = 'pending'`,
          params: [tenant.id, contact.id],
        },
        () => releaseMaturedPoints(),
      ),
    ).toEqual({ waited: true, tookTheOtherLockFirst: false });
  });

  it('makes a coupon redemption wait for the contact, not the coupon row', async () => {
    const contact = await upsertContact(tenant.id, { email: 'redeemer@example.com' });
    await createCoupon(tenant.id, { code: 'LOCKME', points: 25 });

    expect(
      await stopsAtTheContact(
        contact.id,
        {
          sql: 'SELECT 1 FROM point_coupons WHERE tenant_id = $1 AND code = $2',
          params: [tenant.id, 'LOCKME'],
        },
        () => redeemCoupon(tenant.id, contact.id, 'LOCKME'),
      ),
    ).toEqual({ waited: true, tookTheOtherLockFirst: false });
  });

  /**
   * Two writers whose first write is an INSERT referencing the contact cannot
   * be tested by lock order at all, and pretending otherwise produced two
   * vacuous tests: `waited` came free from the KEY SHARE lock the foreign key
   * takes -- the very mechanism holdContact exists so as not to rely on -- and
   * `tookTheOtherLockFirst` was trivially false because neither writer ever
   * locks the probed row. One of them probed a row it was never going to
   * touch.
   *
   * What holdContact actually buys them is the answer a person gets when the
   * contact goes away mid-request: a sentence instead of a constraint name.
   * That is the property, so that is what these assert.
   */
  async function afterTheContactVanishes(run: (contactId: string) => Promise<unknown>) {
    const keep = await upsertContact(tenant.id, { email: 'survivor@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'vanisher@example.com' });
    await award(tenant.id, {
      contactId: lose.id, points: 100, reason: 'seed', idempotencyKey: `seed-${lose.id}`,
    });
    await mergeContacts(tenant.id, keep.id, lose.id);
    return run(lose.id);
  }

  it('tells an order writer the contact is gone, not the constraint name', async () => {
    const tenantRow = (await getTenantById(tenant.id))!;

    await expect(
      afterTheContactVanishes((contactId) =>
        recordOrder(tenantRow, {
          orderRef: 'vanished-order',
          totalCents: 2_000,
          contactId,
          email: 'vanisher@example.com',
        }),
      ),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('tells badge evaluation the contact is gone, not the constraint name', async () => {
    await expect(
      afterTheContactVanishes((contactId) => evaluateBadges(tenant.id, contactId)),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('tells rank evaluation the contact is gone, not the constraint name', async () => {
    await expect(
      afterTheContactVanishes((contactId) => evaluateRank(tenant.id, contactId)),
    ).rejects.toThrow(/no longer exists/i);
  });

  it('does not end a bulk re-evaluation because one contact was merged', async () => {
    // The sweep walks the whole member list, so a contact merged away while it
    // runs is ordinary -- and that friendly "no longer exists" used to abort
    // the run, leaving a tenant's re-rank half applied.
    //
    // A race, deliberately: the merge has to land while the sweep is in
    // flight. It cannot fail spuriously (a merge that lands too late simply
    // finds nothing to disturb), and with the handler removed it fails
    // reliably, which is what a regression test has to do.
    const contacts: string[] = [];
    for (let n = 0; n < 60; n += 1) {
      const contact = await upsertContact(tenant.id, { email: `sweep${n}@example.com` });
      await award(tenant.id, {
        contactId: contact.id, points: 600, reason: 'seed', idempotencyKey: `sweep-${n}`,
      });
      contacts.push(contact.id);
    }

    // A rank the seeded balance qualifies for, so "was this contact actually
    // evaluated?" has a visible answer.
    await db().query(
      `INSERT INTO ranks (tenant_id, key, name, min_points, display_order)
       VALUES ($1, 'swept-gold', 'Gold', 500, 1)`,
      [tenant.id],
    );

    const merges = [10, 20, 30, 40].map((n) =>
      mergeContacts(tenant.id, contacts[n - 1]!, contacts[n]!).catch(() => null),
    );
    const swept = await reevaluateAll(tenant.id, { badges: false, ranks: true });
    await Promise.all(merges);

    // `contacts` counts rows the sweep *reached*, and it is incremented before
    // the try block -- so on its own it is 60 whether the run did the work or
    // threw on every single one. What proves the run happened is the ranks it
    // wrote and the size of what it gave up on.
    expect(swept.contacts).toBe(60);
    expect(swept.skipped).toBeLessThanOrEqual(4);
    expect(swept.missing.length).toBe(swept.skipped);

    const { rows } = await db().query<{ ranked: string; total: string }>(
      `SELECT count(*) FILTER (WHERE current_rank_id IS NOT NULL)::text AS ranked,
              count(*)::text AS total
         FROM points_balances WHERE tenant_id = $1 AND lifetime_earned >= 500`,
      [tenant.id],
    );
    expect(Number(rows[0]!.total)).toBeGreaterThanOrEqual(56);
    // Every surviving balance over the threshold actually holds the rank.
    expect(rows[0]!.ranked).toBe(rows[0]!.total);
  });

  it('finishes a bulk run that one member refuses, and says why (HIGH)', async () => {
    // Three wrong answers came before this. Catching nothing let a contact
    // merged away mid-sweep abort the run. Catching every 4xx reported 200 OK
    // with {contacts: 200, skipped: 190} and no reason. Narrowing to 404 was
    // worse than either: a badge whose point type has been turned off throws
    // 422 from `award`, and only the members who *qualify* for that badge
    // reach it -- so the run died partway and every retry died at the same
    // contact, leaving `POST /v1/gamification/reevaluate` permanently broken
    // for that tenant and everyone after it on a stale rank.
    await db().query(
      `INSERT INTO ranks (tenant_id, key, name, min_points, display_order)
       VALUES ($1, 'refused-gold', 'Gold', 500, 1)`,
      [tenant.id],
    );
    // A second currency, live while the balances were earned.
    await db().query(
      `INSERT INTO point_types (tenant_id, key, name, enabled) VALUES ($1, 'stars', 'Stars', true)`,
      [tenant.id],
    );
    const { forgetPointTypes } = await import('../src/services/point-types.js');
    forgetPointTypes();
    await db().query(
      `INSERT INTO badges (tenant_id, key, name, criteria, tiers, points_per_tier, point_type)
       VALUES ($1, 'star-badge', 'Star', '{"type":"lifetime_points"}'::jsonb,
               '[{"level":1,"threshold":900,"label":"Star"}]'::jsonb, 10, 'stars')`,
      [tenant.id],
    );

    const people: string[] = [];
    for (let n = 0; n < 10; n += 1) {
      const contact = await upsertContact(tenant.id, { email: `refuse${n}@example.com` });
      // Only the sixth reaches the badge threshold, so the failure is
      // per-contact and lands in the middle of the run.
      await award(tenant.id, {
        contactId: contact.id,
        points: 600,
        reason: 'seed',
        idempotencyKey: `refuse-${n}`,
      });
      // Only the sixth ever earned the second currency, so only they reach the
      // badge -- the failure is per-contact and lands mid-run, which is what
      // makes it fatal rather than obvious.
      if (n === 5) {
        await award(tenant.id, {
          contactId: contact.id,
          points: 1_000,
          reason: 'stars',
          idempotencyKey: `refuse-stars-${n}`,
          pointType: 'stars',
        });
      }
      people.push(contact.id);
    }

    // Switched off afterwards, which is the ordinary way a retailer retires a
    // currency and the state nothing else in the product complains about.
    await db().query(
      `UPDATE point_types SET enabled = false WHERE tenant_id = $1 AND key = 'stars'`,
      [tenant.id],
    );
    forgetPointTypes();

    const swept = await reevaluateAll(tenant.id, { badges: true, ranks: true });

    // It finished.
    expect(swept.contacts).toBe(10);
    // It named the member and the setting, rather than a bare count.
    expect(swept.problems.length).toBe(1);
    expect(swept.problems[0]).toContain(people[5]!);
    expect(swept.problems[0]).toMatch(/currency is turned off/i);
    // And nobody was reported as skipped, because nobody was: the rank half
    // ran and committed for all ten. "Skipped" has to mean nothing was
    // written, or the count it replaced is no more actionable than before.
    expect(swept.skipped).toBe(0);

    // Asking for neither half is a no-op, not ten failures. Counting a
    // contact as skipped when nothing was *requested* turned an empty
    // instruction into a report that every member had been passed over.
    const nothing = await reevaluateAll(tenant.id, { badges: false, ranks: false });
    expect(nothing.contacts).toBe(10);
    expect(nothing.skipped).toBe(0);
    expect(nothing.problems).toEqual([]);
    // Everybody was re-ranked -- including the member whose badge refused,
    // whose rank has nothing to do with that badge, and including everyone
    // after them, which is what the aborting version left on stale tiers.
    const { rows } = await db().query<{ ranked: string; total: string }>(
      `SELECT count(*) FILTER (WHERE current_rank_id IS NOT NULL)::text AS ranked,
              count(*)::text AS total
         FROM points_balances
        WHERE tenant_id = $1 AND point_type = 'points' AND lifetime_earned >= 500`,
      [tenant.id],
    );
    expect(rows[0]!.total).toBe('10');
    expect(rows[0]!.ranked).toBe('10');
  });

  it('says what happened when the contact was merged away mid-flight', async () => {
    // FOR SHARE has nothing to wait on once the row is gone, so the writer
    // carried on and failed several statements later on a foreign key --
    // reporting a constraint name to somebody who just wanted to know why
    // their points did not arrive.
    const keep = await upsertContact(tenant.id, { email: 'keeper@example.com' });
    const loser = await upsertContact(tenant.id, { email: 'goner@example.com' });
    await mergeContacts(tenant.id, keep.id, loser.id);

    await expect(recordStreak(tenant.id, loser.id, 'daily_login')).rejects.toThrow(
      /no longer exists/i,
    );
  });
});

describe('two records that exchanged points can still be merged (MEDIUM)', () => {
  it('collapses a gift between the two rather than failing', async () => {
    // Reassigning both sides of a transfer to the survivor makes it a transfer
    // from somebody to themselves, which `transfers_no_self` refuses -- so one
    // gift between two duplicate records of the same person made them
    // permanently unmergeable, and the merge died on a raw constraint name as
    // a 500.
    const keep = await upsertContact(tenant.id, { email: 'gifter@example.com' });
    const lose = await upsertContact(tenant.id, { email: 'gifter.alt@example.com' });
    await award(tenant.id, {
      contactId: lose.id, points: 500, reason: 'seed', idempotencyKey: 'gift-seed',
    });
    await transferPoints(tenant.id, {
      fromContactId: lose.id, toContactId: keep.id, points: 50,
    });

    const result = await mergeContacts(tenant.id, keep.id, lose.id);

    expect(result.kept).toBe(keep.id);
    // The transfer row goes; the points themselves are in the ledger, which
    // survives and still reconciles.
    const { rows: transfers } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM point_transfers WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(transfers[0]!.n)).toBe(0);

    const { rows: left } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM contacts WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(left[0]!.n)).toBe(1);
    expect((await getBalance(tenant.id, keep.id)).balance).toBe(500);
  });
});
