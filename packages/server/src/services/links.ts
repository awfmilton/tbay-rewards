import { db, queryOne, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { hashPii, randomCode, signPayload, verifyPayload } from '../lib/crypto.js';
import { hostOf } from '../lib/attribution.js';
import { parseUserAgent } from '../lib/useragent.js';
import { ApiError } from '../lib/errors.js';
import type { Tenant } from './tenants.js';

export type LinkKind = 'campaign' | 'writer' | 'referral' | 'share';

export interface Link {
  id: string;
  tenant_id: string;
  code: string;
  kind: LinkKind;
  target_url: string;
  owner_contact_id: string | null;
  product_ref: string | null;
  post_ref: string | null;
  label: string | null;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  commission_rate_bps: number;
  clicks: number;
  disabled_at: Date | null;
}

export interface CreateLinkInput {
  targetUrl: string;
  kind?: LinkKind;
  ownerContactId?: string | null;
  productRef?: string | null;
  postRef?: string | null;
  label?: string | null;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  commissionRateBps?: number | null;
  code?: string | null;
}

export function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw ApiError.badRequest('target_url must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ApiError.badRequest('target_url must be http or https');
  }
  return parsed.toString();
}

export async function createLink(
  tenantId: string,
  input: CreateLinkInput,
  runner: Queryable = db(),
): Promise<Link> {
  const targetUrl = assertHttpUrl(input.targetUrl);
  const kind = input.kind ?? 'campaign';
  const rate =
    input.commissionRateBps ??
    (kind === 'writer' ? config().commissions.defaultRateBps : 0);

  // Retry on the (astronomically unlikely) code collision rather than failing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = input.code ?? randomCode(kind === 'writer' ? 10 : 8);
    const link = await queryOne<Link>(
      runner,
      `INSERT INTO links (
         tenant_id, code, kind, target_url, owner_contact_id, product_ref, post_ref,
         label, source, medium, campaign, commission_rate_bps
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (code) DO NOTHING
       RETURNING *`,
      [
        tenantId,
        code,
        kind,
        targetUrl,
        input.ownerContactId ?? null,
        input.productRef ?? null,
        input.postRef ?? null,
        input.label ?? null,
        input.source ?? null,
        input.medium ?? null,
        input.campaign ?? null,
        Math.max(0, Math.min(10_000, Math.trunc(rate))),
      ],
    );
    if (link) return link;
    if (input.code) throw ApiError.conflict(`Link code "${input.code}" is already taken`);
  }
  throw new Error('Could not allocate a unique link code');
}

export async function getLinkByCode(code: string, runner: Queryable = db()): Promise<Link | null> {
  return queryOne<Link>(runner, 'SELECT * FROM links WHERE code = $1', [code]);
}

export async function listLinks(
  tenantId: string,
  filter: { ownerContactId?: string; kind?: LinkKind; postRef?: string; limit?: number } = {},
  runner: Queryable = db(),
): Promise<Link[]> {
  const { rows } = await runner.query<Link>(
    `SELECT * FROM links
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR owner_contact_id = $2)
        AND ($3::text IS NULL OR kind = $3)
        AND ($4::text IS NULL OR post_ref = $4)
      ORDER BY created_at DESC
      LIMIT $5`,
    [
      tenantId,
      filter.ownerContactId ?? null,
      filter.kind ?? null,
      filter.postRef ?? null,
      Math.min(filter.limit ?? 100, 500),
    ],
  );
  return rows;
}

export interface ClickContext {
  visitorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  landingUrl?: string | null;
  country?: string | null;
}

export interface RecordedClick {
  clickUuid: string;
  isBot: boolean;
}

/**
 * Record a click on a trackable link.
 *
 * Bot hits are stored (so the link report can show them) but never counted into
 * the public click total or used for attribution or share verification.
 */
