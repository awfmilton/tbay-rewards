import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  truncateAll,
  TEST_WALLET,
  verifyWalletFor,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { getTenantById } from '../src/services/tenants.js';
import {
  award,
  getBalance,
  getBalances,
  listLedger,
  reverse,
  spend,
} from '../src/services/points.js';
import {
  deletePointType,
  listPointTypes,
  resolvePointType,
  upsertPointType,
} from '../src/services/point-types.js';
import {
  assignRankManually,
  createCoupon,
  evaluateRank,
  redeemCoupon,
  transferPoints,
  unpinRank,
  upsertRank,
} from '../src/services/gamification.js';
import { leaderboard, trigger, upsertRule } from '../src/services/rewards.js';
import { redeemPointsForCredit, redeemPointsForTokens } from '../src/services/token.js';

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

const contact = async (email: string) =>
  (await upsertContact(tenant.id, { email })).id;

/** The classic second currency: status you accumulate and can never cash out. */
async function makeStatusCurrency() {
  return upsertPointType(tenant.id, {
    key: 'status',
    name: 'Status Credits',
    singular: 'status credit',
    plural: 'status credits',
    convertible: false,
    transferable: false,
  });
}

describe('the default currency', () => {
  it('is installed with the tenant and is the one everything falls back to', async () => {
    const types = await listPointTypes(tenant.id);
    expect(types).toHaveLength(1);
    expect(types[0]!.key).toBe('points');
    expect(types[0]!.is_default).toBe(true);

    const id = await contact('default@example.com');
    const result = await award(tenant.id, {
      contactId: id,
      points: 50,
      reason: 'No type named',
      idempotencyKey: 'default-1',
    });

    expect(result.entry.point_type).toBe('points');
    expect(result.balance.point_type).toBe('points');
  });

  it('refuses an unknown key rather than quietly paying the default', async () => {
    const id = await contact('unknown@example.com');
    await expect(
      award(tenant.id, {
        contactId: id,
        points: 10,
        reason: 'Typo',
        idempotencyKey: 'unknown-1',
        pointType: 'poitns',
      }),
    ).rejects.toThrow(/Unknown point type/);

    // And nothing was written under any currency.
    const balances = await getBalances(tenant.id, id);
    expect(balances.every((balance) => balance.balance === 0)).toBe(true);
  });

  it('refuses a currency that has been turned off', async () => {
    await upsertPointType(tenant.id, { key: 'legacy', name: 'Legacy', enabled: false });
    await expect(resolvePointType(tenant.id, 'legacy')).rejects.toThrow(/turned off/);
  });
});

