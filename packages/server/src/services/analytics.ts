import { db, queryOne, type Queryable } from '../db/pool.js';

/** Read-side aggregates for the dashboard and the WordPress admin screens. */

export interface Overview {
  sessions: number;
  visitors: number;
  pageviews: number;
  orders: number;
  revenue_cents: number;
  conversion_rate: number;
  new_contacts: number;
  subscribers: number;
  points_awarded: number;
  points_redeemed: number;
}

export async function overview(
  tenantId: string,
  from: Date,
  to: Date,
  runner: Queryable = db(),
): Promise<Overview> {
  const traffic = await queryOne<Record<string, string>>(
    runner,
    `SELECT COUNT(*)::bigint                    AS sessions,
            COUNT(DISTINCT visitor_id)::bigint  AS visitors,
            COALESCE(SUM(pageviews), 0)::bigint AS pageviews
       FROM sessions
      WHERE tenant_id = $1 AND started_at >= $2 AND started_at <= $3 AND NOT is_bot`,
    [tenantId, from, to],
  );

  const commerce = await queryOne<Record<string, string>>(
    runner,
    `SELECT COUNT(*)::bigint                        AS orders,
            COALESCE(SUM(total_cents), 0)::bigint   AS revenue_cents
       FROM orders
      WHERE tenant_id = $1 AND placed_at >= $2 AND placed_at <= $3 AND status <> 'refunded'`,
    [tenantId, from, to],
  );

  const audience = await queryOne<Record<string, string>>(
    runner,
    `SELECT
       (SELECT COUNT(*) FROM contacts
         WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3)      AS new_contacts,
       (SELECT COUNT(*) FROM subscriptions
         WHERE tenant_id = $1 AND status = 'subscribed')                      AS subscribers`,
    [tenantId, from, to],
  );

  const points = await queryOne<Record<string, string>>(
    runner,
    `SELECT COALESCE(SUM(delta_points) FILTER (WHERE delta_points > 0), 0)::bigint  AS awarded,
            COALESCE(-SUM(delta_points) FILTER (WHERE delta_points < 0), 0)::bigint AS redeemed
       FROM points_ledger
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND status <> 'reversed'`,
    [tenantId, from, to],
  );

  const sessions = Number(traffic?.sessions ?? 0);
  const orders = Number(commerce?.orders ?? 0);

  return {
    sessions,
    visitors: Number(traffic?.visitors ?? 0),
    pageviews: Number(traffic?.pageviews ?? 0),
    orders,
    revenue_cents: Number(commerce?.revenue_cents ?? 0),
    conversion_rate: sessions > 0 ? Math.round((orders / sessions) * 10_000) / 10_000 : 0,
    new_contacts: Number(audience?.new_contacts ?? 0),
    subscribers: Number(audience?.subscribers ?? 0),
    points_awarded: Number(points?.awarded ?? 0),
    points_redeemed: Number(points?.redeemed ?? 0),
  };
}

export interface SourceRow {
  source: string;
  medium: string | null;
  sessions: number;
  visitors: number;
  orders: number;
  revenue_cents: number;
  conversion_rate: number;
}

/**
 * Where customers came from, with revenue attributed last-touch.
 *
 * Last-touch is the default because it is what a merchant can act on today;
 * `orders.first_touch` keeps the first-touch record for anyone who wants to
 * build a multi-touch model on top.
 */
