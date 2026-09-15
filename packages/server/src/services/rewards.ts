import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { award, getBalance, type AwardResult, type Balance } from './points.js';

export interface RewardRule {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  event_key: string;
  mode: 'fixed' | 'per_currency_unit';
  points: number;
  points_per_unit: string;
  cooldown_seconds: number;
  daily_cap: number | null;
  lifetime_cap: number | null;
  hold_seconds: number;
  requires_verification: boolean;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** The reward rules every new retailer starts with. */
export const DEFAULT_RULES: Array<Omit<RewardRule,
  'id' | 'tenant_id' | 'points_per_unit' | 'config' | 'enabled'
> & { points_per_unit?: number; config?: Record<string, unknown> }> = [
  {
    key: 'newsletter_signup',
    name: 'Confirmed newsletter signup',
    event_key: 'newsletter.confirmed',
    mode: 'fixed',
    points: 100,
    cooldown_seconds: 0,
    daily_cap: null,
    lifetime_cap: 100, // once per person
    hold_seconds: 0,
    requires_verification: false,
  },
  {
    key: 'social_share',
    name: 'Shared a product or post',
    event_key: 'social.share',
    mode: 'fixed',
    points: 25,
    cooldown_seconds: 3600,
    daily_cap: 100,
    lifetime_cap: null,
    hold_seconds: 0,
    // A share only pays once someone actually clicks it.
    requires_verification: true,
  },
  {
    key: 'purchase',
    name: 'Points on every purchase',
    event_key: 'order.completed',
    mode: 'per_currency_unit',
    points: 0,
    points_per_unit: 1, // 1 point per whole currency unit
    cooldown_seconds: 0,
    daily_cap: null,
    lifetime_cap: null,
    // Held through the refund window so a refunded order cannot be cashed out first.
    hold_seconds: 60 * 60 * 24 * 14,
    requires_verification: false,
  },
  {
    key: 'referral',
    name: 'Referred a new customer',
    event_key: 'referral.qualified',
    mode: 'fixed',
    points: 250,
    cooldown_seconds: 0,
    daily_cap: 2500,
    lifetime_cap: null,
    hold_seconds: 0,
    requires_verification: false,
  },
  {
    key: 'account_created',
    name: 'Created an account',
    event_key: 'contact.created',
    mode: 'fixed',
    points: 50,
    cooldown_seconds: 0,
    daily_cap: null,
    lifetime_cap: 50,
    hold_seconds: 0,
    requires_verification: false,
  },
  {
    key: 'review',
    name: 'Left a product review',
    event_key: 'product.reviewed',
    mode: 'fixed',
    points: 75,
    cooldown_seconds: 0,
    daily_cap: 225,
    lifetime_cap: null,
    hold_seconds: 0,
    requires_verification: false,
  },
];

export async function installDefaultRules(tenantId: string, runner: Queryable = db()): Promise<void> {
  for (const rule of DEFAULT_RULES) {
    await runner.query(
      `INSERT INTO reward_rules (
         tenant_id, key, name, event_key, mode, points, points_per_unit,
         cooldown_seconds, daily_cap, lifetime_cap, hold_seconds, requires_verification, config
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [
        tenantId,
        rule.key,
        rule.name,
        rule.event_key,
        rule.mode,
        rule.points,
        rule.points_per_unit ?? 0,
        rule.cooldown_seconds,
        rule.daily_cap,
        rule.lifetime_cap,
        rule.hold_seconds,
        rule.requires_verification,
        JSON.stringify(rule.config ?? {}),
      ],
    );
  }
}

export async function getRule(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<RewardRule | null> {
  return queryOne<RewardRule>(
    runner,
    'SELECT * FROM reward_rules WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
}

export async function rulesForEvent(
  tenantId: string,
  eventKey: string,
  runner: Queryable = db(),
): Promise<RewardRule[]> {
  const { rows } = await runner.query<RewardRule>(
    'SELECT * FROM reward_rules WHERE tenant_id = $1 AND event_key = $2 AND enabled',
    [tenantId, eventKey],
  );
  return rows;
}

export async function listRules(tenantId: string, runner: Queryable = db()): Promise<RewardRule[]> {
  const { rows } = await runner.query<RewardRule>(
    'SELECT * FROM reward_rules WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );
  return rows;
}

export async function upsertRule(
  tenantId: string,
  rule: Partial<RewardRule> & { key: string },
  runner: Queryable = db(),
): Promise<RewardRule> {
  const row = await queryOne<RewardRule>(
    runner,
    `INSERT INTO reward_rules (
       tenant_id, key, name, event_key, mode, points, points_per_unit,
       cooldown_seconds, daily_cap, lifetime_cap, hold_seconds,
       requires_verification, config, enabled
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, reward_rules.name),
       event_key = COALESCE(EXCLUDED.event_key, reward_rules.event_key),
       mode = COALESCE(EXCLUDED.mode, reward_rules.mode),
       points = COALESCE(EXCLUDED.points, reward_rules.points),
       points_per_unit = COALESCE(EXCLUDED.points_per_unit, reward_rules.points_per_unit),
       cooldown_seconds = COALESCE(EXCLUDED.cooldown_seconds, reward_rules.cooldown_seconds),
       daily_cap = EXCLUDED.daily_cap,
       lifetime_cap = EXCLUDED.lifetime_cap,
       hold_seconds = COALESCE(EXCLUDED.hold_seconds, reward_rules.hold_seconds),
       requires_verification = COALESCE(EXCLUDED.requires_verification, reward_rules.requires_verification),
       config = COALESCE(EXCLUDED.config, reward_rules.config),
       enabled = COALESCE(EXCLUDED.enabled, reward_rules.enabled),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      rule.key,
      rule.name ?? rule.key,
      rule.event_key ?? `custom.${rule.key}`,
      rule.mode ?? 'fixed',
      rule.points ?? 0,
      rule.points_per_unit ?? 0,
      rule.cooldown_seconds ?? 0,
      rule.daily_cap ?? null,
      rule.lifetime_cap ?? null,
      rule.hold_seconds ?? 0,
      rule.requires_verification ?? false,
      JSON.stringify(rule.config ?? {}),
      rule.enabled ?? true,
    ],
  );
  return row!;
}

export interface TriggerInput {
  contactId: string;
  ruleKey: string;
  /** Distinguishes one occurrence from another; becomes part of the ledger key. */
  refId: string;
  refType?: string;
  /** For per_currency_unit rules: the order value in cents. */
  valueCents?: number;
  meta?: Record<string, unknown>;
}

export type TriggerOutcome =
  | { awarded: true; points: number; result: AwardResult; balance: Balance }
  | {
      awarded: false;
      reason: 'rule_missing' | 'rule_disabled' | 'cooldown' | 'daily_cap' | 'lifetime_cap' | 'zero_points';
      balance: Balance;
    };

/**
 * Apply one reward rule to one contact.
 *
 * Caps and cooldowns are evaluated inside the same transaction as the ledger
 * write, so a burst of concurrent triggers cannot slip past a daily cap.
 */
export async function trigger(
  tenantId: string,
  input: TriggerInput,
  runner?: Queryable,
): Promise<TriggerOutcome> {
  const run = async (client: Queryable): Promise<TriggerOutcome> => {
    const rule = await getRule(tenantId, input.ruleKey, client);
    if (!rule) return { awarded: false, reason: 'rule_missing', balance: await getBalance(tenantId, input.contactId, client) };
    if (!rule.enabled) return { awarded: false, reason: 'rule_disabled', balance: await getBalance(tenantId, input.contactId, client) };

    const points = pointsFor(rule, input.valueCents);
    if (points <= 0) {
      return { awarded: false, reason: 'zero_points', balance: await getBalance(tenantId, input.contactId, client) };
    }

    // Serialise per (contact, rule) so cap checks and the insert are atomic.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `${tenantId}:${input.contactId}`,
      rule.key,
    ]);

