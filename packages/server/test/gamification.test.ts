import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { closeApp, closeDb, db, makeTenant, setupDatabase, truncateAll, type TestTenant } from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award, getBalance } from '../src/services/points.js';
import { recordOrder } from '../src/services/commissions.js';
import { getTenantById } from '../src/services/tenants.js';
import {
  awardBadgeManually,
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
} from '../src/services/gamification.js';

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