export async function trafficSources(
  tenantId: string,
  from: Date,
  to: Date,
  limit = 50,
  runner: Queryable = db(),
): Promise<SourceRow[]> {
  const { rows } = await runner.query<SourceRow>(
    `WITH traffic AS (
       SELECT source, medium,
              COUNT(*) AS sessions,
              COUNT(DISTINCT visitor_id) AS visitors
         FROM sessions
        WHERE tenant_id = $1 AND started_at >= $2 AND started_at <= $3 AND NOT is_bot
        GROUP BY source, medium
     ),
     converted AS (
       SELECT COALESCE(last_touch->>'source', 'direct') AS source,
              last_touch->>'medium'                     AS medium,
              COUNT(*) AS orders,
              SUM(total_cents) AS revenue_cents
         FROM orders
        WHERE tenant_id = $1 AND placed_at >= $2 AND placed_at <= $3 AND status <> 'refunded'
        GROUP BY 1, 2
     )
     SELECT COALESCE(t.source, c.source)            AS source,
            COALESCE(t.medium, c.medium)            AS medium,
            COALESCE(t.sessions, 0)::bigint         AS sessions,
            COALESCE(t.visitors, 0)::bigint         AS visitors,
            COALESCE(c.orders, 0)::bigint           AS orders,
            COALESCE(c.revenue_cents, 0)::bigint    AS revenue_cents,
            CASE WHEN COALESCE(t.sessions, 0) > 0
                 THEN ROUND(COALESCE(c.orders, 0)::numeric / t.sessions, 4)
                 ELSE 0 END                          AS conversion_rate
       FROM traffic t
       FULL OUTER JOIN converted c
         ON c.source = t.source AND c.medium IS NOT DISTINCT FROM t.medium
      ORDER BY COALESCE(c.revenue_cents, 0) DESC, COALESCE(t.sessions, 0) DESC
      LIMIT $4`,
    [tenantId, from, to, Math.min(limit, 200)],
  );
  return rows.map((row) => ({ ...row, conversion_rate: Number(row.conversion_rate) }));
}

export interface PageRow {
  path: string;
  pageviews: number;
  visitors: number;
}

export async function topPages(
  tenantId: string,
  from: Date,
  to: Date,
  limit = 25,
  runner: Queryable = db(),
): Promise<PageRow[]> {
  const { rows } = await runner.query<PageRow>(
    `SELECT e.path,
            COUNT(*)::bigint                     AS pageviews,
            COUNT(DISTINCT e.visitor_id)::bigint AS visitors
       FROM events e
       -- is_bot lives on the session, not the event, which is why this was
       -- the one figure on the dashboard that still counted crawlers: the
       -- pages a merchandiser reorders the shop around were whichever ones a
       -- bot happened to like. A LEFT JOIN, because a server-side event
       -- carries no session and is not a crawler.
       LEFT JOIN sessions s ON s.id = e.session_id
      WHERE e.tenant_id = $1 AND e.type = 'pageview' AND e.path IS NOT NULL
        AND COALESCE(s.is_bot, false) = false
        AND e.occurred_at >= $2 AND e.occurred_at <= $3
      GROUP BY e.path
      ORDER BY COUNT(*) DESC
      LIMIT $4`,
    [tenantId, from, to, Math.min(limit, 200)],
  );
  return rows;
}

export interface BlogLinkRow {
  post_ref: string | null;
  code: string;
  label: string | null;
  writer_name: string | null;
  writer_contact_id: string | null;
  clicks: number;
  orders: number;
  revenue_cents: number;
  commission_cents: number;
}

/** What blog writers earned, and from which post. */
export async function blogLinkPerformance(
  tenantId: string,
  from: Date,
  to: Date,
  limit = 100,
  runner: Queryable = db(),
): Promise<BlogLinkRow[]> {
  const { rows } = await runner.query<BlogLinkRow>(
    `SELECT l.post_ref, l.code, l.label,
            c.name AS writer_name,
            l.owner_contact_id AS writer_contact_id,
            COALESCE(clicks.total, 0)::bigint            AS clicks,
            COALESCE(comm.orders, 0)::bigint             AS orders,
            COALESCE(comm.revenue_cents, 0)::bigint      AS revenue_cents,
            COALESCE(comm.commission_cents, 0)::bigint   AS commission_cents
       FROM links l
       LEFT JOIN contacts c ON c.id = l.owner_contact_id
       LEFT JOIN (
         SELECT link_id, COUNT(*) AS total
           FROM link_clicks
          WHERE tenant_id = $1 AND NOT is_bot AND occurred_at >= $2 AND occurred_at <= $3
          GROUP BY link_id
       ) clicks ON clicks.link_id = l.id
       LEFT JOIN (
         SELECT link_id, COUNT(DISTINCT order_ref) AS orders,
                SUM(subtotal_cents) AS revenue_cents, SUM(amount_cents) AS commission_cents
           FROM commissions
          WHERE tenant_id = $1 AND status <> 'void' AND created_at >= $2 AND created_at <= $3
          GROUP BY link_id
       ) comm ON comm.link_id = l.id
      WHERE l.tenant_id = $1 AND l.kind = 'writer'
      ORDER BY COALESCE(comm.commission_cents, 0) DESC, COALESCE(clicks.total, 0) DESC
      LIMIT $4`,
    [tenantId, from, to, Math.min(limit, 500)],
  );
  return rows;
}

