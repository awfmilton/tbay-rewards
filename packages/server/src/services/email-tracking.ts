import { db, queryOne, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { hashPii, randomCode } from '../lib/crypto.js';
import { parseUserAgent } from '../lib/useragent.js';
import type { Tenant } from './tenants.js';

/**
 * Opens and clicks on email the platform sent.
 *
 * Without this the platform mailed people and learned nothing: no engagement
 * signal for an automation, no way to build a win-back on "opened but did not
 * buy", and a click from an email could not identify the anonymous visitor who
 * followed it.
 *
 * Two deliberate choices about the address space:
 *
 *  - The redirect resolves a link by *index* into a list stored on the message,
 *    never by a URL in the query string. A redirect that takes its destination
 *    from the request is an open redirect, and an open redirect on a domain
 *    customers are told to trust is a phishing kit.
 *  - The token is random per message rather than derived from the message id,
 *    which appears in API responses. Anyone holding the id must not be able to
 *    forge opens for that send.
 */

/** Rewriting is off for transactional mail; see `shouldTrack`. */
export interface TrackingPlan {
  token: string;
  html: string;
  links: string[];
}

const HREF = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gi;

/** Paths that are ours and must never be wrapped, whatever the host. */
const PLATFORM_PATHS = /^\/(?:n\/(?:confirm|unsubscribe)|e\/)/;

/**
 * Should this href be rewritten?
 *
 * Only http(s): mailto, tel and in-page anchors stay as they are.
 *
 * Our own consent endpoints are excluded by *path*, not by matching the whole
 * configured public URL as a prefix. A scheme, port or trailing-slash mismatch
 * between the configured base and the URL that actually went into the email
 * would otherwise wrap a one-click unsubscribe — breaking RFC 8058 compliance
 * and putting the customer's opt-out behind our own availability. Excluding
 * one extra link is free; breaking an unsubscribe is not.
 */
function isTrackable(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return !PLATFORM_PATHS.test(parsed.pathname);
}

/**
 * Rewrite an email body for tracking.
 *
 * Returns the original html and an empty link list when there is nothing to
 * track, so the caller can store the result unconditionally.
 */
export function planTracking(html: string, token = randomCode(24)): TrackingPlan {
  const links: string[] = [];
  const base = config().publicUrl;

  const rewritten = html.replace(HREF, (match, prefix: string, quote: string, url: string) => {
    const decoded = url.replace(/&amp;/g, '&');
    if (!isTrackable(decoded)) return match;

    // Identical destinations share an index, so a header and footer link to
    // the same page report as one link rather than two.
    let index = links.indexOf(decoded);
    if (index === -1) index = links.push(decoded) - 1;

    return `${prefix}${quote}${base}/e/${token}/c/${index}${quote}`;
  });

  if (links.length === 0) return { token, html, links };

  // The pixel goes last so a client that stops rendering early still counts
  // the click, which is the more reliable signal anyway.
  const pixel =
    `<img src="${base}/e/${token}/o.gif" width="1" height="1" alt="" ` +
    `style="display:block;width:1px;height:1px;border:0;" />`;

  const withPixel = /<\/body\s*>/i.test(rewritten)
    ? rewritten.replace(/<\/body\s*>/i, `${pixel}</body>`)
    : rewritten + pixel;

  return { token, html: withPixel, links };
}

/**
 * Should this message be tracked?
 *
 * Transactional mail is never tracked. A receipt is not a campaign, and
 * measuring whether someone opened their own order confirmation buys nothing
 * that would justify putting a pixel in it. Retailers can turn tracking off
 * entirely with `emailTracking: false`.
 */
export function shouldTrack(
  tenant: Pick<Tenant, 'settings'>,
  options: { transactional?: boolean } = {},
): boolean {
  if (options.transactional) return false;
  return tenant.settings?.emailTracking !== false;
}

export interface TrackedMessage {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  template_key: string;
  tracked_links: string[];
  opened_at: Date | null;
  first_clicked_at: Date | null;
}

export async function messageByToken(
  token: string,
  runner: Queryable = db(),
): Promise<TrackedMessage | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  return queryOne<TrackedMessage>(
    runner,
    `SELECT id, tenant_id, contact_id, template_key, tracked_links,
            opened_at, first_clicked_at
       FROM email_messages WHERE tracking_token = $1`,
    [token],
  );
}

