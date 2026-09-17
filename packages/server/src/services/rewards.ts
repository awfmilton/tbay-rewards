import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { limitOf } from '../lib/paging.js';
import { award, getBalance, type AwardResult, type Balance } from './points.js';
import { isExcluded } from './exclusions.js';
import { defaultPointType, resolvePointType } from './point-types.js';

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
  /**
   * Which currency this rule pays in.
   *
   * One rule, one currency — which is what keeps the cap and cooldown queries
   * below correct without a type predicate: they scope by `rule_key`, and a
   * rule's entries are all denominated in the same thing.
   */
  point_type: string;
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
  | 'weekly_cap' | 'monthly_cap' | 'max_per_award' | 'log_template' | 'point_type'
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

/**
 * Rule keys a specific call site already awards by name.
 *
 * `awardRulesForEvent` pays every *other* enabled rule whose `event_key`
 * matches, and these six must not be paid twice: the ledger's idempotency key
 * is `rule:<key>:<contact>:<refId>` and the call sites use their own refIds --
 * a subscription id, an order id -- which would not collide with an
 * event-dispatched one.
 *
 * It is a constant rather than a column because it is a fact about this
 * codebase, not about a tenant: it says "some code path already calls
 * trigger() with this key". A retailer's own rule is never in it, which is the
 * whole point -- a custom rule with `eventKey: 'order.completed'` now earns,
 * and before this could not.
 */
const AWARDED_BY_NAME = new Set([
  'newsletter_signup', // newsletter.ts, on confirmation
  'social_share', // shares.ts, on a verified share
  'purchase', // commissions.ts, on a completed order
  'referral', // commissions.ts, on a qualified referral
  'form_submission', // the WP plugin's form hooks, via POST /v1/rewards/trigger
  'review', // the WP plugin's WooCommerce review hook, same route
]);

/**
 * Pay every enabled rule that listens for this event and is not already paid
 * by name.
 *
 * `event_key` was decorative. Every rule carried one, the admin API let a
 * retailer set one, `rulesForEvent` existed to look one up -- and nothing
 * called it, so the only way any rule ever fired was a call site naming its
 * key as a literal. Six of the seven shipped rules have such a call site. The
 * seventh, `account_created`, ships enabled on every tenant with 50 points on
 * it, and awarded nobody anything: a reviewer reproduced signup end to end and
 * found zero ledger rows, then forced the trigger by name and got the 50.
 * A retailer's own rule was in the same position, permanently.
 *
 * Failures are swallowed per rule, deliberately. This runs inside whatever
 * transaction the caller fired in -- creating a contact, confirming a
 * subscription -- and a misconfigured reward rule must not roll that back.
 */