export interface RewardsReport {
  members_with_points: number;
  total_balance: number;
  total_pending: number;
  lifetime_awarded: number;
  lifetime_redeemed: number;
  tokens_claimed_wei: string;
  claims_signed: number;
  claims_completed: number;
  shares_pending: number;
  shares_verified: number;
}

export async function rewardsReport(
  tenantId: string,
  runner: Queryable = db(),
): Promise<RewardsReport> {
  const balances = await queryOne<Record<string, string>>(
    runner,
    `SELECT COUNT(*)::bigint                        AS members_with_points,
            COALESCE(SUM(balance), 0)::bigint       AS total_balance,
            COALESCE(SUM(pending), 0)::bigint       AS total_pending,
            COALESCE(SUM(lifetime_earned), 0)::bigint AS lifetime_awarded,
            COALESCE(SUM(lifetime_spent), 0)::bigint  AS lifetime_redeemed
       FROM points_balances WHERE tenant_id = $1`,
    [tenantId],
  );

  const claims = await queryOne<Record<string, string>>(
    runner,
    `SELECT COUNT(*) FILTER (WHERE status = 'signed')::bigint  AS claims_signed,
            COUNT(*) FILTER (WHERE status = 'claimed')::bigint AS claims_completed,
            COALESCE(SUM(token_amount_wei) FILTER (WHERE status = 'claimed'), 0)::text AS tokens_claimed_wei
       FROM token_claims WHERE tenant_id = $1`,
    [tenantId],
  );

  const shares = await queryOne<Record<string, string>>(
    runner,
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::bigint  AS shares_pending,
            COUNT(*) FILTER (WHERE status = 'verified')::bigint AS shares_verified
       FROM share_events WHERE tenant_id = $1`,
    [tenantId],
  );

  return {
    members_with_points: Number(balances?.members_with_points ?? 0),
    total_balance: Number(balances?.total_balance ?? 0),
    total_pending: Number(balances?.total_pending ?? 0),
    lifetime_awarded: Number(balances?.lifetime_awarded ?? 0),
    lifetime_redeemed: Number(balances?.lifetime_redeemed ?? 0),
    tokens_claimed_wei: String(claims?.tokens_claimed_wei ?? '0'),
    claims_signed: Number(claims?.claims_signed ?? 0),
    claims_completed: Number(claims?.claims_completed ?? 0),
    shares_pending: Number(shares?.shares_pending ?? 0),
    shares_verified: Number(shares?.shares_verified ?? 0),
  };
}

export interface TimeseriesPoint {
  bucket: string;
  sessions: number;
  pageviews: number;
  orders: number;
  revenue_cents: number;
}

export async function timeseries(
  tenantId: string,
  from: Date,
  to: Date,
  runner: Queryable = db(),
): Promise<TimeseriesPoint[]> {
  const { rows } = await runner.query<TimeseriesPoint>(
    `WITH days AS (
       SELECT generate_series(date_trunc('day', $2::timestamptz),
                              date_trunc('day', $3::timestamptz),
                              '1 day')::date AS bucket
     )
     SELECT to_char(d.bucket, 'YYYY-MM-DD') AS bucket,
            COALESCE(s.sessions, 0)::bigint      AS sessions,
            COALESCE(s.pageviews, 0)::bigint     AS pageviews,
            COALESCE(o.orders, 0)::bigint        AS orders,
            COALESCE(o.revenue_cents, 0)::bigint AS revenue_cents
       FROM days d
       LEFT JOIN (
         SELECT date_trunc('day', started_at)::date AS bucket,
                COUNT(*) AS sessions, SUM(pageviews) AS pageviews
           FROM sessions
          WHERE tenant_id = $1 AND NOT is_bot AND started_at >= $2 AND started_at <= $3
          GROUP BY 1
       ) s ON s.bucket = d.bucket
       LEFT JOIN (
         SELECT date_trunc('day', placed_at)::date AS bucket,
                COUNT(*) AS orders, SUM(total_cents) AS revenue_cents
           FROM orders
          WHERE tenant_id = $1 AND status <> 'refunded' AND placed_at >= $2 AND placed_at <= $3
          GROUP BY 1
       ) o ON o.bucket = d.bucket
      ORDER BY d.bucket`,
    [tenantId, from, to],
  );
  return rows;
}
