import type { Queryable } from '../db/pool.js';
import { bufferProduct, countersEnabled, flushCounters, shouldFlushNow } from './counters.js';

export type ProductMetric = 'views' | 'clicks' | 'add_to_carts' | 'purchases';

export interface ProductInfo {
  productRef: string;
  name?: string | null;
  url?: string | null;
  imageUrl?: string | null;
  priceCents?: number | null;
  currency?: string | null;
  categories?: string[];
}

export interface UpsertProductOptions {
  /**
   * Fill blanks only; never change a value that is already there.
   *
   * What the browser tracker gets. The product details on an event come from
   * the page it was sent from, which means from whoever sent the request --
   * and the site key that authorises it is in every page's source. Allowed to
   * overwrite, that is an open door to the retailer's catalogue: rename their
   * products, restate their prices, point their dashboard's images anywhere.
   *
   * Categories are the part that is not merely cosmetic. Reward rules match on
   * them, so rewriting a product's categories rewrites what it earns. Prices
   * feed the revenue figures the retailer reports on.
   *
   * A product genuinely seen for the first time still lands, which is what the
   * tracker is for. Correcting one afterwards is the storefront's job, over
   * the secret key: PUT /v1/products/:productRef.
   */
  fillOnly?: boolean;
}

export async function upsertProduct(
  runner: Queryable,
  tenantId: string,
  info: ProductInfo,
  options: UpsertProductOptions = {},
): Promise<void> {
  await runner.query(
    // $9 is `fillOnly`; see UpsertProductOptions.
    `INSERT INTO products (tenant_id, product_ref, name, url, image_url, price_cents, currency, categories)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])
     ON CONFLICT (tenant_id, product_ref) DO UPDATE SET
       name        = CASE WHEN $9 THEN COALESCE(products.name, EXCLUDED.name)
                          ELSE COALESCE(EXCLUDED.name, products.name) END,
       url         = CASE WHEN $9 THEN COALESCE(products.url, EXCLUDED.url)
                          ELSE COALESCE(EXCLUDED.url, products.url) END,
       image_url   = CASE WHEN $9 THEN COALESCE(products.image_url, EXCLUDED.image_url)
                          ELSE COALESCE(EXCLUDED.image_url, products.image_url) END,
       price_cents = CASE WHEN $9 THEN COALESCE(products.price_cents, EXCLUDED.price_cents)
                          ELSE COALESCE(EXCLUDED.price_cents, products.price_cents) END,
       currency    = CASE WHEN $9 THEN COALESCE(products.currency, EXCLUDED.currency)
                          ELSE COALESCE(EXCLUDED.currency, products.currency) END,
       categories  = CASE
                       WHEN cardinality(EXCLUDED.categories) = 0 THEN products.categories
                       WHEN $9 AND cardinality(products.categories) > 0 THEN products.categories
                       ELSE EXCLUDED.categories
                     END,
       updated_at  = now()`,
    [
      tenantId,
      info.productRef,
      info.name ?? null,
      info.url ?? null,
      info.imageUrl ?? null,
      info.priceCents ?? null,
      info.currency ?? null,
      info.categories ?? [],
      options.fillOnly === true,
    ],
  );
}

/**
 * Add to the daily rollup for one product metric. Counters are summed in a
 * single upsert per (product, day) so the write cost is independent of traffic.
 */
export async function bumpProductStat(
  runner: Queryable,
  tenantId: string,
  productRef: string,
  metric: ProductMetric,
  amount = 1,
  revenueCents = 0,
  at: Date = new Date(),
): Promise<void> {
  if (countersEnabled()) {
    bufferProduct(tenantId, productRef, metric, amount, revenueCents, at);
    if (shouldFlushNow()) await flushCounters(runner);
    return;
  }

  const column = metric;
  await runner.query(
    // Clamped at zero, because `amount` may be negative: a refund unwinds the
    // purchase it recorded, and a count below zero would be worse than the
    // over-count it is correcting.
    //
    // The update adds $4 rather than EXCLUDED. EXCLUDED is the proposed row,
    // which VALUES has already clamped to zero -- so a negative delta added
    // nothing at all and the refund quietly did not happen.
    `INSERT INTO product_stats (tenant_id, product_ref, stat_date, ${column}, revenue_cents)
     VALUES ($1, $2, $3::date, GREATEST(0, $4::bigint), GREATEST(0, $5::bigint))
     ON CONFLICT (tenant_id, product_ref, stat_date) DO UPDATE SET
       ${column}     = GREATEST(0, product_stats.${column} + $4::bigint),
       revenue_cents = GREATEST(0, product_stats.revenue_cents + $5::bigint)`,
    [tenantId, productRef, at.toISOString().slice(0, 10), amount, revenueCents],
  );
}

export interface TopProductRow {
  product_ref: string;
  name: string | null;
  url: string | null;
  image_url: string | null;
  views: number;
  clicks: number;
  add_to_carts: number;
  purchases: number;
  revenue_cents: number;
  click_through_rate: number;
  cart_conversion_rate: number;
}

/**
 * Most-engaged products over a window, with the two ratios merchandisers
 * actually act on: clicks per view, and carts per click.
 */
export async function topProducts(
  runner: Queryable,
  tenantId: string,
  opts: { from: Date; to: Date; metric?: ProductMetric; limit?: number } ,
): Promise<TopProductRow[]> {
  const metric = opts.metric ?? 'clicks';
  const limit = Math.min(opts.limit ?? 25, 200);

  const { rows } = await runner.query<TopProductRow>(
    `SELECT s.product_ref,
            p.name,
            p.url,
            p.image_url,
            SUM(s.views)::bigint         AS views,
            SUM(s.clicks)::bigint        AS clicks,
            SUM(s.add_to_carts)::bigint  AS add_to_carts,
            SUM(s.purchases)::bigint     AS purchases,
            SUM(s.revenue_cents)::bigint AS revenue_cents,
            CASE WHEN SUM(s.views) > 0
                 THEN ROUND(SUM(s.clicks)::numeric / SUM(s.views), 4)
                 ELSE 0 END AS click_through_rate,
            CASE WHEN SUM(s.clicks) > 0
                 THEN ROUND(SUM(s.add_to_carts)::numeric / SUM(s.clicks), 4)
                 ELSE 0 END AS cart_conversion_rate
       FROM product_stats s
       LEFT JOIN products p ON p.tenant_id = s.tenant_id AND p.product_ref = s.product_ref
      WHERE s.tenant_id = $1
        AND s.stat_date >= $2::date
        AND s.stat_date <= $3::date
      GROUP BY s.product_ref, p.name, p.url, p.image_url
      ORDER BY SUM(s.${metric}) DESC, SUM(s.revenue_cents) DESC
      LIMIT $4`,
    [tenantId, isoDate(opts.from), isoDate(opts.to), limit],
  );

  return rows.map((row) => ({
    ...row,
    click_through_rate: Number(row.click_through_rate),
    cart_conversion_rate: Number(row.cart_conversion_rate),
  }));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
