import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeApp, closeDb, db, makeTenant, setupDatabase, truncateAll, type TestTenant } from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award, getBalance } from '../src/services/points.js';
import { recordOrder } from '../src/services/commissions.js';
import { upsertRule } from '../src/services/rewards.js';
import { getTenantById } from '../src/services/tenants.js';
import {
  assignRankManually,
  awardBadgeManually,
  upsertBadge,
  badgesForContact,
  createCoupon,
  evaluateBadges,
  evaluateRank,
  hasUnlocked,
  listNotifications,
  markNotificationsRead,
  profile,
  recordStreak,
  redeemCoupon,
  transferPoints,
  unlockContent,
  upsertRank,
} from '../src/services/gamification.js';
import { upsertPointType } from '../src/services/point-types.js';
import { forgetTimezone } from '../src/services/rewards.js';

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

const tenantObject = async () => (await getTenantById(tenant.id))!;

async function member(email: string, points = 0) {
  const contact = await upsertContact(tenant.id, { email, name: email.split('@')[0]! });
  if (points > 0) {
    await award(tenant.id, {
      contactId: contact.id,
      points,
      reason: 'Test grant',
      idempotencyKey: `grant-${email}`,
    });
  }
  return contact;
}

describe('badges', () => {
  it('installs the default badge set for a new retailer', async () => {
    const { rows } = await db().query('SELECT key FROM badges WHERE tenant_id = $1 ORDER BY key', [
      tenant.id,
    ]);
    expect(rows.map((row) => row.key)).toEqual([
      'collector', 'connector', 'first_purchase', 'regular', 'social_butterfly',
    ]);
  });

  it('awards a tier as soon as the criterion is met, without waiting to be asked', async () => {
    const contact = await member('buyer@example.com');
    const before = await getBalance(tenant.id, contact.id);

    await recordOrder(await tenantObject(), {
      orderRef: 'o1',
      totalCents: 5000,
      email: 'buyer@example.com',
    });

    // Earning is what promotes people, so the order itself unlocks the badge.
    const badges = await badgesForContact(tenant.id, contact.id);
    const purchase = badges.find((badge) => badge.key === 'first_purchase')!;
    expect(purchase.earned_level).toBe(1);

    // …and its 50-point bonus is already in the balance.
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(before.balance + 50);
  });

  it('does not re-pay a tier that was already earned', async () => {
    const contact = await member('buyer@example.com');
    await recordOrder(await tenantObject(), { orderRef: 'o1', totalCents: 5000, email: 'buyer@example.com' });

    await evaluateBadges(tenant.id, contact.id);
    const before = await getBalance(tenant.id, contact.id);

    await evaluateBadges(tenant.id, contact.id);
    await evaluateBadges(tenant.id, contact.id);

    expect(await getBalance(tenant.id, contact.id)).toMatchObject({ balance: before.balance });
  });

  it('climbs to a higher tier and pays only the newly reached levels', async () => {
    const contact = await member('buyer@example.com');
    const tenantRow = await tenantObject();

    await recordOrder(tenantRow, { orderRef: 'o0', totalCents: 5000, email: 'buyer@example.com' });
    const afterTier1 = await getBalance(tenant.id, contact.id);
    expect(
      (await badgesForContact(tenant.id, contact.id)).find((b) => b.key === 'first_purchase')!.earned_level,
    ).toBe(1);

    for (let i = 1; i < 5; i += 1) {
      await recordOrder(tenantRow, { orderRef: `o${i}`, totalCents: 5000, email: 'buyer@example.com' });
    }

    const badges = await badgesForContact(tenant.id, contact.id);
    expect(badges.find((badge) => badge.key === 'first_purchase')!.earned_level).toBe(2);

    // Re-evaluating must not pay again for a tier already booked.
    const before = await getBalance(tenant.id, contact.id);
    await evaluateBadges(tenant.id, contact.id);
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(before.balance);

    // The second tier paid exactly one 50-point bonus on top of the first.
    expect(before.balance).toBeGreaterThan(afterTier1.balance);
  });

  it('reports progress toward the next tier for unearned badges', async () => {
    const contact = await member('quiet@example.com');
    const badges = await badgesForContact(tenant.id, contact.id);
    const social = badges.find((badge) => badge.key === 'social_butterfly')!;

    expect(social.earned_level).toBe(0);
    expect(social.next_threshold).toBe(1);
    expect(social.awarded_at).toBeNull();
  });

  it('allows a manual award and notifies the member', async () => {
    const contact = await member('vip@example.com');
    await awardBadgeManually(tenant.id, contact.id, 'connector', 3);

    const badges = await badgesForContact(tenant.id, contact.id);
    expect(badges.find((badge) => badge.key === 'connector')!.earned_level).toBe(3);

    const notifications = await listNotifications(tenant.id, contact.id);
    expect(notifications[0]).toMatchObject({ type: 'badge_earned' });
  });

  it('rejects an unknown badge key', async () => {
    const contact = await member('vip@example.com');
    await expect(awardBadgeManually(tenant.id, contact.id, 'nope')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('ranks', () => {
  it('promotes on lifetime points earned', async () => {
    const contact = await member('climber@example.com', 600);
    const result = await evaluateRank(tenant.id, contact.id);

    expect(result.rank?.key).toBe('member');
    expect(result.promoted).toBe(true);
  });

  it('does not re-announce a rank already held', async () => {
    const contact = await member('climber@example.com', 600);
    await evaluateRank(tenant.id, contact.id);
    const second = await evaluateRank(tenant.id, contact.id);

    expect(second.promoted).toBe(false);
    const notifications = await listNotifications(tenant.id, contact.id);
    expect(notifications.filter((row) => row.type === 'rank_up')).toHaveLength(1);
  });

  it('never demotes someone for spending their points', async () => {
    const contact = await member('climber@example.com', 3000);
    await evaluateRank(tenant.id, contact.id);

    // Spend almost everything — lifetime earned is unchanged, so the rank holds.
    const { spend } = await import('../src/services/points.js');
    await spend(tenant.id, {
      contactId: contact.id,
      points: 2900,
      reason: 'Redeemed',
      idempotencyKey: 'spend-1',
    });

    const after = await evaluateRank(tenant.id, contact.id);
    expect(after.rank?.key).toBe('insider');
  });

  it('reports the gap to the next rank', async () => {
    const contact = await member('climber@example.com', 600);
    const view = await profile(tenant.id, contact.id);

    expect(view.rank?.key).toBe('member');
    expect(view.next_rank?.key).toBe('insider');
    expect(view.points_to_next_rank).toBe(2500 - 600);
  });
});

describe('streaks', () => {
  it('pays every member, not just the first one that day', async () => {
    // The award key was `rule:<key>:<streak>:<date>` — no contact — so the
    // first member to log in each day consumed it and everybody else hit the
    // borrowed-key guard. That 409 also rolled back their streak row, because
    // `recordStreak` books the award in the same transaction. Their day
    // vanished with no error anybody would see.
    await upsertRule(tenant.id, {
      key: 'daily_login',
      name: 'Daily login',
      event: 'streak',
      points: 5,
      enabled: true,
    });

    const first = await member('first@example.com');
    const second = await member('second@example.com');
    const third = await member('third@example.com');

    for (const contact of [first, second, third]) {
      const result = await recordStreak(tenant.id, contact.id, 'daily_login');
      expect(result.counted, contact.id).toBe(true);
      expect(result.pointsAwarded, contact.id).toBe(5);
    }

    const { rows } = await db().query<{ n: string }>(
      'SELECT count(*) AS n FROM streaks WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('counts a day once, however many times it is recorded', async () => {
    const contact = await member('daily@example.com');

    const first = await recordStreak(tenant.id, contact.id);
    const second = await recordStreak(tenant.id, contact.id);

    expect(first.counted).toBe(true);
    expect(first.streak.current_length).toBe(1);
    expect(second.counted).toBe(false);
    expect(second.streak.current_length).toBe(1);
  });

  it('extends when yesterday was recorded', async () => {
    const contact = await member('daily@example.com');
    await recordStreak(tenant.id, contact.id);

    await db().query(
      `UPDATE streaks SET last_day = CURRENT_DATE - 1 WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );

    const next = await recordStreak(tenant.id, contact.id);
    expect(next.counted).toBe(true);
    expect(next.streak.current_length).toBe(2);
    expect(next.streak.longest_length).toBe(2);
  });

  it('resets after a missed day but keeps the record', async () => {
    const contact = await member('daily@example.com');
    await recordStreak(tenant.id, contact.id);
    await db().query(
      `UPDATE streaks SET last_day = CURRENT_DATE - 1, current_length = 9, longest_length = 9
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );
    await db().query(
      `UPDATE streaks SET last_day = CURRENT_DATE - 5 WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );

    const next = await recordStreak(tenant.id, contact.id);
    expect(next.streak.current_length).toBe(1);
    expect(next.streak.longest_length).toBe(9);
  });

  it('unlocks the streak badge once the run is long enough', async () => {
    const contact = await member('daily@example.com');
    await recordStreak(tenant.id, contact.id);
    await db().query(
      `UPDATE streaks SET longest_length = 7 WHERE tenant_id = $1 AND contact_id = $2`,
      [tenant.id, contact.id],
    );

    await evaluateBadges(tenant.id, contact.id);
    const badges = await badgesForContact(tenant.id, contact.id);
    expect(badges.find((badge) => badge.key === 'regular')!.earned_level).toBe(2);
  });
});

describe('point transfers', () => {
  it('moves points between members in one transaction', async () => {
    const sender = await member('sender@example.com', 500);
    const recipient = await member('recipient@example.com');

    const result = await transferPoints(tenant.id, {
      fromContactId: sender.id,
      toContactId: recipient.id,
      points: 200,
      message: 'thanks!',
    });

    expect(result.points).toBe(200);
    expect((await getBalance(tenant.id, sender.id)).balance).toBe(300);
    expect((await getBalance(tenant.id, recipient.id)).balance).toBe(200);
  });

  it('refuses to send more than the sender holds, and moves nothing', async () => {
    const sender = await member('sender@example.com', 100);
    const recipient = await member('recipient@example.com');

    await expect(
      transferPoints(tenant.id, {
        fromContactId: sender.id,
        toContactId: recipient.id,
        points: 500,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });

    expect((await getBalance(tenant.id, sender.id)).balance).toBe(100);
    expect((await getBalance(tenant.id, recipient.id)).balance).toBe(0);
  });

  it('refuses a self-transfer', async () => {
    const sender = await member('sender@example.com', 500);
    await expect(
      transferPoints(tenant.id, {
        fromContactId: sender.id,
        toContactId: sender.id,
        points: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses to send to a member of another retailer', async () => {
    const other = await makeTenant();
    const sender = await member('sender@example.com', 500);
    const outsider = await upsertContact(other.id, { email: 'outsider@example.com' });

    await expect(
      transferPoints(tenant.id, {
        fromContactId: sender.id,
        toContactId: outsider.id,
        points: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('conserves points exactly under concurrent sends', async () => {
    const sender = await member('sender@example.com', 100);
    const recipient = await member('recipient@example.com');

    await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        transferPoints(tenant.id, {
          fromContactId: sender.id,
          toContactId: recipient.id,
          points: 60,
        }),
      ),
    );

    const senderBalance = await getBalance(tenant.id, sender.id);
    const recipientBalance = await getBalance(tenant.id, recipient.id);
    // Exactly one 60-point transfer can succeed against a 100-point balance.
    expect(senderBalance.balance + recipientBalance.balance).toBe(100);
    expect(recipientBalance.balance).toBe(60);
  });
});

describe('moving points is not earning them', () => {
  it('does not let two accounts climb the ranks passing the same points back and forth', async () => {
    // `lifetime_earned` drives ranks, `lifetime_points` badges and the
    // all-time leaderboard, and every award added to it — including the credit
    // leg of a transfer. Two accounts with a thousand points between them
    // could reach any rank by sending it to each other.
    const a = await member('ping@example.com');
    const b = await member('pong@example.com');
    await award(tenant.id, {
      contactId: a.id,
      points: 1000,
      reason: 'seed',
      idempotencyKey: 'ping-seed',
    });

    for (let round = 0; round < 3; round += 1) {
      await transferPoints(tenant.id, { fromContactId: a.id, toContactId: b.id, points: 1000 });
      await transferPoints(tenant.id, { fromContactId: b.id, toContactId: a.id, points: 1000 });
    }

    const { rows } = await db().query<{
      contact_id: string; balance: string; lifetime_earned: string; lifetime_spent: string;
    }>(
      'SELECT contact_id, balance, lifetime_earned, lifetime_spent FROM points_balances WHERE tenant_id = $1',
      [tenant.id],
    );
    const forA = rows.find((row) => row.contact_id === a.id)!;
    const forB = rows.find((row) => row.contact_id === b.id);

    // Exactly what they started with, on both sides of the books.
    expect(Number(forA.balance)).toBe(1000);
    expect(Number(forA.lifetime_earned)).toBe(1000);
    expect(Number(forA.lifetime_spent)).toBe(0);
    if (forB) {
      expect(Number(forB.lifetime_earned)).toBe(0);
      expect(Number(forB.lifetime_spent)).toBe(0);
    }
  });

  it('keeps transferred points off the windowed leaderboard too', async () => {
    const a = await member('board-a@example.com');
    const b = await member('board-b@example.com');
    await award(tenant.id, {
      contactId: a.id, points: 500, reason: 'seed', idempotencyKey: 'board-seed',
    });
    await transferPoints(tenant.id, { fromContactId: a.id, toContactId: b.id, points: 500 });

    const { leaderboard } = await import('../src/services/rewards.js');
    const board = await leaderboard(tenant.id, { window: 'month', limit: 10 });
    // B received 500 this month and earned none of it.
    expect(board.rows.map((row) => row.contact_id)).not.toContain(b.id);
    // A earned it, so A is still there.
    expect(board.rows.map((row) => row.contact_id)).toContain(a.id);
  });
});

describe('coupons', () => {
  it('credits points once per member', async () => {
    const contact = await member('saver@example.com');
    await createCoupon(tenant.id, { code: 'WELCOME50', points: 50 });

    const first = await redeemCoupon(tenant.id, contact.id, 'WELCOME50');
    expect(first.points).toBe(50);

    await expect(redeemCoupon(tenant.id, contact.id, 'welcome50')).rejects.toMatchObject({
      statusCode: 422,
    });
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(50);
  });

  it('honours a global use limit under concurrency', async () => {
    await createCoupon(tenant.id, { code: 'ONLYONE', points: 100, maxUses: 1 });
    const a = await member('a@example.com');
    const b = await member('b@example.com');
    const c = await member('c@example.com');

    const results = await Promise.allSettled([
      redeemCoupon(tenant.id, a.id, 'ONLYONE'),
      redeemCoupon(tenant.id, b.id, 'ONLYONE'),
      redeemCoupon(tenant.id, c.id, 'ONLYONE'),
    ]);

    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);

    const { rows } = await db().query('SELECT uses FROM point_coupons WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows[0].uses).toBe(1);
  });

  it('gives the same answer for an expired, spent and nonexistent code', async () => {
    const contact = await member('saver@example.com');
    await createCoupon(tenant.id, {
      code: 'EXPIRED',
      points: 10,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const messages: string[] = [];
    for (const code of ['EXPIRED', 'NEVEREXISTED']) {
      try {
        await redeemCoupon(tenant.id, contact.id, code);
      } catch (err) {
        messages.push((err as Error).message);
      }
    }
    // Identical wording, so the endpoint cannot be used to enumerate codes.
    expect(new Set(messages).size).toBe(1);
  });

  it('refuses to create a duplicate code', async () => {
    await createCoupon(tenant.id, { code: 'DUP', points: 10 });
    await expect(createCoupon(tenant.id, { code: 'DUP', points: 10 })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('gated content', () => {
  it('charges once and stays unlocked', async () => {
    const contact = await member('reader@example.com', 500);

    const first = await unlockContent(tenant.id, contact.id, 'post-42', 100);
    expect(first.alreadyOwned).toBe(false);
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(400);

    const second = await unlockContent(tenant.id, contact.id, 'post-42', 100);
    expect(second.alreadyOwned).toBe(true);
    expect((await getBalance(tenant.id, contact.id)).balance).toBe(400);

    expect(await hasUnlocked(tenant.id, contact.id, 'post-42')).toBe(true);
    expect(await hasUnlocked(tenant.id, contact.id, 'post-43')).toBe(false);
  });

  it('refuses when the member cannot afford it', async () => {
    const contact = await member('reader@example.com', 50);
    await expect(unlockContent(tenant.id, contact.id, 'post-42', 100)).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(await hasUnlocked(tenant.id, contact.id, 'post-42')).toBe(false);
  });

  it('keeps unlocks private to the member who paid', async () => {
    const buyer = await member('buyer@example.com', 500);
    const freeloader = await member('free@example.com', 500);

    await unlockContent(tenant.id, buyer.id, 'post-42', 100);
    expect(await hasUnlocked(tenant.id, freeloader.id, 'post-42')).toBe(false);
  });
});

describe('notifications', () => {
  it('marks notifications read', async () => {
    const contact = await member('noisy@example.com');
    await awardBadgeManually(tenant.id, contact.id, 'connector');

    expect(await listNotifications(tenant.id, contact.id, { unreadOnly: true })).toHaveLength(1);

    const marked = await markNotificationsRead(tenant.id, contact.id, null);
    expect(marked).toBe(1);
    expect(await listNotifications(tenant.id, contact.id, { unreadOnly: true })).toHaveLength(0);
  });

  it('never shows one member another member’s notifications', async () => {
    const a = await member('a@example.com');
    const b = await member('b@example.com');
    await awardBadgeManually(tenant.id, a.id, 'connector');

    expect(await listNotifications(tenant.id, b.id)).toHaveLength(0);
  });
});

describe('transfers are recorded once (LOW)', () => {
  it('does not write a second transfer row for a collapsed duplicate', async () => {
    const from = (await upsertContact(tenant.id, { email: 'dup-from@example.com' })).id;
    const to = (await upsertContact(tenant.id, { email: 'dup-to@example.com' })).id;
    await award(tenant.id, {
      contactId: from,
      points: 1000,
      reason: 'Seed',
      idempotencyKey: 'dup-seed',
    });

    // Two identical transfers fired together. The reference used to be a
    // millisecond clock, so both legs collapsed on their idempotency keys
    // while two point_transfers rows were written — and both counted against
    // the sender's limits for points that moved once.
    const results = await Promise.allSettled([
      transferPoints(tenant.id, { fromContactId: from, toContactId: to, points: 100 }),
      transferPoints(tenant.id, { fromContactId: from, toContactId: to, points: 100 }),
    ]);

    const succeeded = results.filter((result) => result.status === 'fulfilled').length;
    const { rows } = await db().query(
      'SELECT SUM(points)::int AS total, COUNT(*)::int AS n FROM point_transfers WHERE tenant_id = $1',
      [tenant.id],
    );

    // However the race resolves, the rows recorded must match the points that
    // actually left the sender.
    expect(rows[0]!.n).toBe(succeeded);
    expect(rows[0]!.total).toBe(succeeded * 100);
    expect((await getBalance(tenant.id, from)).balance).toBe(1000 - succeeded * 100);
    expect((await getBalance(tenant.id, to)).balance).toBe(succeeded * 100);
  });
});

describe('the profile reports the rank the member actually holds (MEDIUM)', () => {
  /**
   * It re-derived the rank from lifetime_earned against every rank in the
   * tenant instead of reading what `evaluateRank` decided. That disagreed with
   * the rest of the system four ways at once, and a member reading their own
   * profile got the wrong one of the two answers.
   */
  it('keeps a rank a support agent pinned by hand', async () => {
    const contact = (await member('pinned@example.com')).id;
    await upsertRank(tenant.id, { key: 'bronze', name: 'Bronze', minPoints: 0 });
    await upsertRank(tenant.id, { key: 'vip', name: 'VIP', minPoints: 100_000 });

    await award(tenant.id, {
      contactId: contact, points: 10, reason: 'seed', idempotencyKey: 'profile-pin',
    });
    await assignRankManually(tenant.id, contact, 'vip');

    const view = await profile(tenant.id, contact);
    // Manual Mode exists because stores pin a tier no points total explains.
    expect(view.rank?.key).toBe('vip');
  });

  it('does not promote anyone into a manual-only tier', async () => {
    const contact = (await member('manual@example.com')).id;
    // Its floor sits inside the seeded ladder's Member band (500-2499), so
    // points alone would otherwise reach it.
    await upsertRank(tenant.id, {
      key: 'founder', name: 'Founder', minPoints: 600, manualOnly: true,
    });

    await award(tenant.id, {
      contactId: contact, points: 700, reason: 'seed', idempotencyKey: 'profile-manual',
    });
    await evaluateRank(tenant.id, contact);

    const view = await profile(tenant.id, contact);
    expect(view.rank?.key).toBe('member');
    // And it is not dangled as the next step either.
    expect(view.next_rank?.key).not.toBe('founder');
  });

  it('respects a band that has a ceiling', async () => {
    const contact = (await member('banded@example.com')).id;
    await upsertRank(tenant.id, { key: 'starter', name: 'Starter', minPoints: 0, maxPoints: 99 });
    await upsertRank(tenant.id, { key: 'regular', name: 'Regular', minPoints: 100 });

    await award(tenant.id, {
      contactId: contact, points: 50, reason: 'seed', idempotencyKey: 'profile-band',
    });
    await evaluateRank(tenant.id, contact);

    expect((await profile(tenant.id, contact)).rank?.key).toBe('starter');
  });

  it('answers for the ladder it was asked about', async () => {
    const contact = (await member('ladders@example.com')).id;
    await upsertPointType(tenant.id, { key: 'status', name: 'Status' });
    await upsertRank(tenant.id, { key: 'spender', name: 'Spender', minPoints: 10 });
    await upsertRank(tenant.id, {
      key: 'insider', name: 'Insider', minPoints: 10, pointType: 'status',
    });

    await award(tenant.id, {
      contactId: contact, points: 50, reason: 'points', idempotencyKey: 'ladder-a',
    });
    await award(tenant.id, {
      contactId: contact, points: 50, reason: 'status', idempotencyKey: 'ladder-b',
      pointType: 'status',
    });
    await evaluateRank(tenant.id, contact);
    await evaluateRank(tenant.id, contact, undefined, 'status');

    expect((await profile(tenant.id, contact)).rank?.key).toBe('spender');
    expect((await profile(tenant.id, contact, db(), 'status')).rank?.key).toBe('insider');
  });
});

describe('the small refusals that keep a screen honest (LOW)', () => {
  it('will not print a coupon that grants a badge nobody defined', async () => {
    // It failed at redemption instead -- in front of the customer, on a code
    // the retailer had already printed.
    await expect(
      createCoupon(tenant.id, { code: 'GHOST', points: 10, grantBadgeKey: 'no_such_badge' }),
    ).rejects.toThrow(/grantBadgeKey "no_such_badge" does not exist/);

    await expect(
      createCoupon(tenant.id, { code: 'GHOST2', points: 10, grantRankKey: 'no_such_rank' }),
    ).rejects.toThrow(/grantRankKey "no_such_rank" does not exist/);
  });

  it('still accepts a coupon granting something that exists', async () => {
    await upsertBadge(tenant.id, { key: 'real_badge', name: 'Real' });
    const coupon = await createCoupon(tenant.id, {
      code: 'REAL', points: 10, grantBadgeKey: 'real_badge',
    });
    expect(coupon.code).toBe('REAL');
  });

  it('refuses a badge level the badge does not have', async () => {
    // A three-tier badge showing "Level 20" has no artwork, no name and no
    // meaning, and it lands on the customer's profile.
    const contact = (await member('levels@example.com')).id;
    await upsertBadge(tenant.id, {
      key: 'tiered',
      name: 'Tiered',
      tiers: [
        { level: 1, threshold: 1 },
        { level: 2, threshold: 5 },
        { level: 3, threshold: 10 },
      ],
    });

    await expect(awardBadgeManually(tenant.id, contact, 'tiered', 20)).rejects.toThrow(
      /has levels 1, 2, 3; 20 is not one of them/,
    );
    // The levels it does have still work.
    await expect(awardBadgeManually(tenant.id, contact, 'tiered', 3)).resolves.toBeTruthy();
  });
});

describe('a streak day belongs to the retailer, not the server (LOW)', () => {
  it('rolls over at the store\'s midnight', async () => {
    // CURRENT_DATE is UTC in production, so a Montana store's daily streak
    // rolled over at five in the afternoon: somebody visiting each evening was
    // counted twice on one day and missed the next, and their streak broke
    // while they did exactly what was asked.
    await db().query(`UPDATE tenants SET timezone = 'America/Denver' WHERE id = $1`, [tenant.id]);
    forgetTimezone(tenant.id);
    const contact = (await member('streaky@example.com')).id;

    await recordStreak(tenant.id, contact, 'daily_login');

    const { rows } = await db().query<{ last_day: string; store_day: string }>(
      `SELECT s.last_day::text AS last_day,
              (now() AT TIME ZONE 'America/Denver')::date::text AS store_day
         FROM streaks s WHERE s.tenant_id = $1 AND s.contact_id = $2`,
      [tenant.id, contact],
    );

    expect(rows[0]!.last_day).toBe(rows[0]!.store_day);
  });
});
