import { db, type Queryable } from '../db/pool.js';
import { limitOf } from '../lib/paging.js';

/**
 * Everything that happened to one contact, in one list.
 *
 * Sessions, orders, carts, points, email, badges and automation runs were all
 * stored per contact and there was no way to see them together, so answering
 * "what happened to this customer" meant querying six tables by hand. That is
 * the single most common question support asks, and the reason people keep
 * Mautic around.
 *
 * Built as a UNION of small, independently-indexed queries rather than one
 * clever join: each arm hits an index on (contact_id, time), and adding a
 * seventh source later is a new arm rather than a rewrite.
 */

export type TimelineKind =
  | 'session'
  | 'order'
  | 'cart_abandoned'
  | 'points'
  | 'email_sent'
  | 'email_opened'
  | 'email_clicked'
  | 'badge'
  | 'rank'
  | 'automation'
  | 'share'
  | 'token_claim';

export interface TimelineEntry {
  kind: TimelineKind;
  occurred_at: Date;
  title: string;
  detail: string | null;
  /** Points, money in cents, or a count — whatever the row's number means. */
  amount: number | null;
  ref: string | null;
}

export interface TimelineOptions {
  limit?: number;
  before?: Date | null;
  kinds?: TimelineKind[] | null;
}

export async function contactTimeline(
  tenantId: string,
  contactId: string,
  options: TimelineOptions = {},
  runner: Queryable = db(),
): Promise<TimelineEntry[]> {
  const limit = limitOf(options.limit, 50, 500);
  const before = options.before ?? null;

  // Each arm is bounded by the same limit before the union, so a contact with
  // fifty thousand page views cannot crowd out their three orders.
  const { rows } = await runner.query<TimelineEntry>(
    `WITH
     sessions_t AS (
       SELECT 'session'::text AS kind, s.started_at AS occurred_at,
              COALESCE(s.entry_path, 'Visited the site') AS title,
              NULLIF(s.source, '') AS detail,
              s.pageviews::int AS amount,
              s.id::text AS ref
         FROM sessions s
         LEFT JOIN visitors v ON v.id = s.visitor_id
        -- Either link counts: a session carries its own contact_id once
        -- identified, and linkVisitorToContact backfills the visitor for
        -- sessions that happened before the person gave an email address.
        WHERE s.tenant_id = $1 AND (s.contact_id = $2 OR v.contact_id = $2)
        ORDER BY s.started_at DESC LIMIT $3
     ),
     orders_t AS (
       SELECT 'order'::text, o.placed_at,
              'Placed order ' || o.order_ref,
              o.status,
              o.total_cents::int,
              o.order_ref
         FROM orders o
        WHERE o.tenant_id = $1 AND o.contact_id = $2
        ORDER BY o.placed_at DESC LIMIT $3
     ),
     carts_t AS (
       SELECT 'cart_abandoned'::text, c.abandoned_at,
              'Abandoned a cart',
              'stage ' || c.recovery_stage::text,
              c.subtotal_cents::int,
              c.id::text
         FROM carts c
        WHERE c.tenant_id = $1 AND c.contact_id = $2 AND c.abandoned_at IS NOT NULL
        ORDER BY c.abandoned_at DESC LIMIT $3
     ),
     points_t AS (
       SELECT 'points'::text, l.created_at,
              l.reason,
              l.status,
              l.delta_points,
              COALESCE(l.rule_key, l.ref_type)
         FROM points_ledger l
        WHERE l.tenant_id = $1 AND l.contact_id = $2
        ORDER BY l.created_at DESC LIMIT $3
     ),
     email_sent_t AS (
       SELECT 'email_sent'::text, m.sent_at,
              m.subject, m.template_key, NULL::int, m.id::text
         FROM email_messages m
        WHERE m.tenant_id = $1 AND m.contact_id = $2 AND m.sent_at IS NOT NULL
        ORDER BY m.sent_at DESC LIMIT $3
     ),
     email_engagement_t AS (
       SELECT ('email_' || e.kind || CASE WHEN e.kind = 'open' THEN 'ed' ELSE 'ed' END)::text,
              e.occurred_at,
              COALESCE(m.subject, 'An email'),
              e.url,
              NULL::int,
              e.message_id::text
         FROM email_events e
         LEFT JOIN email_messages m ON m.id = e.message_id
        WHERE e.tenant_id = $1 AND e.contact_id = $2 AND NOT e.is_bot
        ORDER BY e.occurred_at DESC LIMIT $3
     ),
     badges_t AS (
       SELECT 'badge'::text, a.awarded_at,
              'Earned ' || b.name, 'level ' || a.level::text, a.level, b.key
         FROM badge_awards a JOIN badges b ON b.id = a.badge_id
        WHERE a.tenant_id = $1 AND a.contact_id = $2
        ORDER BY a.awarded_at DESC LIMIT $3
     ),
     ranks_t AS (
       SELECT 'rank'::text, ra.awarded_at,
              'Reached ' || r.name,
              CASE WHEN ra.manual THEN 'assigned by an admin' ELSE NULL END,
              NULL::int, r.key
         FROM rank_awards ra JOIN ranks r ON r.id = ra.rank_id
        WHERE ra.tenant_id = $1 AND ra.contact_id = $2
        ORDER BY ra.awarded_at DESC LIMIT $3
     ),
     automations_t AS (
       SELECT 'automation'::text, ar.created_at,
              a.name, ar.status, ar.step_index, a.key
         FROM automation_runs ar JOIN automations a ON a.id = ar.automation_id
        WHERE ar.tenant_id = $1 AND ar.contact_id = $2
        ORDER BY ar.created_at DESC LIMIT $3
     ),
     shares_t AS (
       SELECT 'share'::text, se.created_at,
              'Shared on ' || se.network, se.status, se.points_awarded, se.id::text
         FROM share_events se
        WHERE se.tenant_id = $1 AND se.contact_id = $2
        ORDER BY se.created_at DESC LIMIT $3
     ),
     claims_t AS (
       SELECT 'token_claim'::text, tc.created_at,
              'Redeemed points for TBAY', tc.status, tc.points_spent, tc.id::text
         FROM token_claims tc
        WHERE tc.tenant_id = $1 AND tc.contact_id = $2
        ORDER BY tc.created_at DESC LIMIT $3
     ),
     merged AS (
       SELECT * FROM sessions_t
       UNION ALL SELECT * FROM orders_t
       UNION ALL SELECT * FROM carts_t
       UNION ALL SELECT * FROM points_t
       UNION ALL SELECT * FROM email_sent_t
       UNION ALL SELECT * FROM email_engagement_t
       UNION ALL SELECT * FROM badges_t
       UNION ALL SELECT * FROM ranks_t
       UNION ALL SELECT * FROM automations_t
       UNION ALL SELECT * FROM shares_t
       UNION ALL SELECT * FROM claims_t
     )
     SELECT kind, occurred_at, title, detail, amount, ref
       FROM merged
      WHERE occurred_at IS NOT NULL
        AND ($4::timestamptz IS NULL OR occurred_at < $4)
        AND ($5::text[] IS NULL OR kind = ANY($5))
      ORDER BY occurred_at DESC
      LIMIT $3`,
    [tenantId, contactId, limit, before, options.kinds ?? null],
  );

  return rows;
}

