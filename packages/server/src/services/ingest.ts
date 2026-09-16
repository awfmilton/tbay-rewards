import { withTransaction, type Queryable } from '../db/pool.js';
import { config } from '../config.js';
import { pageKey } from '../lib/attribution.js';
import type { Tenant } from './tenants.js';
import { resolveSession, selfHostsFor, upsertVisitor, type Session } from './visitors.js';
import { countHeatmapSession, recordHeatmap, type HeatmapKind } from './heatmap.js';
import { bumpProductStat, upsertProduct, type ProductMetric } from './products.js';
import { upsertCart, type CartItem } from './carts.js';
import { recordLinkClickForShare } from './shares.js';

/** Event types the ingest pipeline understands. Anything else is stored raw. */
export const KNOWN_EVENT_TYPES = [
  'pageview',
  'click',
  'product_view',
  'product_click',
  'add_to_cart',
  'remove_from_cart',
  'begin_checkout',
  'search',
  'blog_link_click',
  'share_click',
  'form_submit',
  'newsletter_view',
  'custom',
] as const;

export interface IncomingEvent {
  type: string;
  url?: string | null;
  path?: string | null;
  productRef?: string | null;
  linkCode?: string | null;
  valueCents?: number | null;
  currency?: string | null;
  props?: Record<string, unknown>;
  occurredAt?: string | null;
  product?: {
    name?: string | null;
    url?: string | null;
    imageUrl?: string | null;
    priceCents?: number | null;
    currency?: string | null;
    categories?: string[];
  };
}

export interface IncomingHeatmap {
  page?: string | null;
  kind: HeatmapKind;
  samples: Array<{ x: number; y: number; w?: number }>;
  docHeight?: number | null;
  viewportWidth?: number | null;
}

export interface CollectPayload {
  visitor: string;
  session: string;
  url?: string | null;
  referrer?: string | null;
  linkCode?: string | null;
  events?: IncomingEvent[];
  heatmap?: IncomingHeatmap[];
  cart?: {
    cartToken: string;
    items: CartItem[];
    currency?: string;
    checkoutUrl?: string | null;
  } | null;
}

export interface CollectContext {
  userAgent?: string | null;
  ip?: string | null;
  country?: string | null;
}

export interface CollectResult {
  sessionId: string;
  isNewSession: boolean;
  acceptedEvents: number;
  heatmapCells: number;
  bot: boolean;
}

/**
 * Process one tracker batch.
 *
 * Runs in a single transaction: a batch either lands completely or not at all,
 * so a retry from the tracker cannot leave half-counted stats. Bot traffic is
 * sessionised (so we can report on it) but never counted into heatmaps, product
 * stats or carts.
 */