export async function recordClick(
  runner: Queryable,
  tenant: Tenant,
  link: Link,
  ctx: ClickContext,
): Promise<RecordedClick> {
  const ua = parseUserAgent(ctx.userAgent);

  const row = await queryOne<{ click_uuid: string }>(
    runner,
    `INSERT INTO link_clicks (
       tenant_id, link_id, visitor_id, ip_hash, ua_hash, referrer_host,
       landing_url, country, is_bot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING click_uuid`,
    [
      tenant.id,
      link.id,
      ctx.visitorId ?? null,
      ctx.ip ? hashPii(ctx.ip, tenant.pii_salt) : null,
      ctx.userAgent ? hashPii(ctx.userAgent, tenant.pii_salt) : null,
      hostOf(ctx.referrer),
      ctx.landingUrl ? ctx.landingUrl.slice(0, 2048) : null,
      ctx.country ?? null,
      ua.isBot,
    ],
  );

  if (!ua.isBot) {
    await runner.query('UPDATE links SET clicks = clicks + 1 WHERE id = $1', [link.id]);
  }

  return { clickUuid: row!.click_uuid, isBot: ua.isBot };
}

export interface AttributionCookie {
  /** link code */
  c: string;
  /** click uuid */
  u: string;
  /** owner contact id, when the link earns commission */
  o?: string;
  /** issued-at, epoch seconds */
  t: number;
  /** tenant id */
  n: string;
}

export const ATTRIBUTION_COOKIE = 'tbay_attr';

export function issueAttributionCookie(
  tenantId: string,
  link: Link,
  clickUuid: string,
): { name: string; value: string; maxAge: number } {
  const payload: AttributionCookie = {
    c: link.code,
    u: clickUuid,
    t: Math.floor(Date.now() / 1000),
    n: tenantId,
    ...(link.owner_contact_id ? { o: link.owner_contact_id } : {}),
  };
  return {
    name: ATTRIBUTION_COOKIE,
    value: signPayload(payload),
    maxAge: config().commissions.attributionWindowDays * 24 * 60 * 60,
  };
}

/** Read and validate an attribution cookie, enforcing the attribution window. */
export function readAttributionCookie(raw: string | undefined, tenantId: string): AttributionCookie | null {
  if (!raw) return null;
  const payload = verifyPayload<AttributionCookie>(raw);
  if (!payload || payload.n !== tenantId) return null;

  const ageSeconds = Math.floor(Date.now() / 1000) - payload.t;
  if (ageSeconds > config().commissions.attributionWindowDays * 24 * 60 * 60) return null;
  return payload;
}

export interface LinkReportRow {
  code: string;
  kind: string;
  label: string | null;
  target_url: string;
  post_ref: string | null;
  product_ref: string | null;
  clicks: number;
  human_clicks: number;
  orders: number;
  revenue_cents: number;
  commission_cents: number;
}

export async function linkReport(
  tenantId: string,
  filter: { ownerContactId?: string; from?: Date; to?: Date; limit?: number } = {},
  runner: Queryable = db(),
): Promise<LinkReportRow[]> {
  const { rows } = await runner.query<LinkReportRow>(
    `SELECT l.code, l.kind, l.label, l.target_url, l.post_ref, l.product_ref,
            l.clicks,
            COALESCE(cl.human_clicks, 0)::bigint       AS human_clicks,
            COALESCE(cm.orders, 0)::bigint             AS orders,
            COALESCE(cm.revenue_cents, 0)::bigint      AS revenue_cents,
            COALESCE(cm.commission_cents, 0)::bigint   AS commission_cents
       FROM links l
       LEFT JOIN (
         SELECT link_id, COUNT(*) AS human_clicks
           FROM link_clicks
          WHERE tenant_id = $1 AND NOT is_bot
            AND ($2::timestamptz IS NULL OR occurred_at >= $2)
            AND ($3::timestamptz IS NULL OR occurred_at <= $3)
          GROUP BY link_id
       ) cl ON cl.link_id = l.id
       LEFT JOIN (
         SELECT link_id,
                COUNT(DISTINCT order_ref) AS orders,
                SUM(subtotal_cents)       AS revenue_cents,
                SUM(amount_cents)         AS commission_cents
           FROM commissions
          WHERE tenant_id = $1 AND status <> 'void'
          GROUP BY link_id
       ) cm ON cm.link_id = l.id
      WHERE l.tenant_id = $1
        AND ($4::uuid IS NULL OR l.owner_contact_id = $4)
      ORDER BY COALESCE(cm.commission_cents, 0) DESC, l.clicks DESC
      LIMIT $5`,
    [
      tenantId,
      filter.from ?? null,
      filter.to ?? null,
      filter.ownerContactId ?? null,
      Math.min(filter.limit ?? 100, 500),
    ],
  );
  return rows;
}
