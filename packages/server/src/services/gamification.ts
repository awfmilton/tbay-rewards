import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { award, getBalance, spend, type Balance } from './points.js';
import { trigger } from './rewards.js';

/**
 * The myCred feature set, rebuilt on the platform's own ledger: badges with
 * tiers, balance ranks, streaks, member-to-member transfers, coupon codes and
 * points-gated content.
 *
 * Everything that moves points goes through points.ts, so gamification can
 * never create points behind the ledger's back.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Badges
// ─────────────────────────────────────────────────────────────────────────────

export interface BadgeTier {
  level: number;
  threshold: number;
  label?: string;
  image_url?: string;
}

export type BadgeCriteria =
  | { type: 'rule_count'; rule_key: string }
  | { type: 'rule_points'; rule_key: string }
  | { type: 'lifetime_points' }
  | { type: 'order_count' }
  | { type: 'referral_count' }
  | { type: 'share_count' }
  | { type: 'streak'; streak_key: string }
  | { type: 'manual' };

export interface Badge {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  image_url: string | null;
  criteria: BadgeCriteria;
  tiers: BadgeTier[];
  points_per_tier: number;
  manual_only: boolean;
  display_order: number;
  enabled: boolean;
}

export interface BadgeAward {
  badge_id: string;
  contact_id: string;
  level: number;
  progress: number;
  awarded_at: Date;
}

/** Badge and rank sets a new retailer starts with. */
export const DEFAULT_BADGES: Array<Partial<Badge> & { key: string; name: string }> = [
  {
    key: 'first_purchase',
    name: 'First Purchase',
    description: 'Made your first order.',
    criteria: { type: 'order_count' },
    tiers: [
      { level: 1, threshold: 1, label: 'Bronze' },
      { level: 2, threshold: 5, label: 'Silver' },
      { level: 3, threshold: 25, label: 'Gold' },
    ],
    points_per_tier: 50,
  },
  {
    key: 'social_butterfly',
    name: 'Social Butterfly',
    description: 'Shared us where people actually clicked.',
    criteria: { type: 'share_count' },
    tiers: [
      { level: 1, threshold: 1, label: 'Bronze' },
      { level: 2, threshold: 10, label: 'Silver' },
      { level: 3, threshold: 50, label: 'Gold' },
    ],
    points_per_tier: 25,
  },
  {
    key: 'connector',
    name: 'Connector',
    description: 'Referred customers who bought.',
    criteria: { type: 'referral_count' },
    tiers: [
      { level: 1, threshold: 1, label: 'Bronze' },
      { level: 2, threshold: 5, label: 'Silver' },
      { level: 3, threshold: 20, label: 'Gold' },
    ],
    points_per_tier: 100,
  },
  {
    key: 'regular',
    name: 'Regular',
    description: 'Visited day after day.',
    criteria: { type: 'streak', streak_key: 'daily_login' },
    tiers: [
      { level: 1, threshold: 3, label: '3 days' },
      { level: 2, threshold: 7, label: 'A week' },
      { level: 3, threshold: 30, label: 'A month' },
    ],
    points_per_tier: 30,
  },
  {
    key: 'collector',
    name: 'Collector',
    description: 'Earned points across the board.',
    criteria: { type: 'lifetime_points' },
    tiers: [
      { level: 1, threshold: 500, label: 'Bronze' },
      { level: 2, threshold: 2500, label: 'Silver' },
      { level: 3, threshold: 10_000, label: 'Gold' },
    ],
    points_per_tier: 0,
  },
];

export const DEFAULT_RANKS: Array<{ key: string; name: string; min_points: number; max_points: number | null; description: string }> = [
  { key: 'newcomer', name: 'Newcomer', min_points: 0, max_points: 499, description: 'Just getting started.' },
  { key: 'member', name: 'Member', min_points: 500, max_points: 2499, description: 'A familiar face.' },
  { key: 'insider', name: 'Insider', min_points: 2500, max_points: 9999, description: 'You know the place well.' },
  { key: 'champion', name: 'Champion', min_points: 10_000, max_points: 49_999, description: 'One of our best.' },
  { key: 'legend', name: 'Legend', min_points: 50_000, max_points: null, description: 'In a league of your own.' },
];