describe('balances are separate per currency', () => {
  it('keeps two currencies from touching each other', async () => {
    await makeStatusCurrency();
    const id = await contact('two@example.com');

    await award(tenant.id, {
      contactId: id,
      points: 100,
      reason: 'Spend',
      idempotencyKey: 'sep-points',
    });
    await award(tenant.id, {
      contactId: id,
      points: 40,
      reason: 'Status',
      idempotencyKey: 'sep-status',
      pointType: 'status',
    });

    expect((await getBalance(tenant.id, id)).balance).toBe(100);
    expect((await getBalance(tenant.id, id, undefined, 'status')).balance).toBe(40);

    const all = await getBalances(tenant.id, id);
    expect(all.map((balance) => [balance.point_type, balance.balance]).sort()).toEqual([
      ['points', 100],
      ['status', 40],
    ]);
  });

  it('will not let a spend in one currency draw on another', async () => {
    await makeStatusCurrency();
    const id = await contact('nodraw@example.com');

    await award(tenant.id, {
      contactId: id,
      points: 500,
      reason: 'Plenty of points',
      idempotencyKey: 'nodraw-points',
    });

    // 500 points sitting there, but zero status: this must fail.
    await expect(
      spend(tenant.id, {
        contactId: id,
        points: 10,
        reason: 'Spending status I do not have',
        idempotencyKey: 'nodraw-spend',
        pointType: 'status',
      }),
    ).rejects.toThrow();

    expect((await getBalance(tenant.id, id)).balance).toBe(500);
  });

  it('shows every enabled currency even when nothing has been earned in it', async () => {
    await makeStatusCurrency();
    const id = await contact('empty@example.com');

    const all = await getBalances(tenant.id, id);
    expect(all).toHaveLength(2);
    expect(all.map((balance) => balance.point_type).sort()).toEqual(['points', 'status']);
  });

  it('unwinds a reversal against the currency the entry was in', async () => {
    await makeStatusCurrency();
    const id = await contact('reverse@example.com');

    await award(tenant.id, {
      contactId: id,
      points: 60,
      reason: 'Points',
      idempotencyKey: 'rev-points',
    });
    const statusAward = await award(tenant.id, {
      contactId: id,
      points: 25,
      reason: 'Status',
      idempotencyKey: 'rev-status',
      pointType: 'status',
    });

    await reverse(tenant.id, statusAward.entry.id, 'Mistake');

    expect((await getBalance(tenant.id, id)).balance).toBe(60);
    const status = await getBalance(tenant.id, id, undefined, 'status');
    expect(status.balance).toBe(0);
    expect(status.lifetime_earned).toBe(0);
  });

  it('filters the ledger by currency', async () => {
    await makeStatusCurrency();
    const id = await contact('ledger@example.com');

    await award(tenant.id, {
      contactId: id,
      points: 10,
      reason: 'A',
      idempotencyKey: 'led-a',
    });
    await award(tenant.id, {
      contactId: id,
      points: 20,
      reason: 'B',
      idempotencyKey: 'led-b',
      pointType: 'status',
    });

    expect(await listLedger(tenant.id, id, 50)).toHaveLength(2);
    const statusOnly = await listLedger(tenant.id, id, 50, undefined, 'status');
    expect(statusOnly).toHaveLength(1);
    expect(statusOnly[0]!.reason).toBe('B');
  });
});

describe('convertible and transferable are properties of the currency', () => {
  it('refuses to turn a non-convertible currency into store credit', async () => {
    await makeStatusCurrency();
    const id = await contact('credit@example.com');
    await award(tenant.id, {
      contactId: id,
      points: 10_000,
      reason: 'Status',
      idempotencyKey: 'credit-status',
      pointType: 'status',
    });

    const tenantRow = (await getTenantById(tenant.id))!;
    await expect(
      redeemPointsForCredit(tenantRow, id, 1000, undefined, 'status'),
    ).rejects.toThrow(/cannot be exchanged/);

    // The balance is untouched: the refusal happens before anything is spent.
    expect((await getBalance(tenant.id, id, undefined, 'status')).balance).toBe(10_000);
  });

  it('refuses to turn a non-convertible currency into TBAY', async () => {
    await makeStatusCurrency();
    const id = await contact('tbay@example.com');
    await award(tenant.id, {
      contactId: id,
      points: 100_000,
      reason: 'Status',
      idempotencyKey: 'tbay-status',
      pointType: 'status',
    });
    const wallet = await verifyWalletFor(tenant.id, id, TEST_WALLET);

    const tenantRow = (await getTenantById(tenant.id))!;
    const contactRow = { id, member_id: null } as never;

    await expect(
      redeemPointsForTokens(tenantRow, {
        contact: contactRow,
        points: 10_000,
        walletAddress: wallet,
        pointType: 'status',
      }),
    ).rejects.toThrow(/cannot be exchanged/);

    expect((await getBalance(tenant.id, id, undefined, 'status')).balance).toBe(100_000);
  });

  it('refuses to send a non-transferable currency to another member', async () => {
    await makeStatusCurrency();
    const from = await contact('sender@example.com');
    const to = await contact('recipient@example.com');

    await award(tenant.id, {
      contactId: from,
      points: 5_000,
      reason: 'Status',
      idempotencyKey: 'xfer-status',
      pointType: 'status',
    });

    await expect(
      transferPoints(tenant.id, {
        fromContactId: from,
        toContactId: to,
        points: 100,
        pointType: 'status',
      }),
    ).rejects.toThrow(/cannot be sent/);

    expect((await getBalance(tenant.id, from, undefined, 'status')).balance).toBe(5_000);
    expect((await getBalance(tenant.id, to, undefined, 'status')).balance).toBe(0);
  });

  it('still sends a currency that is marked transferable', async () => {
    await upsertPointType(tenant.id, {
      key: 'gift',
      name: 'Gift Points',
      convertible: false,
      transferable: true,
    });
    const from = await contact('gifter@example.com');
    const to = await contact('giftee@example.com');

    await award(tenant.id, {
      contactId: from,
      points: 5_000,
      reason: 'Gift points',
      idempotencyKey: 'gift-seed',
      pointType: 'gift',
    });

    await transferPoints(tenant.id, {
      fromContactId: from,
      toContactId: to,
      points: 300,
      pointType: 'gift',
    });

    expect((await getBalance(tenant.id, from, undefined, 'gift')).balance).toBe(4_700);
    expect((await getBalance(tenant.id, to, undefined, 'gift')).balance).toBe(300);
    // The default currency saw none of it.
    expect((await getBalance(tenant.id, from)).balance).toBe(0);
  });
});