export async function collect(
  tenant: Tenant,
  payload: CollectPayload,
  ctx: CollectContext,
): Promise<CollectResult> {
  const cfg = config();
  const patterns = tenant.settings?.pageKeyPatterns ?? [];
  const selfHosts = selfHostsFor(tenant);

  return withTransaction(async (client) => {
    const visitor = await upsertVisitor(client, tenant.id, payload.visitor);
    const { session, isNew } = await resolveSession(
      client,
      tenant,
      visitor,
      {
        clientSessionId: payload.session,
        url: payload.url,
        referrer: payload.referrer,
        linkCode: payload.linkCode,
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        country: ctx.country,
      },
      selfHosts,
    );

    const isBot = session.is_bot;
    const events = (payload.events ?? []).slice(0, cfg.tracking.maxEventsPerBatch);
    let accepted = 0;
    /** product_stats increments, folded per (product, metric, day). */
    const productBumps = new Map<
      string,
      { productRef: string; metric: ProductMetric; at: Date; count: number }
    >();
    let pageviews = 0;

    for (const event of events) {
      if (typeof event?.type !== 'string' || event.type.length === 0) continue;
      const occurredAt = parseTimestamp(event.occurredAt);
      const url = event.url ?? payload.url ?? null;
      const path = event.path ?? (url ? pageKey(url, patterns) : null);

      await client.query(
        `INSERT INTO events (
           tenant_id, session_id, visitor_id, contact_id, type, path, url,
           product_ref, link_code, value_cents, currency, props, occurred_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
        [
          tenant.id,
          session.id,
          visitor.id,
          session.contact_id,
          event.type.slice(0, 64),
          path,
          url ? url.slice(0, 2048) : null,
          event.productRef ? String(event.productRef).slice(0, 128) : null,
          event.linkCode ? String(event.linkCode).slice(0, 64) : null,
          normaliseCents(event.valueCents),
          event.currency ? String(event.currency).toUpperCase().slice(0, 3) : null,
          JSON.stringify(event.props ?? {}),
          occurredAt,
        ],
      );
      accepted += 1;
      if (event.type === 'pageview') pageviews += 1;

      if (isBot) continue;

      if (event.productRef) {
        if (event.product) {
          await upsertProduct(client, tenant.id, {
            productRef: event.productRef,
            ...event.product,
          });
        }
        const metric = productMetricFor(event.type);
        if (metric) {
          // Accumulated rather than applied here. Bumping in event order takes
          // row locks on product_stats in whatever order the visitor happened
          // to browse, and two visitors who saw the same two products in
          // opposite order deadlock — measured at 48 of 300 concurrent
          // batches. Collected now, applied in sorted order after the loop.
          const key = `${event.productRef}\u0000${metric}\u0000${statDay(occurredAt)}`;
          const entry = productBumps.get(key);
          if (entry) entry.count += 1;
          else {
            productBumps.set(key, {
              productRef: String(event.productRef),
              metric,
              at: occurredAt,
              count: 1,
            });
          }
        }
      }

      // A click on a share link is the evidence that a share actually happened.
      if (event.type === 'share_click' && event.linkCode) {
        await recordLinkClickForShare(client, tenant.id, event.linkCode, {
          visitorId: visitor.id,
          contactId: session.contact_id,
        });
      }
    }

    // Canonical order, so every batch takes these locks in the same sequence.
    for (const bump of [...productBumps.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, value]) => value)) {
      await bumpProductStat(
        client,
        tenant.id,
        bump.productRef,
        bump.metric,
        bump.count,
        0,
        bump.at,
      );
    }

    await client.query(
      `UPDATE sessions SET
         events = events + $2,
         pageviews = pageviews + $3,
         exit_path = COALESCE($4, exit_path),
         last_event_at = now()
       WHERE id = $1`,
      [session.id, accepted, pageviews, payload.url ? pageKey(payload.url, patterns) : null],
    );

    let heatmapCells = 0;
    if (!isBot) {
      heatmapCells = await ingestHeatmaps(client, tenant, session, payload, patterns, isNew);

      if (payload.cart) {
        await upsertCart(client, tenant.id, {
          cartToken: payload.cart.cartToken,
          visitorId: visitor.id,
          contactId: session.contact_id,
          items: payload.cart.items ?? [],
          currency: payload.cart.currency ?? tenant.currency,
          checkoutUrl: payload.cart.checkoutUrl ?? null,
        });
      }
    }

    return {
      sessionId: session.id,
      isNewSession: isNew,
      acceptedEvents: accepted,
      heatmapCells,
      bot: isBot,
    };
  });
}

async function ingestHeatmaps(
  client: Queryable,
  tenant: Tenant,
  session: Session,
  payload: CollectPayload,
  patterns: string[],
  isNewSession: boolean,
): Promise<number> {
  const batches = payload.heatmap ?? [];
  if (batches.length === 0) return 0;

  const device = session.device_class ?? 'unknown';
  const budget = config().tracking.maxHeatmapPointsPerBatch;
  let remaining = budget;
  let cells = 0;
  const countedPages = new Set<string>();

  for (const batch of batches) {
    if (remaining <= 0) break;
    if (!batch || !Array.isArray(batch.samples) || batch.samples.length === 0) continue;
    if (!['click', 'move', 'scroll'].includes(batch.kind)) continue;

    const key = pageKey(batch.page ?? payload.url, patterns);
    // Reservoir-free downsampling: take an evenly spaced slice so a busy page
    // cannot spend another page's ingest budget.
    const samples = downsample(batch.samples, remaining);
    remaining -= samples.length;

    cells += await recordHeatmap(client, tenant.id, {
      pageKey: key,
      deviceClass: device,
      kind: batch.kind,
      samples: samples.map((sample) => ({ x: sample.x, y: sample.y, weight: sample.w })),
      docHeight: batch.docHeight ?? null,
      viewportWidth: batch.viewportWidth ?? null,
    });

    if (isNewSession && !countedPages.has(key)) {
      countedPages.add(key);
      await countHeatmapSession(client, tenant.id, key, device);
    }
  }

  return cells;
}

function downsample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(items[Math.floor(i * step)]!);
  }
  return out;
}

function productMetricFor(type: string): 'views' | 'clicks' | 'add_to_carts' | null {
  switch (type) {
    case 'product_view':
      return 'views';
    case 'product_click':
    case 'click':
      return 'clicks';
    case 'add_to_cart':
      return 'add_to_carts';
    default:
      return null;
  }
}

function parseTimestamp(value: string | null | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date();
  // Never trust a client clock far from ours: clamp to a sane window.
  const now = Date.now();
  const time = parsed.getTime();
  if (time > now + 60_000) return new Date();
  if (time < now - 7 * 24 * 60 * 60 * 1000) return new Date();
  return parsed;
}

function normaliseCents(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

/** The UTC day a stat row is keyed on, used only to fold duplicate bumps. */
function statDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}