    if (rule.cooldown_seconds > 0) {
      const recent = await queryOne<{ id: string }>(
        client,
        `SELECT id FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3
            AND status <> 'reversed'
            AND created_at > now() - ($4 || ' seconds')::interval
          LIMIT 1`,
        [tenantId, input.contactId, rule.key, String(rule.cooldown_seconds)],
      );
      if (recent) {
        return { awarded: false, reason: 'cooldown', balance: await getBalance(tenantId, input.contactId, client) };
      }
    }

    if (rule.daily_cap !== null) {
      const today = await queryOne<{ total: string }>(
        client,
        `SELECT COALESCE(SUM(delta_points), 0) AS total FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3
            AND status <> 'reversed'
            AND created_at >= date_trunc('day', now())`,
        [tenantId, input.contactId, rule.key],
      );
      if (Number(today?.total ?? 0) + points > rule.daily_cap) {
        return { awarded: false, reason: 'daily_cap', balance: await getBalance(tenantId, input.contactId, client) };
      }
    }

    if (rule.lifetime_cap !== null) {
      const lifetime = await queryOne<{ total: string }>(
        client,
        `SELECT COALESCE(SUM(delta_points), 0) AS total FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3 AND status <> 'reversed'`,
        [tenantId, input.contactId, rule.key],
      );
      if (Number(lifetime?.total ?? 0) + points > rule.lifetime_cap) {
        return { awarded: false, reason: 'lifetime_cap', balance: await getBalance(tenantId, input.contactId, client) };
      }
    }