describe('reward rules pay their own currency', () => {
  it('books a rule award against the rule’s currency', async () => {
    await makeStatusCurrency();
    await upsertRule(tenant.id, {
      key: 'status_visit',
      name: 'Status for visiting',
      event_key: 'custom.status_visit',
      mode: 'fixed',
      points: 15,
      point_type: 'status',
    });

    const id = await contact('rule@example.com');
    const outcome = await trigger(tenant.id, {
      contactId: id,
      ruleKey: 'status_visit',
      refId: 'visit-1',
    });

    expect(outcome.awarded).toBe(true);
    expect((await getBalance(tenant.id, id, undefined, 'status')).balance).toBe(15);
    expect((await getBalance(tenant.id, id)).balance).toBe(0);
  });

  it('keeps a rule’s currency when an edit does not mention one', async () => {
    await makeStatusCurrency();
    await upsertRule(tenant.id, {
      key: 'status_visit',
      name: 'Status for visiting',
      point_type: 'status',
    });

    // The admin screen renames it and says nothing about currencies. Without
    // care this resolves to the tenant default and silently moves the rule.
    const renamed = await upsertRule(tenant.id, {
      key: 'status_visit',
      name: 'Status for showing up',
    });

    expect(renamed.point_type).toBe('status');
  });

  it('refuses a rule that pays a currency the retailer does not have', async () => {
    await expect(
      upsertRule(tenant.id, { key: 'bad_rule', point_type: 'nope' }),
    ).rejects.toThrow(/Unknown point type/);
  });
});

describe('ranks are a ladder per currency', () => {
  it('lets a member hold a rank on each ladder independently', async () => {
    await makeStatusCurrency();
    await upsertRank(tenant.id, { key: 'spender', name: 'Spender', minPoints: 100 });
    await upsertRank(tenant.id, {
      key: 'insider',
      name: 'Insider',
      minPoints: 50,
      pointType: 'status',
    });

    const id = await contact('ladders@example.com');
    await award(tenant.id, {
      contactId: id,
      points: 120,
      reason: 'Points',
      idempotencyKey: 'ladder-points',
    });
    await award(tenant.id, {
      contactId: id,
      points: 60,
      reason: 'Status',
      idempotencyKey: 'ladder-status',
      pointType: 'status',
    });

    const onPoints = await evaluateRank(tenant.id, id);
    const onStatus = await evaluateRank(tenant.id, id, undefined, 'status');

    expect(onPoints.rank?.key).toBe('spender');
    expect(onStatus.rank?.key).toBe('insider');
  });

  it('does not reach a status rank by earning spendable points', async () => {
    await makeStatusCurrency();
    await upsertRank(tenant.id, {
      key: 'insider',
      name: 'Insider',
      minPoints: 50,
      pointType: 'status',
    });

    const id = await contact('wrongladder@example.com');
    await award(tenant.id, {
      contactId: id,
      points: 5_000,
      reason: 'A lot of spendable points',
      idempotencyKey: 'wrong-ladder',
    });

    const result = await evaluateRank(tenant.id, id, undefined, 'status');
    expect(result.rank).toBeNull();
  });

  it('pins one ladder without freezing the other', async () => {
    await makeStatusCurrency();
    await upsertRank(tenant.id, { key: 'bronze', name: 'Bronze', minPoints: 0 });
    await upsertRank(tenant.id, { key: 'gold', name: 'Gold', minPoints: 1_000 });
    await upsertRank(tenant.id, { key: 'vip', name: 'VIP', minPoints: 0, manualOnly: true });
    await upsertRank(tenant.id, {
      key: 'insider',
      name: 'Insider',
      minPoints: 10,
      pointType: 'status',
    });

    const id = await contact('pin@example.com');
    await assignRankManually(tenant.id, id, 'vip');

    // The pin is on the points ladder: more points must not dislodge it.
    await award(tenant.id, {
      contactId: id,
      points: 5_000,
      reason: 'Points',
      idempotencyKey: 'pin-points',
    });
    expect((await evaluateRank(tenant.id, id)).rank?.key).toBe('vip');

    // The status ladder is untouched by that pin and still moves.
    await award(tenant.id, {
      contactId: id,
      points: 20,
      reason: 'Status',
      idempotencyKey: 'pin-status',
      pointType: 'status',
    });
    expect((await evaluateRank(tenant.id, id, undefined, 'status')).rank?.key).toBe('insider');

    // Releasing the points ladder re-evaluates only that one.
    const released = await unpinRank(tenant.id, id);
    expect(released.rank?.key).toBe('gold');
    expect((await evaluateRank(tenant.id, id, undefined, 'status')).rank?.key).toBe('insider');
  });
});