export interface EngagementContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface EngagementResult {
  /** True the first time a human opened or clicked this message. */
  first: boolean;
  isBot: boolean;
  url: string | null;
}

/**
 * Record an open or a click.
 *
 * Bot hits are stored and counted separately rather than discarded — a link
 * scanner prefetching every URL is worth seeing in a report, and Apple Mail
 * Privacy Protection prefetches the pixel for every recipient, so an
 * unfiltered open rate is close to meaningless. `first` is only ever true for
 * a human, which is what automations fire on.
 */
export async function recordEngagement(
  tenant: Tenant,
  message: TrackedMessage,
  kind: 'open' | 'click',
  linkIndex: number | null,
  ctx: EngagementContext,
  runner: Queryable = db(),
): Promise<EngagementResult> {
  const ua = parseUserAgent(ctx.userAgent);
  const url =
    kind === 'click' && linkIndex !== null
      ? (message.tracked_links?.[linkIndex] ?? null)
      : null;

  await runner.query(
    `INSERT INTO email_events (
       tenant_id, message_id, contact_id, kind, link_index, url, ip_hash, ua_hash, is_bot
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenant.id,
      message.id,
      message.contact_id,
      kind,
      linkIndex,
      url,
      ctx.ip ? hashPii(ctx.ip, tenant.pii_salt) : null,
      ctx.userAgent ? hashPii(ctx.userAgent, tenant.pii_salt) : null,
      ua.isBot,
    ],
  );

  const alreadyEngaged = kind === 'open' ? message.opened_at : message.first_clicked_at;

  if (ua.isBot) {
    await runner.query(
      kind === 'open'
        ? 'UPDATE email_messages SET bot_open_count = bot_open_count + 1 WHERE id = $1'
        : 'UPDATE email_messages SET bot_click_count = bot_click_count + 1 WHERE id = $1',
      [message.id],
    );
    return { first: false, isBot: true, url };
  }

  await runner.query(
    kind === 'open'
      ? `UPDATE email_messages
            SET open_count = open_count + 1, opened_at = COALESCE(opened_at, now())
          WHERE id = $1`
      : `UPDATE email_messages
            SET click_count = click_count + 1,
                first_clicked_at = COALESCE(first_clicked_at, now()),
                -- A click proves the message was opened even when the pixel was
                -- blocked, which is most of the time on a modern client.
                opened_at = COALESCE(opened_at, now())
          WHERE id = $1`,
    [message.id],
  );

  return { first: alreadyEngaged === null, isBot: false, url };
}

/** Per-template engagement, for the reports page. */
export async function engagementReport(
  tenantId: string,
  days = 30,
  runner: Queryable = db(),
): Promise<
  Array<{
    template_key: string;
    sent: number;
    opened: number;
    clicked: number;
    open_rate: number;
    click_rate: number;
  }>
> {
  const { rows } = await runner.query<{
    template_key: string;
    sent: string;
    opened: string;
    clicked: string;
  }>(
    `SELECT template_key,
            COUNT(*) FILTER (WHERE status = 'sent')::text AS sent,
            COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::text AS opened,
            COUNT(*) FILTER (WHERE first_clicked_at IS NOT NULL)::text AS clicked
       FROM email_messages
      WHERE tenant_id = $1 AND created_at >= now() - ($2 || ' days')::interval
      GROUP BY template_key
      ORDER BY sent DESC`,
    [tenantId, String(days)],
  );

  return rows.map((row) => {
    const sent = Number(row.sent);
    const opened = Number(row.opened);
    const clicked = Number(row.clicked);
    return {
      template_key: row.template_key,
      sent,
      opened,
      clicked,
      // Rates against messages actually sent; a queued or failed message has
      // had no chance to be opened and would only dilute the number.
      open_rate: sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0,
      click_rate: sent > 0 ? Math.round((clicked / sent) * 1000) / 10 : 0,
    };
  });
}
