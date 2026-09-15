import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { randomCode } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import { createLink, getLinkByCode, type Link } from './links.js';
import { trigger } from './rewards.js';
import type { Tenant } from './tenants.js';

/**
 * Social sharing rewards, without trusting the client.
 *
 * Clicking a share button proves nothing — the window may never be posted. So a
 * share creates a *pending* record plus a unique trackable link, and points are
 * only awarded once that link is actually clicked by someone else. That makes a
 * fake share worthless: you would have to generate real referred traffic to earn.
 */

export const SUPPORTED_NETWORKS = [
  'x',
  'facebook',
  'linkedin',
  'pinterest',
  'reddit',
  'whatsapp',
  'telegram',
  'email',
  'copy',
] as const;

export type ShareNetwork = (typeof SUPPORTED_NETWORKS)[number];

export interface ShareEvent {
  id: string;
  tenant_id: string;
  contact_id: string;
  network: string;
  target_url: string;
  share_url: string | null;
  link_id: string | null;
  share_token: string;
  status: 'pending' | 'verified' | 'rejected' | 'expired';
  verified_clicks: number;
  points_awarded: number;
  expires_at: Date;
}

/** Clicks from other people required before a share pays out. */
const CLICKS_TO_VERIFY = 1;
const SHARE_TTL_HOURS = 72;

export interface CreateShareInput {
  contactId: string;
  network: string;
  targetUrl: string;
  productRef?: string | null;
  postRef?: string | null;
}

export interface CreateShareResult {
  share: ShareEvent;
  link: Link;
  /** The URL the customer should actually post. */
  shareUrl: string;
  /** Pre-built network intent URL, when the network has one. */
  intentUrl: string | null;
}

export async function createShare(
  tenant: Tenant,
  input: CreateShareInput,
  runner?: Queryable,
): Promise<CreateShareResult> {
  const network = String(input.network).toLowerCase();
  if (!SUPPORTED_NETWORKS.includes(network as ShareNetwork)) {
    throw ApiError.badRequest(`Unsupported network "${network}"`);
  }

  const run = async (client: Queryable): Promise<CreateShareResult> => {
    const shareToken = randomCode(12);
    const link = await createLink(
      tenant.id,
      {
        targetUrl: input.targetUrl,
        kind: 'share',
        ownerContactId: input.contactId,
        productRef: input.productRef ?? null,
        postRef: input.postRef ?? null,
        label: `share:${network}`,
        source: network,
        medium: 'social',
        campaign: 'member-share',
        commissionRateBps: 0,
      },
      client,
    );

    const share = await queryOne<ShareEvent>(
      client,
      `INSERT INTO share_events (
         tenant_id, contact_id, network, target_url, link_id, share_token, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval)
       RETURNING *`,
      [tenant.id, input.contactId, network, input.targetUrl, link.id, shareToken, String(SHARE_TTL_HOURS)],
    );

    const shareUrl = `${config().publicUrl}/r/${link.code}`;
    await client.query('UPDATE share_events SET share_url = $2 WHERE id = $1', [share!.id, shareUrl]);

    return {
      share: { ...share!, share_url: shareUrl },
      link,
      shareUrl,
      intentUrl: intentUrlFor(network, shareUrl, input.targetUrl),
    };
  };

  return runner ? run(runner) : withTransaction(run);
}

export function intentUrlFor(network: string, shareUrl: string, targetUrl: string): string | null {
  const url = encodeURIComponent(shareUrl);
  const text = encodeURIComponent('Check this out');
  switch (network) {
    case 'x':
      return `https://x.com/intent/tweet?url=${url}&text=${text}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${url}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${url}`;
    case 'pinterest':
      return `https://pinterest.com/pin/create/button/?url=${url}&description=${text}`;
    case 'reddit':
      return `https://www.reddit.com/submit?url=${url}&title=${text}`;
    case 'whatsapp':
      return `https://api.whatsapp.com/send?text=${text}%20${url}`;
    case 'telegram':
      return `https://t.me/share/url?url=${url}&text=${text}`;
    case 'email':
      return `mailto:?subject=${text}&body=${url}`;
    case 'copy':
      return null;
    default:
      return targetUrl;
  }
}

/**
 * A verified click landed on a share link — credit it and pay out once the
 * threshold is met. Returns true when this call is what tipped it over.
 */
export async function creditShareClick(
  runner: Queryable,
  tenantId: string,
  linkId: string,
  /** Who clicked, when we know. A sharer clicking their own link earns nothing. */
  clicker: { visitorId?: string | null; contactId?: string | null } = {},
): Promise<boolean> {
  // Self-clicks are the obvious way to farm share rewards, so they never count.
  if (clicker.contactId) {
    const own = await queryOne<{ id: string }>(
      runner,
      `SELECT id FROM share_events
        WHERE tenant_id = $1 AND link_id = $2 AND contact_id = $3`,
      [tenantId, linkId, clicker.contactId],
    );
    if (own) return false;
  }

  if (clicker.visitorId) {
    const sameVisitor = await queryOne<{ id: string }>(
      runner,
      `SELECT s.id FROM share_events s
         JOIN visitors v ON v.contact_id = s.contact_id
        WHERE s.tenant_id = $1 AND s.link_id = $2 AND v.id = $3`,
      [tenantId, linkId, clicker.visitorId],
    );
    if (sameVisitor) return false;
  }

  const share = await queryOne<ShareEvent>(
    runner,
    `UPDATE share_events
        SET verified_clicks = verified_clicks + 1
      WHERE tenant_id = $1 AND link_id = $2 AND status = 'pending' AND expires_at > now()
      RETURNING *`,
    [tenantId, linkId],
  );
  if (!share) return false;
  if (share.verified_clicks < CLICKS_TO_VERIFY) return false;

  const outcome = await trigger(
    tenantId,
    {
      contactId: share.contact_id,
      ruleKey: 'social_share',
      refId: share.id,
      refType: 'share_event',
      meta: { network: share.network, target_url: share.target_url },
    },
    runner,
  );

  await runner.query(
    `UPDATE share_events
        SET status = 'verified', verified_at = now(), points_awarded = $2
      WHERE id = $1`,
    [share.id, outcome.awarded ? outcome.points : 0],
  );

  return outcome.awarded;
}

/** Called from ingest when the tracker reports a click carrying a share code. */
export async function recordLinkClickForShare(
  runner: Queryable,
  tenantId: string,
  linkCode: string,
  clicker: { visitorId?: string | null; contactId?: string | null } = {},
): Promise<void> {
  const link = await getLinkByCode(linkCode, runner);
  if (!link || link.tenant_id !== tenantId || link.kind !== 'share') return;
  await creditShareClick(runner, tenantId, link.id, clicker);
}

/** Close out pending shares nobody ever clicked. */
export async function expireStaleShares(runner: Queryable = db()): Promise<number> {
  const { rowCount } = await runner.query(
    `UPDATE share_events SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= now()`,
  );
  return rowCount ?? 0;
}

export async function listShares(
  tenantId: string,
  contactId: string,
  limit = 50,
  runner: Queryable = db(),
): Promise<ShareEvent[]> {
  const { rows } = await runner.query<ShareEvent>(
    `SELECT * FROM share_events
      WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, contactId, Math.min(limit, 200)],
  );
  return rows;
}
