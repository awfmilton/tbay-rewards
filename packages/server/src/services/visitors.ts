import { queryOne, type Queryable } from '../db/pool.js';
import { hashPii } from '../lib/crypto.js';
import { parseUserAgent } from '../lib/useragent.js';
import { resolveTouchpoint, hostOf } from '../lib/attribution.js';
import type { Tenant } from './tenants.js';

export interface Visitor {
  id: string;
  tenant_id: string;
  anon_id: string;
  contact_id: string | null;
}

export interface Session {
  id: string;
  tenant_id: string;
  visitor_id: string;
  contact_id: string | null;
  client_session_id: string;
  device_class: string | null;
  is_bot: boolean;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  link_code: string | null;
  started_at: Date;
}

export interface SessionContext {
  clientSessionId: string;
  url?: string | null;
  referrer?: string | null;
  linkCode?: string | null;
  userAgent?: string | null;
  ip?: string | null;
  country?: string | null;
}

export async function upsertVisitor(
  runner: Queryable,
  tenantId: string,
  anonId: string,
): Promise<Visitor> {
  const visitor = await queryOne<Visitor>(
    runner,
    `INSERT INTO visitors (tenant_id, anon_id) VALUES ($1, $2)
     ON CONFLICT (tenant_id, anon_id)
     DO UPDATE SET last_seen_at = now()
     RETURNING *`,
    [tenantId, anonId],
  );
  return visitor!;
}

/**
 * Find or open the session for a tracker-supplied session id.
 *
 * The tracker owns session identity (it knows about tab focus and the idle
 * timeout), so the server trusts the id and only reconstructs the acquisition
 * context. A brand-new session records a touchpoint; continuing ones do not, so
 * internal navigation never overwrites the original source.
 */
export async function resolveSession(
  runner: Queryable,
  tenant: Tenant,
  visitor: Visitor,
  ctx: SessionContext,
  selfHosts: string[],
): Promise<{ session: Session; isNew: boolean }> {
  const existing = await queryOne<Session>(
    runner,
    'SELECT * FROM sessions WHERE tenant_id = $1 AND client_session_id = $2',
    [tenant.id, ctx.clientSessionId],
  );
  if (existing) {
    await runner.query('UPDATE sessions SET last_event_at = now() WHERE id = $1', [existing.id]);
    return { session: existing, isNew: false };
  }

  const ua = parseUserAgent(ctx.userAgent);
  const touch = resolveTouchpoint(
    { url: ctx.url, referrer: ctx.referrer, linkCode: ctx.linkCode },
    selfHosts,
  );

  const created = await queryOne<Session>(
    runner,
    `INSERT INTO sessions (
       tenant_id, visitor_id, contact_id, client_session_id, entry_path,
       referrer_url, referrer_host, source, medium, campaign, term, content, link_code,
       device_class, os, browser, country, ip_hash, ua_hash, is_bot
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
     )
     ON CONFLICT (tenant_id, client_session_id) DO UPDATE SET last_event_at = now()
     RETURNING *`,
    [
      tenant.id,
      visitor.id,
      visitor.contact_id,
      ctx.clientSessionId,
      touch.landingPath,
      touch.referrerUrl,
      touch.referrerHost,
      touch.source,
      touch.medium,
      touch.campaign,
      touch.term,
      touch.content,
      touch.linkCode,
      ua.deviceClass,
      ua.os,
      ua.browser,
      ctx.country ?? null,
      ctx.ip ? hashPii(ctx.ip, tenant.pii_salt) : null,
      ctx.userAgent ? hashPii(ctx.userAgent, tenant.pii_salt) : null,
      ua.isBot,
    ],
  );

  // Only real people count toward acquisition and session totals.
  if (!ua.isBot) {
    await runner.query(
      'UPDATE visitors SET session_count = session_count + 1, last_seen_at = now() WHERE id = $1',
      [visitor.id],
    );
    await runner.query(
      `INSERT INTO touchpoints (
         tenant_id, visitor_id, session_id, contact_id, source, medium, campaign,
         term, content, referrer_url, referrer_host, landing_path, link_code
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tenant.id,
        visitor.id,
        created!.id,
        visitor.contact_id,
        touch.source,
        touch.medium,
        touch.campaign,
        touch.term,
        touch.content,
        touch.referrerUrl,
        touch.referrerHost,
        touch.landingPath,
        touch.linkCode,
      ],
    );
  }

  return { session: created!, isNew: true };
}

/**
 * Attach every trace of a visitor to a contact once they identify themselves,
 * so earlier anonymous browsing keeps its attribution.
 */
export async function linkVisitorToContact(
  runner: Queryable,
  tenantId: string,
  visitorId: string,
  contactId: string,
): Promise<void> {
  await maybeRecordReferral(runner, tenantId, visitorId, contactId);

  await runner.query(
    'UPDATE visitors SET contact_id = $3 WHERE tenant_id = $1 AND id = $2 AND contact_id IS DISTINCT FROM $3',
    [tenantId, visitorId, contactId],
  );
  await runner.query(
    'UPDATE sessions SET contact_id = $3 WHERE tenant_id = $1 AND visitor_id = $2 AND contact_id IS NULL',
    [tenantId, visitorId, contactId],
  );
  await runner.query(
    'UPDATE touchpoints SET contact_id = $3 WHERE tenant_id = $1 AND visitor_id = $2 AND contact_id IS NULL',
    [tenantId, visitorId, contactId],
  );
  await runner.query(
    'UPDATE carts SET contact_id = $3 WHERE tenant_id = $1 AND visitor_id = $2 AND contact_id IS NULL',
    [tenantId, visitorId, contactId],
  );
}

/**
 * If this visitor arrived on a referral link, credit whoever owns it.
 *
 * Runs at the moment an anonymous visitor becomes a known contact, which is the
 * only point where both halves — the link that brought them and the identity
 * they just created — are known.
 */
async function maybeRecordReferral(
  runner: Queryable,
  tenantId: string,
  visitorId: string,
  contactId: string,
): Promise<void> {
  const touch = await queryOne<{ link_code: string | null }>(
    runner,
    `SELECT link_code FROM touchpoints
      WHERE tenant_id = $1 AND visitor_id = $2 AND link_code IS NOT NULL
      ORDER BY occurred_at ASC LIMIT 1`,
    [tenantId, visitorId],
  );
  if (!touch?.link_code) return;

  const link = await queryOne<{ id: string; owner_contact_id: string | null; kind: string }>(
    runner,
    'SELECT id, owner_contact_id, kind FROM links WHERE tenant_id = $1 AND code = $2',
    [tenantId, touch.link_code],
  );
  // Campaign and writer links pay commission instead; only member-owned
  // referral and share links create a referral relationship.
  if (!link?.owner_contact_id) return;
  if (link.kind !== 'referral' && link.kind !== 'share') return;

  const { recordReferral } = await import('./contacts.js');
  await recordReferral(runner, tenantId, link.owner_contact_id, contactId, link.id);
}

export function selfHostsFor(tenant: Tenant): string[] {
  const hosts: string[] = [];
  const siteUrl = tenant.settings?.siteUrl;
  if (typeof siteUrl === 'string') {
    const host = hostOf(siteUrl);
    if (host) hosts.push(host);
  }
  return hosts;
}
