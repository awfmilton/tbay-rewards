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

/**
 * The control surfaces a myCred/Mautic parity review found missing: who does
 * not earn, which products earn differently, the wider cap windows, badge and
 * rank CRUD, ledger search and export, and transfer limits.
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

async function authed(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
) {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function contactFor(email: string): Promise<string> {
  const response = await authed('POST', '/v1/contacts', { email });
  return JSON.parse(response.body).contact_id as string;
}

async function balanceOf(contactId: string): Promise<number> {
  const { rows } = await db().query<{ balance: number }>(
    'SELECT balance FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
    [tenant.id, contactId],
  );
  return rows[0]?.balance ?? 0;
}

/**
 * Everything ever awarded, held or not.
 *
 * The `purchase` rule holds points through the refund window, so they sit in
 * `pending` rather than `balance` — asserting on `balance` would make an
 * order-driven test read as if nothing was awarded.
 */
async function earnedBy(contactId: string): Promise<number> {
  const { rows } = await db().query<{ lifetime_earned: number }>(
    'SELECT lifetime_earned FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
    [tenant.id, contactId],
  );
  return rows[0]?.lifetime_earned ?? 0;
}

describe('reward exclusions', () => {
  it('stops an excluded contact earning without touching their history', async () => {
    const staff = await contactFor('staff@shop.example.com');

    await authed('POST', '/v1/rewards/trigger', {
      contactId: staff,
      ruleKey: 'account_created',
      refId: 'signup-1',
    });
    expect(await balanceOf(staff)).toBe(50);

    await authed('POST', '/v1/rewards/exclusions', {
      kind: 'email',
      value: 'STAFF@shop.example.com', // case is normalised on write
      note: 'shop owner',
    });

    const blocked = await authed('POST', '/v1/rewards/trigger', {
      contactId: staff,
      ruleKey: 'review',
      refId: 'review-1',
    });
    expect(JSON.parse(blocked.body).reason).toBe('excluded');

    // The points they had before the exclusion are still theirs.
    expect(await balanceOf(staff)).toBe(50);
  });

  it('excludes a whole email domain', async () => {
    const tester = await contactFor('qa@internal.test');
    await authed('POST', '/v1/rewards/exclusions', {
      kind: 'email_domain',
      value: '@internal.test',
    });

    const blocked = await authed('POST', '/v1/rewards/trigger', {
      contactId: tester,
      ruleKey: 'review',
      refId: 'r1',
    });
    expect(JSON.parse(blocked.body).reason).toBe('excluded');
  });

  it('keeps an excluded contact off the leaderboard', async () => {
    const staff = await contactFor('boss@shop.example.com');
    const customer = await contactFor('real@example.com');

    for (const [contactId, ref] of [[staff, 'a'], [customer, 'b']] as const) {
      await authed('POST', '/v1/rewards/trigger', {
        contactId,
        ruleKey: 'account_created',
        refId: ref,
      });
    }

    await authed('POST', '/v1/rewards/exclusions', { kind: 'contact', value: staff });

    const board = JSON.parse((await authed('GET', '/v1/rewards/leaderboard')).body);
    expect(board.leaders.map((row: { contact_id: string }) => row.contact_id)).toEqual([customer]);
  });
});

