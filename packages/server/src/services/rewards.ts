import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { award, getBalance, type AwardResult, type Balance } from './points.js';
import { isExcluded } from './exclusions.js';

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
  weekly_cap: number | null;
  monthly_cap: number | null;
  lifetime_cap: number | null;
  /** Clamp on a single award, however the amount was calculated. */
  max_per_award: number | null;
  hold_seconds: number;
  requires_verification: boolean;
  /** Admin-editable ledger wording; falls back to the rule name. */
  log_template: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Cap windows, in the order they are checked. */
const CAP_WINDOWS = [
  { column: 'daily_cap', unit: 'day', reason: 'daily_cap' },
  { column: 'weekly_cap', unit: 'week', reason: 'weekly_cap' },
  { column: 'monthly_cap', unit: 'month', reason: 'monthly_cap' },
] as const;

/**
 * The reward rules every new retailer starts with.
 *
 * The optional controls (the wider cap windows, the per-award clamp, the log
 * template) are left unset here on purpose: a fresh tenant should behave
 * exactly as the defaults read, and an admin opts into each knob.
 */
export const DEFAULT_RULES: Array<Omit<RewardRule,
  'id' | 'tenant_id' | 'points_per_unit' | 'config' | 'enabled'
  | 'weekly_cap' | 'monthly_cap' | 'max_per_award' | 'log_template'
> & {
  points_per_unit?: number;
  config?: Record<string, unknown>;
  weekly_cap?: number | null;
  monthly_cap?: number | null;
  max_per_award?: number | null;
  log_template?: string | null;
}> = [
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
    key: 'form_submission',
    name: 'Filled in a form',
    event_key: 'form.submitted',
    mode: 'fixed',
    points: 25,
    // A form is the cheapest thing on the site to submit, so this is the rule
    // most worth rate-limiting. A cooldown plus a daily cap makes filling the
    // same contact form forty times worth one submission's points.
    cooldown_seconds: 300,
    daily_cap: 75,
    lifetime_cap: null,
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
       cooldown_seconds, daily_cap, weekly_cap, monthly_cap, lifetime_cap,
       max_per_award, log_template, hold_seconds,
       requires_verification, config, enabled
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, reward_rules.name),
       event_key = COALESCE(EXCLUDED.event_key, reward_rules.event_key),
       mode = COALESCE(EXCLUDED.mode, reward_rules.mode),
       points = COALESCE(EXCLUDED.points, reward_rules.points),
       points_per_unit = COALESCE(EXCLUDED.points_per_unit, reward_rules.points_per_unit),
       cooldown_seconds = COALESCE(EXCLUDED.cooldown_seconds, reward_rules.cooldown_seconds),
       -- Caps are nullable by design: passing null is how an admin *removes*
       -- a cap, so these cannot use COALESCE like the others.
       daily_cap = EXCLUDED.daily_cap,
       weekly_cap = EXCLUDED.weekly_cap,
       monthly_cap = EXCLUDED.monthly_cap,
       lifetime_cap = EXCLUDED.lifetime_cap,
       max_per_award = EXCLUDED.max_per_award,
       log_template = EXCLUDED.log_template,
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
      rule.weekly_cap ?? null,
      rule.monthly_cap ?? null,
      rule.lifetime_cap ?? null,
      rule.max_per_award ?? null,
      rule.log_template ?? null,
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
  /** Points from `fixed` per-product overrides, added on top of the rate. */
  bonusPoints?: number;
  meta?: Record<string, unknown>;
}

export type TriggerOutcome =
  | { awarded: true; points: number; result: AwardResult; balance: Balance }
  | {
      awarded: false;
      reason:
        | 'rule_missing'
        | 'rule_disabled'
        | 'cooldown'
        | 'daily_cap'
        | 'weekly_cap'
        | 'monthly_cap'
        | 'lifetime_cap'
        | 'zero_points'
        | 'excluded';
      /** Which exclusion matched, for the admin who has to explain it. */
      detail?: string | null;
      balance: Balance;
    };

/** Cache tenant timezones: `trigger` runs on every order and every share. */
const timezoneCache = new Map<string, { zone: string; at: number }>();
const TIMEZONE_TTL_MS = 60_000;