export async function installDefaultGamification(
  tenantId: string,
  runner: Queryable = db(),
): Promise<void> {
  for (const [index, badge] of DEFAULT_BADGES.entries()) {
    await runner.query(
      `INSERT INTO badges (tenant_id, key, name, description, criteria, tiers, points_per_tier, display_order)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [
        tenantId,
        badge.key,
        badge.name,
        badge.description ?? '',
        JSON.stringify(badge.criteria ?? { type: 'manual' }),
        JSON.stringify(badge.tiers ?? []),
        badge.points_per_tier ?? 0,
        index,
      ],
    );
  }

  for (const [index, rank] of DEFAULT_RANKS.entries()) {
    await runner.query(
      `INSERT INTO ranks (tenant_id, key, name, description, min_points, max_points, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [tenantId, rank.key, rank.name, rank.description, rank.min_points, rank.max_points, index],
    );
  }
}

export async function listBadges(tenantId: string, runner: Queryable = db()): Promise<Badge[]> {
  const { rows } = await runner.query<Badge>(
    'SELECT * FROM badges WHERE tenant_id = $1 ORDER BY display_order, key',
    [tenantId],
  );
  return rows;
}

export interface BadgeWithProgress extends Badge {
  earned_level: number;
  progress: number;
  next_threshold: number | null;
  awarded_at: Date | null;
}

/** Every badge with this member's standing against it — earned or not. */
export async function badgesForContact(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<BadgeWithProgress[]> {
  const badges = await listBadges(tenantId, runner);
  const { rows: awards } = await runner.query<BadgeAward>(
    'SELECT * FROM badge_awards WHERE tenant_id = $1 AND contact_id = $2',
    [tenantId, contactId],
  );
  const byBadge = new Map(awards.map((row) => [row.badge_id, row]));

  return badges
    .filter((badge) => badge.enabled)
    .map((badge) => {
      const award = byBadge.get(badge.id);
      const level = award?.level ?? 0;
      const next = badge.tiers.find((tier) => tier.level === level + 1);
      return {
        ...badge,
        earned_level: level,
        progress: award?.progress ?? 0,
        next_threshold: next?.threshold ?? null,
        awarded_at: award?.awarded_at ?? null,
      };
    });
}

/**
 * Re-evaluate every automatic badge for one member.
 *
 * Idempotent: a badge only moves up, never down, and each newly reached tier
 * books its bonus points exactly once through a tier-specific idempotency key.
 */
export async function evaluateBadges(
  tenantId: string,
  contactId: string,
  runner?: Queryable,
): Promise<Array<{ badge: Badge; level: number; pointsAwarded: number }>> {
  const run = async (client: Queryable) => {
    const badges = (await listBadges(tenantId, client)).filter(
      (badge) => badge.enabled && !badge.manual_only && badge.criteria?.type !== 'manual',
    );
    const earned: Array<{ badge: Badge; level: number; pointsAwarded: number }> = [];

    for (const badge of badges) {
      const progress = await measureCriteria(client, tenantId, contactId, badge.criteria);
      const tiers = [...(badge.tiers ?? [])].sort((a, b) => a.level - b.level);
      let level = 0;
      for (const tier of tiers) {
        if (progress >= tier.threshold) level = tier.level;
      }
      if (level === 0) continue;

      const existing = await queryOne<{ level: number }>(
        client,
        'SELECT level FROM badge_awards WHERE badge_id = $1 AND contact_id = $2',
        [badge.id, contactId],
      );
      const previousLevel = existing?.level ?? 0;

      await client.query(
        `INSERT INTO badge_awards (tenant_id, badge_id, contact_id, level, progress)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (badge_id, contact_id) DO UPDATE SET
           level = GREATEST(badge_awards.level, EXCLUDED.level),
           progress = EXCLUDED.progress,
           awarded_at = CASE WHEN EXCLUDED.level > badge_awards.level
                             THEN now() ELSE badge_awards.awarded_at END`,
        [tenantId, badge.id, contactId, level, progress],
      );

      if (level <= previousLevel) continue;

      let pointsAwarded = 0;
      if (badge.points_per_tier > 0) {
        for (let tierLevel = previousLevel + 1; tierLevel <= level; tierLevel += 1) {
          const result = await award(
            tenantId,
            {
              contactId,
              points: badge.points_per_tier,
              reason: `Badge earned: ${badge.name}`,
              refType: 'badge',
              refId: badge.id,
              idempotencyKey: `badge:${badge.key}:${tierLevel}:${contactId}`,
              meta: { badge_key: badge.key, level: tierLevel },
            },
            client,
          );
          if (result.created) pointsAwarded += badge.points_per_tier;
        }
      }

      await notify(
        client,
        tenantId,
        contactId,
        'badge_earned',
        `Badge unlocked: ${badge.name}`,
        badge.description,
        { badge_key: badge.key, level },
      );

      earned.push({ badge, level, pointsAwarded });
    }

    return earned;
  };

  return runner ? run(runner) : withTransaction(run);
}

async function measureCriteria(
  client: Queryable,
  tenantId: string,
  contactId: string,
  criteria: BadgeCriteria,
): Promise<number> {
  switch (criteria?.type) {
    case 'rule_count': {
      const row = await queryOne<{ n: string }>(
        client,
        `SELECT COUNT(*) AS n FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3 AND status <> 'reversed'`,
        [tenantId, contactId, criteria.rule_key],
      );
      return Number(row?.n ?? 0);
    }
    case 'rule_points': {
      const row = await queryOne<{ n: string }>(
        client,
        `SELECT COALESCE(SUM(delta_points), 0) AS n FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3 AND status <> 'reversed'`,
        [tenantId, contactId, criteria.rule_key],
      );
      return Number(row?.n ?? 0);
    }
    case 'lifetime_points': {
      const balance = await getBalance(tenantId, contactId, client);
      return balance.lifetime_earned;
    }
    case 'order_count': {
      const row = await queryOne<{ n: string }>(
        client,
        `SELECT COUNT(*) AS n FROM orders
          WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'refunded'`,
        [tenantId, contactId],
      );
      return Number(row?.n ?? 0);
    }
    case 'referral_count': {
      const row = await queryOne<{ n: string }>(
        client,
        `SELECT COUNT(*) AS n FROM referrals
          WHERE tenant_id = $1 AND referrer_contact_id = $2 AND status = 'qualified'`,
        [tenantId, contactId],
      );
      return Number(row?.n ?? 0);
    }
    case 'share_count': {
      const row = await queryOne<{ n: string }>(
        client,
        `SELECT COUNT(*) AS n FROM share_events
          WHERE tenant_id = $1 AND contact_id = $2 AND status = 'verified'`,
        [tenantId, contactId],
      );
      return Number(row?.n ?? 0);
    }
    case 'streak': {
      const row = await queryOne<{ longest_length: number }>(
        client,
        'SELECT longest_length FROM streaks WHERE tenant_id = $1 AND contact_id = $2 AND key = $3',
        [tenantId, contactId, criteria.streak_key],
      );
      return row?.longest_length ?? 0;
    }
    default:
      return 0;
  }
}

/** Grant a badge by hand, e.g. for an offline event. */
export async function awardBadgeManually(
  tenantId: string,
  contactId: string,
  badgeKey: string,
  level = 1,
  runner: Queryable = db(),
): Promise<BadgeAward | null> {
  const badge = await queryOne<Badge>(
    runner,
    'SELECT * FROM badges WHERE tenant_id = $1 AND key = $2',
    [tenantId, badgeKey],
  );
  if (!badge) throw ApiError.notFound(`No badge "${badgeKey}"`);

  const row = await queryOne<BadgeAward>(
    runner,
    `INSERT INTO badge_awards (tenant_id, badge_id, contact_id, level, progress)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT (badge_id, contact_id) DO UPDATE SET
       level = GREATEST(badge_awards.level, EXCLUDED.level)
     RETURNING *`,
    [tenantId, badge.id, contactId, level],
  );

  await notify(runner, tenantId, contactId, 'badge_earned', `Badge unlocked: ${badge.name}`, badge.description, {
    badge_key: badge.key,
    level,
  });

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranks
// ─────────────────────────────────────────────────────────────────────────────

export interface Rank {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  image_url: string | null;
  min_points: number;
  max_points: number | null;
  perks: Record<string, unknown>;
  display_order: number;
  enabled: boolean;
}

export async function listRanks(tenantId: string, runner: Queryable = db()): Promise<Rank[]> {
  const { rows } = await runner.query<Rank>(
    'SELECT * FROM ranks WHERE tenant_id = $1 ORDER BY min_points',
    [tenantId],
  );
  return rows;
}

/**
 * Recompute a member's rank from lifetime points earned.
 *
 * Deliberately *not* the spendable balance: redeeming points for TBAY should
 * never demote someone who has already done the work to earn the rank.
 */
export async function evaluateRank(
  tenantId: string,
  contactId: string,
  runner?: Queryable,
): Promise<{ rank: Rank | null; promoted: boolean }> {
  const run = async (client: Queryable) => {
    const balance = await getBalance(tenantId, contactId, client);

    const rank = await queryOne<Rank>(
      client,
      `SELECT * FROM ranks
        WHERE tenant_id = $1 AND enabled
          AND min_points <= $2
          AND (max_points IS NULL OR max_points >= $2)
        ORDER BY min_points DESC
        LIMIT 1`,
      [tenantId, balance.lifetime_earned],
    );
    if (!rank) return { rank: null, promoted: false };

    const current = await queryOne<{ current_rank_id: string | null }>(
      client,
      'SELECT current_rank_id FROM points_balances WHERE tenant_id = $1 AND contact_id = $2',
      [tenantId, contactId],
    );
    if (current?.current_rank_id === rank.id) return { rank, promoted: false };

    await client.query(
      `UPDATE points_balances SET current_rank_id = $3, updated_at = now()
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId, rank.id],
    );

    const award = await queryOne<{ id: string }>(
      client,
      `INSERT INTO rank_awards (tenant_id, contact_id, rank_id) VALUES ($1, $2, $3)
       ON CONFLICT (contact_id, rank_id) DO NOTHING
       RETURNING id`,
      [tenantId, contactId, rank.id],
    );

    // Only celebrate the first time a rank is reached.
    if (award) {
      await notify(client, tenantId, contactId, 'rank_up', `You reached ${rank.name}`, rank.description, {
        rank_key: rank.key,
      });
    }

    return { rank, promoted: award !== null };
  };

  return runner ? run(runner) : withTransaction(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaks
// ─────────────────────────────────────────────────────────────────────────────

export interface Streak {
  current_length: number;
  longest_length: number;
  total_days: number;
  last_day: string;
}

/**
 * Record one day of activity.
 *
 * Returns `counted: false` when today was already recorded, so a member who
 * refreshes the page twenty times still only earns one day.
 */
export async function recordStreak(
  tenantId: string,
  contactId: string,
  key = 'daily_login',
  runner?: Queryable,
): Promise<{ streak: Streak; counted: boolean; pointsAwarded: number }> {
  const run = async (client: Queryable) => {
    const existing = await queryOne<Streak>(
      client,
      `SELECT current_length, longest_length, total_days, last_day::text AS last_day
         FROM streaks WHERE tenant_id = $1 AND contact_id = $2 AND key = $3 FOR UPDATE`,
      [tenantId, contactId, key],
    );

    const today = await queryOne<{ today: string; yesterday: string }>(
      client,
      `SELECT CURRENT_DATE::text AS today, (CURRENT_DATE - 1)::text AS yesterday`,
    );

    if (existing && existing.last_day === today!.today) {
      return { streak: existing, counted: false, pointsAwarded: 0 };
    }

    const continuing = existing?.last_day === today!.yesterday;
    const nextLength = continuing ? existing!.current_length + 1 : 1;

    const updated = await queryOne<Streak>(
      client,
      `INSERT INTO streaks (tenant_id, contact_id, key, current_length, longest_length, last_day, total_days)
       VALUES ($1, $2, $3, $4, $4, CURRENT_DATE, 1)
       ON CONFLICT (tenant_id, contact_id, key) DO UPDATE SET
         current_length = $4,
         longest_length = GREATEST(streaks.longest_length, $4),
         last_day       = CURRENT_DATE,
         total_days     = streaks.total_days + 1,
         updated_at     = now()
       RETURNING current_length, longest_length, total_days, last_day::text AS last_day`,
      [tenantId, contactId, key, nextLength],
    );

    // A rule named after the streak pays it, when the retailer has defined one.
    const outcome = await trigger(
      tenantId,
      {
        contactId,
        ruleKey: key,
        refId: `${key}:${today!.today}`,
        refType: 'streak',
        meta: { streak_length: nextLength },
      },
      client,
    );

    await evaluateBadges(tenantId, contactId, client);

    return {
      streak: updated!,
      counted: true,
      pointsAwarded: outcome.awarded ? outcome.points : 0,
    };
  };

  return runner ? run(runner) : withTransaction(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// Member-to-member transfers
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferResult {
  transfer_id: string;
  from_balance: Balance;
  points: number;
}

/**
 * Move points from one member to another.
 *
 * Both legs land in one transaction, so points can never be destroyed or
 * conjured by a half-applied transfer.
 */
export async function transferPoints(
  tenantId: string,
  input: { fromContactId: string; toContactId: string; points: number; message?: string },
  runner?: Queryable,
): Promise<TransferResult> {
  if (input.fromContactId === input.toContactId) {
    throw ApiError.badRequest('You cannot send points to yourself');
  }
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw ApiError.badRequest('points must be a positive integer');
  }

  const run = async (client: Queryable): Promise<TransferResult> => {
    const recipient = await queryOne<{ id: string }>(
      client,
      'SELECT id FROM contacts WHERE tenant_id = $1 AND id = $2',
      [tenantId, input.toContactId],
    );
    if (!recipient) throw ApiError.notFound('No such recipient');

    const reference = `${input.fromContactId}:${input.toContactId}:${Date.now()}`;

    const debit = await spend(
      tenantId,
      {
        contactId: input.fromContactId,
        points: input.points,
        reason: 'Points sent',
        refType: 'transfer',
        refId: reference,
        idempotencyKey: `transfer-out:${reference}`,
        meta: { to_contact_id: input.toContactId, message: input.message ?? '' },
      },
      client,
    );

    const credit = await award(
      tenantId,
      {
        contactId: input.toContactId,
        points: input.points,
        reason: 'Points received',
        refType: 'transfer',
        refId: reference,
        idempotencyKey: `transfer-in:${reference}`,
        meta: { from_contact_id: input.fromContactId, message: input.message ?? '' },
      },
      client,
    );

    const transfer = await queryOne<{ id: string }>(
      client,
      `INSERT INTO point_transfers (
         tenant_id, from_contact_id, to_contact_id, points, message, debit_entry_id, credit_entry_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        tenantId,
        input.fromContactId,
        input.toContactId,
        input.points,
        (input.message ?? '').slice(0, 500),
        debit.entry.id,
        credit.entry.id,
      ],
    );

    await notify(
      client,
      tenantId,
      input.toContactId,
      'points_received',
      `You received ${input.points} points`,
      input.message ?? '',
      { from_contact_id: input.fromContactId },
    );

    await evaluateRank(tenantId, input.toContactId, client);

    return { transfer_id: transfer!.id, from_balance: debit.balance, points: input.points };
  };

  return runner ? run(runner) : withTransaction(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// Coupons
// ─────────────────────────────────────────────────────────────────────────────

export async function createCoupon(
  tenantId: string,
  input: {
    code: string;
    points: number;
    maxUses?: number | null;
    perContactLimit?: number;
    expiresAt?: string | null;
  },
  runner: Queryable = db(),
): Promise<{ code: string; points: number }> {
  const row = await queryOne<{ code: string; points: number }>(
    runner,
    `INSERT INTO point_coupons (tenant_id, code, points, max_uses, per_contact_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, code) DO NOTHING
     RETURNING code, points`,
    [
      tenantId,
      input.code.trim().toUpperCase(),
      input.points,
      input.maxUses ?? null,
      input.perContactLimit ?? 1,
      input.expiresAt ?? null,
    ],
  );
  if (!row) throw ApiError.conflict('That coupon code already exists');
  return row;
}

/**
 * Redeem a coupon for points.
 *
 * The coupon row is locked and its use counter incremented in the same
 * transaction as the ledger credit, so a code with `max_uses = 1` cannot be
 * claimed twice by two simultaneous requests.
 */
export async function redeemCoupon(
  tenantId: string,
  contactId: string,
  code: string,
  runner?: Queryable,
): Promise<{ points: number; balance: Balance }> {
  const run = async (client: Queryable) => {
    const coupon = await queryOne<{
      id: string;
      points: number;
      max_uses: number | null;
      uses: number;
      per_contact_limit: number;
      expires_at: Date | null;
      enabled: boolean;
    }>(
      client,
      `SELECT * FROM point_coupons WHERE tenant_id = $1 AND code = $2 FOR UPDATE`,
      [tenantId, code.trim().toUpperCase()],
    );

    // One message for every failure mode: a coupon endpoint must not become an
    // oracle for guessing which codes exist.
    const invalid = ApiError.unprocessable('That code is not valid');
    if (!coupon || !coupon.enabled) throw invalid;
    if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) throw invalid;
    if (coupon.max_uses !== null && coupon.uses >= coupon.max_uses) throw invalid;

    const mine = await queryOne<{ n: string }>(
      client,
      'SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = $1 AND contact_id = $2',
      [coupon.id, contactId],
    );
    if (Number(mine?.n ?? 0) >= coupon.per_contact_limit) throw invalid;

    await client.query('UPDATE point_coupons SET uses = uses + 1 WHERE id = $1', [coupon.id]);
    await client.query(
      `INSERT INTO coupon_redemptions (tenant_id, coupon_id, contact_id, points)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, coupon.id, contactId, coupon.points],
    );

    const result = await award(
      tenantId,
      {
        contactId,
        points: coupon.points,
        reason: 'Coupon redeemed',
        refType: 'coupon',
        refId: coupon.id,
        idempotencyKey: `coupon:${coupon.id}:${contactId}:${coupon.uses + 1}`,
      },
      client,
    );

    await evaluateRank(tenantId, contactId, client);

    return { points: coupon.points, balance: result.balance };
  };

  return runner ? run(runner) : withTransaction(run);
}

// ─────────────────────────────────────────────────────────────────────────────
// Points-gated content
// ─────────────────────────────────────────────────────────────────────────────

export async function unlockContent(
  tenantId: string,
  contactId: string,
  contentRef: string,
  points: number,
  runner?: Queryable,
): Promise<{ unlocked: boolean; alreadyOwned: boolean; balance: Balance }> {
  const run = async (client: Queryable) => {
    const existing = await queryOne<{ id: string }>(
      client,
      `SELECT id FROM content_unlocks
        WHERE tenant_id = $1 AND contact_id = $2 AND content_ref = $3
          AND (expires_at IS NULL OR expires_at > now())`,
      [tenantId, contactId, contentRef],
    );
    if (existing) {
      return { unlocked: true, alreadyOwned: true, balance: await getBalance(tenantId, contactId, client) };
    }

    const debit = await spend(
      tenantId,
      {
        contactId,
        points,
        reason: 'Unlocked content',
        refType: 'content',
        refId: contentRef,
        idempotencyKey: `unlock:${contentRef}:${contactId}`,
      },
      client,
    );

    await client.query(
      `INSERT INTO content_unlocks (tenant_id, contact_id, content_ref, points_spent, ledger_entry_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, contact_id, content_ref) DO NOTHING`,
      [tenantId, contactId, contentRef, points, debit.entry.id],
    );

    return { unlocked: true, alreadyOwned: false, balance: debit.balance };
  };

  return runner ? run(runner) : withTransaction(run);
}

export async function hasUnlocked(
  tenantId: string,
  contactId: string,
  contentRef: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    runner,
    `SELECT id FROM content_unlocks
      WHERE tenant_id = $1 AND contact_id = $2 AND content_ref = $3
        AND (expires_at IS NULL OR expires_at > now())`,
    [tenantId, contactId, contentRef],
  );
  return row !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

export async function notify(
  runner: Queryable,
  tenantId: string,
  contactId: string,
  type: string,
  title: string,
  body = '',
  meta: Record<string, unknown> = {},
): Promise<void> {
  await runner.query(
    `INSERT INTO notifications (tenant_id, contact_id, type, title, body, meta)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [tenantId, contactId, type, title.slice(0, 255), body.slice(0, 1000), JSON.stringify(meta)],
  );
}

export async function listNotifications(
  tenantId: string,
  contactId: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
  runner: Queryable = db(),
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await runner.query(
    `SELECT id, type, title, body, icon, link_url, meta, read_at, created_at
       FROM notifications
      WHERE tenant_id = $1 AND contact_id = $2
        AND ($3::boolean IS NOT TRUE OR read_at IS NULL)
      ORDER BY created_at DESC
      LIMIT $4`,
    [tenantId, contactId, opts.unreadOnly ?? false, Math.min(opts.limit ?? 25, 100)],
  );
  return rows;
}

export async function markNotificationsRead(
  tenantId: string,
  contactId: string,
  ids: string[] | null,
  runner: Queryable = db(),
): Promise<number> {
  const { rowCount } = await runner.query(
    `UPDATE notifications SET read_at = now()
      WHERE tenant_id = $1 AND contact_id = $2 AND read_at IS NULL
        AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
    [tenantId, contactId, ids && ids.length > 0 ? ids : null],
  );
  return rowCount ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate profile
// ─────────────────────────────────────────────────────────────────────────────

export interface GamificationProfile {
  balance: Balance;
  rank: Rank | null;
  next_rank: Rank | null;
  points_to_next_rank: number | null;
  badges: BadgeWithProgress[];
  streaks: Array<{ key: string; current_length: number; longest_length: number; total_days: number }>;
  unread_notifications: number;
}

/** Everything a member profile page needs, in one round trip. */
export async function profile(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<GamificationProfile> {
  const balance = await getBalance(tenantId, contactId, runner);
  const ranks = await listRanks(tenantId, runner);

  const current =
    [...ranks]
      .filter((rank) => rank.enabled && rank.min_points <= balance.lifetime_earned)
      .sort((a, b) => b.min_points - a.min_points)[0] ?? null;

  const next =
    ranks
      .filter((rank) => rank.enabled && rank.min_points > balance.lifetime_earned)
      .sort((a, b) => a.min_points - b.min_points)[0] ?? null;

  const { rows: streaks } = await runner.query<{
    key: string;
    current_length: number;
    longest_length: number;
    total_days: number;
  }>(
    'SELECT key, current_length, longest_length, total_days FROM streaks WHERE tenant_id = $1 AND contact_id = $2',
    [tenantId, contactId],
  );

  const unread = await queryOne<{ n: string }>(
    runner,
    'SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = $1 AND contact_id = $2 AND read_at IS NULL',
    [tenantId, contactId],
  );

  return {
    balance,
    rank: current,
    next_rank: next,
    points_to_next_rank: next ? next.min_points - balance.lifetime_earned : null,
    badges: await badgesForContact(tenantId, contactId, runner),
    streaks,
    unread_notifications: Number(unread?.n ?? 0),
  };
}