describe('per-product reward overrides', () => {
  it('excludes a product, doubles another, and flat-rates a third', async () => {
    await authed('POST', '/v1/rewards/product-rules', {
      matchKind: 'product',
      matchValue: 'gift-card',
      mode: 'exclude',
    });
    await authed('POST', '/v1/rewards/product-rules', {
      matchKind: 'product',
      matchValue: 'canoe',
      mode: 'multiplier',
      multiplier: 2,
    });
    await authed('POST', '/v1/rewards/product-rules', {
      matchKind: 'category',
      matchValue: 'clearance',
      mode: 'fixed',
      points: 5,
    });

    await authed('POST', '/v1/orders', {
      orderRef: 'order-1',
      email: 'buyer@example.com',
      totalCents: 30_000,
      subtotalCents: 30_000,
      items: [
        { productRef: 'gift-card', quantity: 1, subtotalCents: 10_000 },
        { productRef: 'canoe', quantity: 1, subtotalCents: 10_000 },
        { productRef: 'old-paddle', quantity: 2, subtotalCents: 10_000, categoryRefs: ['clearance'] },
      ],
    });

    // gift card: 0. canoe: $100 x2 = 200 points. clearance: 5 x 2 units = 10.
    // Plus 50 for the account the order created.
    const contact = await contactFor('buyer@example.com');
    expect(await earnedBy(contact)).toBe(210 + 50);
  });

  it('leaves an order alone when nothing is configured', async () => {
    await authed('POST', '/v1/orders', {
      orderRef: 'order-2',
      email: 'plain@example.com',
      totalCents: 5_000,
      subtotalCents: 5_000,
      items: [{ productRef: 'canoe', quantity: 1, subtotalCents: 5_000 }],
    });
    const contact = await contactFor('plain@example.com');
    expect(await earnedBy(contact)).toBe(50 + 50); // $50 order + signup
  });
});

describe('cap windows and clamps', () => {
  it('enforces a weekly cap', async () => {
    await authed('PUT', '/v1/rewards/rules', {
      key: 'review',
      points: 75,
      dailyCap: null,
      weeklyCap: 150,
    });
    const contact = await contactFor('reviewer@example.com');

    for (const ref of ['r1', 'r2']) {
      const response = await authed('POST', '/v1/rewards/trigger', {
        contactId: contact,
        ruleKey: 'review',
        refId: ref,
      });
      expect(JSON.parse(response.body).awarded).toBe(true);
    }

    const third = await authed('POST', '/v1/rewards/trigger', {
      contactId: contact,
      ruleKey: 'review',
      refId: 'r3',
    });
    expect(JSON.parse(third.body).reason).toBe('weekly_cap');
    expect(await balanceOf(contact)).toBe(150);
  });

  it('clamps a single award to max_per_award', async () => {
    await authed('PUT', '/v1/rewards/rules', {
      key: 'purchase',
      mode: 'per_currency_unit',
      pointsPerUnit: 1,
      maxPerAward: 100,
    });

    await authed('POST', '/v1/orders', {
      orderRef: 'whale-1',
      email: 'whale@example.com',
      totalCents: 500_000, // would be 5,000 points unclamped
      subtotalCents: 500_000,
    });

    const contact = await contactFor('whale@example.com');
    expect(await earnedBy(contact)).toBe(100 + 50); // clamped purchase + signup
  });
});

describe('coupon conditions', () => {
  it('refuses a coupon below the minimum balance and says why', async () => {
    await authed('POST', '/v1/gamification/coupons', {
      code: 'VIPONLY',
      points: 500,
      minBalance: 1000,
    });
    const contact = await contactFor('poor@example.com');

    const response = await authed('POST', '/v1/gamification/coupons/redeem', {
      contactId: contact,
      code: 'VIPONLY',
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).message).toContain('1000');
  });

  it('still gives one generic answer for an unknown code', async () => {
    const contact = await contactFor('guesser@example.com');
    const response = await authed('POST', '/v1/gamification/coupons/redeem', {
      contactId: contact,
      code: 'NOSUCHCODE',
    });
    expect(JSON.parse(response.body).message).toBe('That code is not valid');
  });

  it('grants a badge alongside the points', async () => {
    await authed('PUT', '/v1/gamification/badges/founder', {
      name: 'Founding Member',
      manualOnly: true,
      tiers: [{ level: 1, threshold: 1 }],
    });
    await authed('POST', '/v1/gamification/coupons', {
      code: 'FOUNDER',
      points: 100,
      grantBadgeKey: 'founder',
    });

    const contact = await contactFor('early@example.com');
    await authed('POST', '/v1/gamification/coupons/redeem', {
      contactId: contact,
      code: 'FOUNDER',
    });

    const { rows } = await db().query(
      `SELECT b.key FROM badge_awards a JOIN badges b ON b.id = a.badge_id
        WHERE a.contact_id = $1`,
      [contact],
    );
    expect(rows.map((row) => row.key)).toContain('founder');
  });
});