    const result = await award(
      tenantId,
      {
        contactId: input.contactId,
        points,
        reason: rule.name,
        ruleKey: rule.key,
        refType: input.refType ?? 'reward_rule',
        refId: input.refId,
        idempotencyKey: `rule:${rule.key}:${input.refId}`,
        holdSeconds: rule.hold_seconds,
        meta: input.meta,
      },
      client,
    );

    // Earning is what moves someone up, so evaluate here rather than leaving
    // badges and ranks to catch up on the next unrelated action. Imported
    // lazily because gamification depends on this module.
    if (result.created) {
      const gamification = await import('./gamification.js');
      await gamification.evaluateBadges(tenantId, input.contactId, client);
      await gamification.evaluateRank(tenantId, input.contactId, client);
    }

    return { awarded: true, points, result, balance: result.balance };
  };

  return runner ? run(runner) : withTransaction(run);
}

export function pointsFor(rule: RewardRule, valueCents?: number): number {
  if (rule.mode === 'per_currency_unit') {
    const units = Math.floor(Math.max(0, valueCents ?? 0) / 100);
    return Math.floor(units * Number(rule.points_per_unit));
  }
  return rule.points;
}

/** Leaderboard of top earners, for the storefront rewards page. */
export async function leaderboard(
  tenantId: string,
  limit = 10,
  runner: Queryable = db(),
): Promise<Array<{ contact_id: string; name: string | null; lifetime_earned: number }>> {
  const { rows } = await runner.query<{
    contact_id: string;
    name: string | null;
    lifetime_earned: number;
  }>(
    `SELECT b.contact_id, c.name, b.lifetime_earned
       FROM points_balances b
       JOIN contacts c ON c.id = b.contact_id
      WHERE b.tenant_id = $1 AND b.lifetime_earned > 0
      ORDER BY b.lifetime_earned DESC
      LIMIT $2`,
    [tenantId, Math.min(limit, 100)],
  );
  return rows;
}

export function assertRuleKey(key: string): string {
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    throw ApiError.badRequest('Rule key must be 2-64 chars of a-z, 0-9 or underscore');
  }
  return key;
}
