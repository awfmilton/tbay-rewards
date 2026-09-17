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
import { award, getBalance, reverse, spend } from '../src/services/points.js';
import { recordOrder } from '../src/services/commissions.js';
import { getTenantById } from '../src/services/tenants.js';
import { findDuplicates, mergeContacts, previewMerge } from '../src/services/merge.js';
import { upsertPointType } from '../src/services/point-types.js';
import { setFieldValues, upsertField } from '../src/services/contact-fields.js';
import {
  awardBadgeManually,
  recordStreak,
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