describe('badge and rank administration', () => {
  it('creates a badge with compound AND criteria', async () => {
    await authed('PUT', '/v1/gamification/badges/loyal', {
      name: 'Loyal',
      criteria: {
        type: 'compound',
        compare: 'and',
        requires: [
          { type: 'lifetime_points', threshold: 100 },
          { type: 'order_count', threshold: 2 },
        ],
      },
      tiers: [{ level: 1, threshold: 1 }],
      pointsPerTier: 25,
    });

    const contact = await contactFor('loyal@example.com');

    // One order: points yes, order count no — so the AND is not met.
    await authed('POST', '/v1/orders', {
      orderRef: 'l1', email: 'loyal@example.com',
      totalCents: 20_000, subtotalCents: 20_000,
    });
    let awards = await db().query(
      `SELECT 1 FROM badge_awards a JOIN badges b ON b.id = a.badge_id
        WHERE a.contact_id = $1 AND b.key = 'loyal'`,
      [contact],
    );
    expect(awards.rowCount).toBe(0);

    await authed('POST', '/v1/orders', {
      orderRef: 'l2', email: 'loyal@example.com',
      totalCents: 20_000, subtotalCents: 20_000,
    });
    awards = await db().query(
      `SELECT 1 FROM badge_awards a JOIN badges b ON b.id = a.badge_id
        WHERE a.contact_id = $1 AND b.key = 'loyal'`,
      [contact],
    );
    expect(awards.rowCount).toBe(1);
  });

  it('rejects tiers whose thresholds go backwards', async () => {
    const response = await authed('PUT', '/v1/gamification/badges/broken', {
      name: 'Broken',
      tiers: [
        { level: 1, threshold: 10 },
        { level: 2, threshold: 5 },
      ],
    });
    expect(response.statusCode).toBe(400);
  });

  it('pins a rank by hand and keeps it through a re-evaluation', async () => {
    await authed('PUT', '/v1/gamification/ranks/vip', {
      name: 'VIP',
      minPoints: 1_000_000,
      manualOnly: true,
    });
    const contact = await contactFor('friend@example.com');

    await authed('POST', '/v1/gamification/ranks/assign', {
      contactId: contact,
      rankKey: 'vip',
    });

    // Earning something would normally recompute the rank from points.
    await authed('POST', '/v1/rewards/trigger', {
      contactId: contact,
      ruleKey: 'review',
      refId: 'r1',
    });

    const { rows } = await db().query<{ key: string }>(
      `SELECT r.key FROM points_balances b JOIN ranks r ON r.id = b.current_rank_id
        WHERE b.contact_id = $1`,
      [contact],
    );
    expect(rows[0]?.key).toBe('vip');

    // Unpinning hands them back to the engine.
    await authed('POST', '/v1/gamification/ranks/unassign', { contactId: contact });
    const after = await db().query<{ key: string | null }>(
      `SELECT r.key FROM points_balances b LEFT JOIN ranks r ON r.id = b.current_rank_id
        WHERE b.contact_id = $1`,
      [contact],
    );
    expect(after.rows[0]?.key).not.toBe('vip');
  });

  it('revokes a badge without taking back the points by default', async () => {
    await authed('PUT', '/v1/gamification/badges/oops', {
      name: 'Oops',
      manualOnly: true,
      tiers: [{ level: 1, threshold: 1 }],
      pointsPerTier: 40,
    });
    const contact = await contactFor('mistake@example.com');

    await authed('POST', '/v1/gamification/badges/award', {
      contactId: contact,
      badgeKey: 'oops',
    });

    const revoked = await authed('POST', '/v1/gamification/badges/oops/revoke', {
      contactId: contact,
    });
    expect(JSON.parse(revoked.body).revoked).toBe(true);
    expect(JSON.parse(revoked.body).pointsReversed).toBe(0);
  });
});