export async function awardRulesForEvent(
  tenantId: string,
  eventKey: string,
  contactId: string,
  occurrence: string,
  data: Record<string, unknown>,
  runner: Queryable = db(),
): Promise<string[]> {
  const paid: string[] = [];
  for (const rule of await rulesForEvent(tenantId, eventKey, runner)) {
    if (AWARDED_BY_NAME.has(rule.key)) continue;
    const valueCents = Number(data.subtotal_cents ?? data.total_cents ?? data.value_cents);
    const outcome = await trigger(
      tenantId,
      {
        contactId,
        ruleKey: rule.key,
        // The occurrence, so the same event replayed pays once -- the same
        // guarantee the automation runner gets from its own dedupe key.
        refId: occurrence,
        refType: 'event',
        valueCents: Number.isFinite(valueCents) ? valueCents : undefined,
        meta: { event_key: eventKey },
      },
      runner,
    );
    if (outcome.awarded) paid.push(rule.key);
  }
  return paid;
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
  // Resolved rather than trusted: a rule paying an unknown currency would fail
  // at award time, on a customer's order, instead of here in the admin screen.
  //
  // Only when one was actually named, though. An edit that does not mention a
  // currency must leave the rule's alone — resolving an absent key returns the
  // tenant default, which would quietly move a "status" rule onto "points"
  // every time someone renamed it.
  const pointType = rule.point_type
    ? await resolvePointType(tenantId, rule.point_type, runner)
    : null;
  const fallbackType = pointType ?? (await defaultPointType(tenantId, runner));

  const row = await queryOne<RewardRule>(
    runner,
    `INSERT INTO reward_rules (
       tenant_id, key, name, event_key, mode, points, points_per_unit,
       cooldown_seconds, daily_cap, weekly_cap, monthly_cap, lifetime_cap,
       max_per_award, log_template, hold_seconds,
       requires_verification, config, enabled, point_type
     -- Every default is applied here, in the statement, and the DO UPDATE
     -- below reads the *parameters* rather than EXCLUDED.
     --
     -- Both halves matter and the second is the one that was wrong. The
     -- parameters used to arrive already defaulted, in JavaScript: points to
     -- zero, event_key to custom.<key>, mode to fixed. So by the time the
     -- statement ran there was no NULL left for COALESCE(EXCLUDED.x, ...) to
     -- fall back from, and every field the caller omitted was overwritten
     -- with a default. A partial PUT -- which is what the WordPress
     -- earning-rules screen sends when an admin edits one field -- set points
     -- to zero and rewrote event_key to custom.<key>, so purchase earning
     -- stopped, silently, on a Save the admin had every reason to think was
     -- harmless. Moving the defaults into VALUES is not enough on its own,
     -- because EXCLUDED is the *proposed row* and would carry them too.
     ) VALUES ($1, $2, COALESCE($3, $2), COALESCE($4, 'custom.' || $2), COALESCE($5, 'fixed'),
               COALESCE($6, 0), COALESCE($7, 0), COALESCE($8, 0),
               $9, $10, $11, $12, $13, $14,
               COALESCE($15, 0), COALESCE($16, false), COALESCE($17::jsonb, '{}'::jsonb),
               COALESCE($18, true), COALESCE($19, $20))
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE($3, reward_rules.name),
       event_key = COALESCE($4, reward_rules.event_key),
       mode = COALESCE($5, reward_rules.mode),
       points = COALESCE($6, reward_rules.points),
       points_per_unit = COALESCE($7, reward_rules.points_per_unit),
       cooldown_seconds = COALESCE($8, reward_rules.cooldown_seconds),
       -- Caps are nullable by design: passing null is how an admin *removes*
       -- a cap, so these cannot use COALESCE like the others.
       daily_cap = EXCLUDED.daily_cap,
       weekly_cap = EXCLUDED.weekly_cap,
       monthly_cap = EXCLUDED.monthly_cap,
       lifetime_cap = EXCLUDED.lifetime_cap,
       max_per_award = EXCLUDED.max_per_award,
       log_template = EXCLUDED.log_template,
       hold_seconds = COALESCE($15, reward_rules.hold_seconds),
       requires_verification = COALESCE($16, reward_rules.requires_verification),
       config = COALESCE($17::jsonb, reward_rules.config),
       enabled = COALESCE($18, reward_rules.enabled),
       point_type = COALESCE($19, reward_rules.point_type),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      rule.key,
      rule.name ?? null,
      rule.event_key ?? null,
      rule.mode ?? null,
      rule.points ?? null,
      rule.points_per_unit ?? null,
      rule.cooldown_seconds ?? null,
      rule.daily_cap ?? null,
      rule.weekly_cap ?? null,
      rule.monthly_cap ?? null,
      rule.lifetime_cap ?? null,
      rule.max_per_award ?? null,
      rule.log_template ?? null,
      rule.hold_seconds ?? null,
      rule.requires_verification ?? null,
      rule.config ? JSON.stringify(rule.config) : null,
      rule.enabled ?? null,
      pointType?.key ?? null,
      fallbackType.key,
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

export async function tenantTimezone(tenantId: string, runner: Queryable): Promise<string> {
  const hit = timezoneCache.get(tenantId);
  if (hit && Date.now() - hit.at < TIMEZONE_TTL_MS) return hit.zone;

  const row = await queryOne<{ timezone: string | null }>(
    runner,
    'SELECT timezone FROM tenants WHERE id = $1',
    [tenantId],
  );
  const candidate = row?.timezone?.trim() || 'UTC';
  const zone = (await isKnownTimezone(candidate, runner)) ? candidate : 'UTC';
  timezoneCache.set(tenantId, { zone, at: Date.now() });
  return zone;
}

/** `+05:30`, `-08`, `+0530` — accepted by AT TIME ZONE, absent from the catalogues. */
const NUMERIC_OFFSET = /^[+-]\d{1,2}(:?\d{2})?$/;

/**
 * Is this a zone `AT TIME ZONE` will accept?
 *
 * Asked by looking it up, never by trying it. `SELECT now() AT TIME ZONE $1`
 * raises on an unknown name, and inside a transaction that raise aborts the
 * whole thing — so the catch that used to sit around it could set 'UTC' but
 * could not undo the abort. Every statement after it failed with "current
 * transaction is aborted", which meant a single typo'd timezone on a tenant
 * rolled back that customer's order, its commissions and its cart conversion,
 * once a minute forever.
 *
 * The catalogue lookup cannot raise, and covers every IANA name and
 * abbreviation. Numeric offsets are the one thing it misses, so they are
 * matched by shape.
 */
export async function isKnownTimezone(zone: string, runner: Queryable): Promise<boolean> {
  if (NUMERIC_OFFSET.test(zone)) return true;
  const row = await queryOne<{ ok: boolean }>(
    runner,
    `SELECT EXISTS (SELECT 1 FROM pg_timezone_names  WHERE name   = $1)
         OR EXISTS (SELECT 1 FROM pg_timezone_abbrevs WHERE abbrev = $1) AS ok`,
    [zone],
  );
  return row?.ok === true;
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
    if (!rule.enabled) return { awarded: false, reason: 'rule_disabled', balance: await getBalance(tenantId, input.contactId, client, rule.point_type) };

    // Excluded before anything else is computed: staff and test accounts
    // should not appear in cooldown state, cap totals or the ledger at all.
    const exclusion = await isExcluded(tenantId, input.contactId, client);
    if (exclusion.excluded) {
      return {
        awarded: false,
        reason: 'excluded',
        detail: exclusion.reason,
        balance: await getBalance(tenantId, input.contactId, client, rule.point_type),
      };
    }

    let points = pointsFor(rule, input.valueCents) + Math.max(0, input.bonusPoints ?? 0);

    // myCred's enforce_max(): clamp the award however the amount arrived, so a
    // mis-keyed order total cannot hand someone the whole budget.
    if (rule.max_per_award !== null && rule.max_per_award !== undefined) {
      points = Math.min(points, rule.max_per_award);
    }

    if (points <= 0) {
      return { awarded: false, reason: 'zero_points', balance: await getBalance(tenantId, input.contactId, client, rule.point_type) };
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
        return { awarded: false, reason: 'cooldown', balance: await getBalance(tenantId, input.contactId, client, rule.point_type) };
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
          balance: await getBalance(tenantId, input.contactId, client, rule.point_type),
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
        return { awarded: false, reason: 'lifetime_cap', balance: await getBalance(tenantId, input.contactId, client, rule.point_type) };
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
        // The contact is part of the key.
        //
        // Without it, any rule whose `refId` is not already unique per person
        // became one award for the whole store. A streak's ref is
        // `<key>:<date>`, so the first member to log in each day was paid and
        // every other member hit the borrowed-key guard — a 409 that, because
        // `recordStreak` runs the award in its own transaction, also rolled
        // back their streak. Their day simply vanished.
        idempotencyKey: `rule:${rule.key}:${input.contactId}:${input.refId}`,
        holdSeconds: rule.hold_seconds,
        pointType: rule.point_type,
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
            point_type: rule.point_type,
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
  /** The currency this board ranks. */
  point_type: string;
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
    /** Which currency to rank; the retailer's default when unset. */
    pointType?: string | null;
  } = {},
  runner: Queryable = db(),
): Promise<LeaderboardResult> {
  const limit = limitOf(options.limit, 10, 100);
  const window = options.window ?? 'all';

  // One board per currency. Summing them together would rank a member's
  // unspendable status credits against another's spendable points.
  const pointType = await resolvePointType(tenantId, options.pointType, runner);

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
              AND lower(coalesce(c.email_normalised, c.email, '')) LIKE '%@'
                  || replace(replace(replace(x.value, '\\', '\\\\'), '%', '\\%'), '_', '\\_'))
        OR (x.kind = 'tag'          AND x.value = ANY (SELECT lower(t) FROM unnest(c.tags) AS t))
        OR (x.kind = 'role'         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(contact_roles(c.attributes)) AS r
                WHERE lower(r) = x.value))
         )
    )`;

  const source =
    window === 'all'
      ? `SELECT b.contact_id, c.name, b.lifetime_earned::bigint AS points
           FROM points_balances b
           JOIN contacts c ON c.id = b.contact_id AND c.tenant_id = b.tenant_id
          WHERE b.tenant_id = $1 AND b.point_type = $2
            AND b.lifetime_earned > 0 AND ${notExcluded}`
      : `SELECT l.contact_id, c.name, SUM(l.delta_points)::bigint AS points
           FROM points_ledger l
           JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id
          WHERE l.tenant_id = $1
            AND l.point_type = $2
            AND l.delta_points > 0
            AND l.status <> 'reversed'
            -- Points that arrived from another member are not points earned
            -- this month, for the same reason they do not count towards a
            -- rank: otherwise a pair of accounts tops the board by passing the
            -- same points back and forth.
            AND (l.ref_type IS DISTINCT FROM 'transfer')
            AND l.created_at >= date_trunc($3, now())
            AND ${notExcluded}
          GROUP BY l.contact_id, c.name
         HAVING SUM(l.delta_points) > 0`;

  const params: unknown[] =
    window === 'all' ? [tenantId, pointType.key] : [tenantId, pointType.key, window];

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

  return { window, point_type: pointType.key, rows, you };
}

export function assertRuleKey(key: string): string {
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    throw ApiError.badRequest('Rule key must be 2-64 chars of a-z, 0-9 or underscore');
  }
  return key;
}