describe('leaderboards, coupons and deletion', () => {
  it('ranks each currency on its own board', async () => {
    await makeStatusCurrency();
    const alice = await contact('alice@example.com');
    const bob = await contact('bob@example.com');

    await award(tenant.id, {
      contactId: alice,
      points: 900,
      reason: 'Points',
      idempotencyKey: 'board-alice-points',
    });
    await award(tenant.id, {
      contactId: bob,
      points: 10,
      reason: 'Points',
      idempotencyKey: 'board-bob-points',
    });
    await award(tenant.id, {
      contactId: bob,
      points: 700,
      reason: 'Status',
      idempotencyKey: 'board-bob-status',
      pointType: 'status',
    });

    const points = await leaderboard(tenant.id, {});
    expect(points.point_type).toBe('points');
    expect(points.rows[0]!.contact_id).toBe(alice);

    const status = await leaderboard(tenant.id, { pointType: 'status' });
    expect(status.point_type).toBe('status');
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0]!.contact_id).toBe(bob);
    expect(status.rows[0]!.points).toBe(700);
  });

  it('pays a coupon in the currency it was created with', async () => {
    await makeStatusCurrency();
    await createCoupon(tenant.id, {
      code: 'STATUS100',
      points: 100,
      pointType: 'status',
    });

    const id = await contact('coupon@example.com');
    await redeemCoupon(tenant.id, id, 'STATUS100');

    expect((await getBalance(tenant.id, id, undefined, 'status')).balance).toBe(100);
    expect((await getBalance(tenant.id, id)).balance).toBe(0);
  });

  it('refuses to delete a currency members still hold', async () => {
    await makeStatusCurrency();
    const id = await contact('holder@example.com');
    await award(tenant.id, {
      contactId: id,
      points: 5,
      reason: 'Status',
      idempotencyKey: 'delete-status',
      pointType: 'status',
    });

    await expect(deletePointType(tenant.id, 'status')).rejects.toThrow(/still hold/);

    // Zeroed out, it can go.
    await spend(tenant.id, {
      contactId: id,
      points: 5,
      reason: 'Cleared',
      idempotencyKey: 'delete-clear',
      pointType: 'status',
    });
    expect(await deletePointType(tenant.id, 'status')).toBe(true);
  });

  it('never deletes the default currency', async () => {
    await expect(deletePointType(tenant.id, 'points')).rejects.toThrow(/default currency/);
  });

  it('moves the default without ever leaving two', async () => {
    await makeStatusCurrency();
    await upsertPointType(tenant.id, { key: 'status', isDefault: true });

    const types = await listPointTypes(tenant.id);
    expect(types.filter((type) => type.is_default).map((type) => type.key)).toEqual(['status']);

    // And the database refuses a second one even if code tried.
    await expect(
      db().query('UPDATE point_types SET is_default = true WHERE tenant_id = $1', [tenant.id]),
    ).rejects.toThrow();
  });
});