describe('leaderboard windows', () => {
  it('reports the asking member position even outside the top rows', async () => {
    const people: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const contact = await contactFor(`player${i}@example.com`);
      people.push(contact);
      await authed('POST', '/v1/rewards/adjust', {
        contactId: contact,
        points: (4 - i) * 100,
        reason: 'seed',
        idempotencyKey: `seed-row-${i}`,
      });
    }

    const last = people[3]!;
    const board = JSON.parse(
      (await authed('GET', `/v1/rewards/leaderboard?limit=2&contactId=${last}`)).body,
    );
    expect(board.leaders).toHaveLength(2);
    expect(board.you.contact_id).toBe(last);
    expect(board.you.rank).toBe(4);
  });

  it('scopes a monthly board to the current month', async () => {
    const contact = await contactFor('monthly@example.com');
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact,
      points: 100,
      reason: 'seed',
      idempotencyKey: 'adj-m1',
    });

    // Backdate it out of the window.
    await db().query(
      `UPDATE points_ledger SET created_at = now() - interval '70 days' WHERE contact_id = $1`,
      [contact],
    );

    const monthly = JSON.parse((await authed('GET', '/v1/rewards/leaderboard?window=month')).body);
    expect(monthly.leaders).toHaveLength(0);

    const allTime = JSON.parse((await authed('GET', '/v1/rewards/leaderboard?window=all')).body);
    expect(allTime.leaders).toHaveLength(1);
  });
});

describe('ledger search and export', () => {
  it('filters by rule and direction across contacts', async () => {
    const a = await contactFor('a@example.com');
    const b = await contactFor('b@example.com');

    await authed('POST', '/v1/rewards/trigger', { contactId: a, ruleKey: 'review', refId: 'r1' });
    await authed('POST', '/v1/rewards/trigger', { contactId: b, ruleKey: 'review', refId: 'r2' });
    await authed('POST', '/v1/rewards/adjust', {
      contactId: a, points: -10, reason: 'correction', idempotencyKey: 'adj-c1',
    });

    const credits = JSON.parse(
      (await authed('GET', '/v1/rewards/ledger?ruleKey=review&direction=credit')).body,
    );
    expect(credits.total).toBe(2);

    const debits = JSON.parse((await authed('GET', '/v1/rewards/ledger?direction=debit')).body);
    expect(debits.total).toBe(1);
    expect(debits.entries[0].contact_email).toBe('a@example.com');
  });

  it('rejects an unparseable date rather than silently matching nothing', async () => {
    const response = await authed('GET', '/v1/rewards/ledger?from=last-tuesday');
    expect(response.statusCode).toBe(400);
  });

  it('exports CSV and neutralises a formula in the reason', async () => {
    const contact = await contactFor('csv@example.com');
    await authed('POST', '/v1/rewards/adjust', {
      contactId: contact,
      points: 10,
      reason: '=HYPERLINK("http://evil.test")',
      idempotencyKey: 'adj-csv-1',
    });

    const response = await authed('GET', '/v1/rewards/ledger.csv');
    expect(response.headers['content-type']).toContain('text/csv');
    // Prefixed with an apostrophe so a spreadsheet treats it as text.
    expect(response.body).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  });
});

describe('transfer limits', () => {
  it('refuses a transfer over the daily limit', async () => {
    await authed('PUT', '/v1/settings', { transferDailyLimit: 100 });

    const from = await contactFor('sender@example.com');
    const to = await contactFor('receiver@example.com');
    await authed('POST', '/v1/rewards/adjust', {
      contactId: from, points: 1000, reason: 'seed', idempotencyKey: 'adj-t-seed',
    });

    const first = await authed('POST', '/v1/gamification/transfer', {
      fromContactId: from, toContactId: to, points: 80,
    });
    expect(first.statusCode).toBe(200);

    const second = await authed('POST', '/v1/gamification/transfer', {
      fromContactId: from, toContactId: to, points: 80,
    });
    expect(second.statusCode).toBe(422);
    expect(JSON.parse(second.body).message).toContain('daily');
  });

  it('refuses a transfer below the minimum', async () => {
    await authed('PUT', '/v1/settings', { transferMinimum: 50 });
    const from = await contactFor('small@example.com');
    const to = await contactFor('dest@example.com');
    await authed('POST', '/v1/rewards/adjust', {
      contactId: from, points: 1000, reason: 'seed', idempotencyKey: 'adj-s-seed',
    });

    const response = await authed('POST', '/v1/gamification/transfer', {
      fromContactId: from, toContactId: to, points: 10,
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.parse(response.body).message).toContain('50');
  });
});