/** Headline numbers to sit above the timeline. */
export async function contactSummary(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<{
  orders: number;
  total_spent_cents: number;
  points_balance: number;
  lifetime_points: number;
  emails_sent: number;
  emails_opened: number;
  sessions: number;
  first_seen: Date | null;
  last_seen: Date | null;
}> {
  const { rows } = await runner.query(
    `SELECT
       (SELECT COUNT(*) FROM orders o
         WHERE o.tenant_id = $1 AND o.contact_id = $2 AND o.status <> 'refunded')::int AS orders,
       (SELECT COALESCE(SUM(o.total_cents), 0) FROM orders o
         WHERE o.tenant_id = $1 AND o.contact_id = $2 AND o.status <> 'refunded')::int
         AS total_spent_cents,
       (SELECT COALESCE(b.balance, 0) FROM points_balances b
         WHERE b.tenant_id = $1 AND b.contact_id = $2)::int AS points_balance,
       (SELECT COALESCE(b.lifetime_earned, 0) FROM points_balances b
         WHERE b.tenant_id = $1 AND b.contact_id = $2)::int AS lifetime_points,
       (SELECT COUNT(*) FROM email_messages m
         WHERE m.tenant_id = $1 AND m.contact_id = $2 AND m.status = 'sent')::int AS emails_sent,
       (SELECT COUNT(*) FROM email_messages m
         WHERE m.tenant_id = $1 AND m.contact_id = $2 AND m.opened_at IS NOT NULL)::int
         AS emails_opened,
       (SELECT COUNT(*) FROM sessions s LEFT JOIN visitors v ON v.id = s.visitor_id
         WHERE s.tenant_id = $1 AND (s.contact_id = $2 OR v.contact_id = $2))::int AS sessions,
       (SELECT c.first_seen_at FROM contacts c WHERE c.id = $2) AS first_seen,
       (SELECT c.last_seen_at FROM contacts c WHERE c.id = $2) AS last_seen`,
    [tenantId, contactId],
  );

  return rows[0] as never;
}