async function tenantTimezone(tenantId: string, runner: Queryable): Promise<string> {
  const hit = timezoneCache.get(tenantId);
  if (hit && Date.now() - hit.at < TIMEZONE_TTL_MS) return hit.zone;

  const row = await queryOne<{ timezone: string | null }>(
    runner,
    'SELECT timezone FROM tenants WHERE id = $1',
    [tenantId],
  );
  // Postgres rejects an unknown zone name at query time, which would turn a
  // typo in a settings field into a failed award. Verify once, here.
  let zone = row?.timezone?.trim() || 'UTC';
  try {
    await runner.query('SELECT now() AT TIME ZONE $1', [zone]);
  } catch {
    zone = 'UTC';
  }
  timezoneCache.set(tenantId, { zone, at: Date.now() });
  return zone;
}

/** Exposed so a tenant's timezone change takes effect without a restart. */
export function forgetTimezone(tenantId?: string): void {
  if (tenantId) timezoneCache.delete(tenantId);
  else timezoneCache.clear();
}

/**
 * The wording that lands in the customer's history.
 *
 * myCred lets an admin write this per hook with %amount% style tags, which is
 * how a store makes its history read like its own voice rather than ours.
 */
export function renderLogTemplate(
  rule: RewardRule,
  points: number,
  input: Pick<TriggerInput, 'refId' | 'refType' | 'valueCents'>,
): string {
  const template = rule.log_template?.trim();
  if (!template) return rule.name;
  return template
    .replace(/%amount%/g, String(points))
    .replace(/%rule%/g, rule.name)
    .replace(/%ref%/g, input.refId ?? '')
    .replace(/%ref_type%/g, input.refType ?? '')
    .replace(/%value%/g, ((input.valueCents ?? 0) / 100).toFixed(2))
    .slice(0, 300);
}

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

    // Excluded before anything else is computed: staff and test accounts
    // should not appear in cooldown state, cap totals or the ledger at all.
    const exclusion = await isExcluded(tenantId, input.contactId, client);
    if (exclusion.excluded) {
      return {
        awarded: false,
        reason: 'excluded',
        detail: exclusion.reason,
        balance: await getBalance(tenantId, input.contactId, client),
      };
    }

    let points = pointsFor(rule, input.valueCents) + Math.max(0, input.bonusPoints ?? 0);

    // myCred's enforce_max(): clamp the award however the amount arrived, so a
    // mis-keyed order total cannot hand someone the whole budget.
    if (rule.max_per_award !== null && rule.max_per_award !== undefined) {
      points = Math.min(points, rule.max_per_award);
    }

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

    // Day, week and month boundaries are the retailer's, not the server's.
    // A shop in Thunder Bay rolling over its daily cap at 20:00 local because
    // the database runs UTC is a support ticket every single evening.
    const zone = await tenantTimezone(tenantId, client);

    for (const window of CAP_WINDOWS) {
      const cap = rule[window.column];
      if (cap === null || cap === undefined) continue;
      const used = await queryOne<{ total: string }>(
        client,
        `SELECT COALESCE(SUM(delta_points), 0) AS total FROM points_ledger
          WHERE tenant_id = $1 AND contact_id = $2 AND rule_key = $3
            AND status <> 'reversed'
            AND created_at >= (date_trunc($4, now() AT TIME ZONE $5) AT TIME ZONE $5)`,
        [tenantId, input.contactId, rule.key, window.unit, zone],
      );
      if (Number(used?.total ?? 0) + points > cap) {
        return {
          awarded: false,
          reason: window.reason,
          balance: await getBalance(tenantId, input.contactId, client),
        };
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
        reason: renderLogTemplate(rule, points, input),
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

      // `points.awarded` used to fire only from the /v1/rewards/trigger route,
      // so an automation on it never saw points from an order, an opt-in, a
      // share or a referral — which is nearly all of them. Firing here covers
      // every path that awards through a rule.
      //
      // No recursion: the `award_points` action calls `award()` directly, not
      // this function, so an automation cannot re-enter its own trigger.
      const automations = await import('./automations.js');
      const contacts = await import('./contacts.js');
      await automations.fire(
        tenantId,
        'points.awarded',
        {
          contact: await contacts.getContact(tenantId, input.contactId, client),
          data: {
            points,
            rule_key: rule.key,
            reason: rule.name,
            balance: result.balance.balance,
            lifetime_earned: result.balance.lifetime_earned,
            ref_id: input.refId,
            ref_type: input.refType ?? 'reward_rule',
          },
          dedupeKey: `rule:${rule.key}:${input.refId}`,
        },
        client,
      );
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

export type LeaderboardWindow = 'all' | 'day' | 'week' | 'month' | 'year';

export interface LeaderboardRow {
  contact_id: string;
  name: string | null;
  points: number;
  rank: number;
}

export interface LeaderboardResult {
  window: LeaderboardWindow;
  rows: LeaderboardRow[];
  /** The asking member's position, even when they are outside the top N. */
  you: LeaderboardRow | null;
}

/**
 * Leaderboard of top earners.
 *
 * Three things myCred has that a single lifetime query does not:
 *
 *  - a timeframe, because "top this month" is a board a new customer can still
 *    win, while an all-time board is settled by whoever joined first;
 *  - the asking member's own position, so someone in 400th place sees a number
 *    rather than a list of strangers;
 *  - exclusions, so staff and test accounts are not permanent champions.
 *
 * The windowed variants sum the ledger; `all` reads the balances cache, which
 * is what makes the default cheap.
 */
export async function leaderboard(
  tenantId: string,
  options: {
    limit?: number;
    window?: LeaderboardWindow;
    /** Include this contact's own row even if they are below the cut. */
    contactId?: string | null;
  } = {},
  runner: Queryable = db(),
): Promise<LeaderboardResult> {
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 100);
  const window = options.window ?? 'all';

  // Excluded contacts never appear, and the exclusion is resolved in SQL so a
  // large board does not turn into one round trip per row.
  const notExcluded = `
    NOT EXISTS (
      SELECT 1 FROM reward_exclusions x
       WHERE x.tenant_id = $1
         AND (
           (x.kind = 'contact'      AND x.value = c.id::text)
        OR (x.kind = 'email'        AND x.value = lower(coalesce(c.email_normalised, c.email, '')))
        OR (x.kind = 'email_domain' AND coalesce(c.email_normalised, c.email, '') <> ''
              AND lower(coalesce(c.email_normalised, c.email, '')) LIKE '%@' || x.value)
        OR (x.kind = 'tag'          AND x.value = ANY (SELECT lower(t) FROM unnest(c.tags) AS t))
        OR (x.kind = 'role'         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(coalesce(c.attributes->'roles', '[]'::jsonb)) AS r
                WHERE lower(r) = x.value))
         )
    )`;

  const source =
    window === 'all'
      ? `SELECT b.contact_id, c.name, b.lifetime_earned::bigint AS points
           FROM points_balances b
           JOIN contacts c ON c.id = b.contact_id
          WHERE b.tenant_id = $1 AND b.lifetime_earned > 0 AND ${notExcluded}`
      : `SELECT l.contact_id, c.name, SUM(l.delta_points)::bigint AS points
           FROM points_ledger l
           JOIN contacts c ON c.id = l.contact_id
          WHERE l.tenant_id = $1
            AND l.delta_points > 0
            AND l.status <> 'reversed'
            AND l.created_at >= date_trunc($2, now())
            AND ${notExcluded}
          GROUP BY l.contact_id, c.name
         HAVING SUM(l.delta_points) > 0`;

  const params: unknown[] = window === 'all' ? [tenantId] : [tenantId, window];

  const { rows } = await runner.query<LeaderboardRow>(
    `WITH board AS (${source})
     SELECT contact_id, name, points::int AS points,
            ROW_NUMBER() OVER (ORDER BY points DESC, contact_id)::int AS rank
       FROM board
      ORDER BY rank
      LIMIT ${limit}`,
    params,
  );

  let you: LeaderboardRow | null = null;
  if (options.contactId) {
    const mine = rows.find((row) => row.contact_id === options.contactId);
    you =
      mine ??
      (await queryOne<LeaderboardRow>(
        runner,
        `WITH board AS (${source}),
              ranked AS (
                SELECT contact_id, name, points::int AS points,
                       ROW_NUMBER() OVER (ORDER BY points DESC, contact_id)::int AS rank
                  FROM board
              )
         SELECT * FROM ranked WHERE contact_id = $${params.length + 1}`,
        [...params, options.contactId],
      ));
  }

  return { window, rows, you };
}

export function assertRuleKey(key: string): string {
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    throw ApiError.badRequest('Rule key must be 2-64 chars of a-z, 0-9 or underscore');
  }
  return key;
}
