import { db, type Queryable } from '../db/pool.js';
import type { ProductMetric } from './products.js';

/**
 * In-process buffering for counter writes.
 *
 * A load review measured each heatmap cell increment as a full MVCC update:
 * 370 bytes of WAL and one dead tuple per cell, with a realistic batch
 * touching ~142 cells. At a thousand concurrent visitors that is roughly
 * nineteen thousand row versions a second from heatmaps alone, and every one
 * of those row locks was held inside the request transaction.
 *
 * Buffering changes what the write rate is proportional to. It stops being
 * *visitors x samples* and becomes *distinct active cells per interval*: a
 * thousand people on the same product page hit the same few thousand cells, so
 * they collapse into one update each per flush. The review put that at 50-100x
 * fewer row versions.
 *
 * **This is only ever for analytics counters.** The points ledger, balances,
 * orders and token claims keep writing synchronously inside their transaction,
 * because the cost of this technique is losing up to one flush interval on a
 * crash. Approximate heatmap weights are fine; an approximate balance is not.
 *
 * Two other properties worth stating:
 *  - Every flush sorts its rows before writing, for the same reason the
 *    synchronous path does: a fixed lock order is what stops two writers
 *    deadlocking on the same hot page.
 *  - Buffering is per process. N replicas do N flushes per interval, which is
 *    still N rather than N x visitors x samples. A shared buffer only becomes
 *    worth its own failure mode at a scale far past this.
 */

interface CellKey {
  tenantId: string;
  pageKey: string;
  deviceClass: string;
  kind: string;
  x: number;
  y: number;
}

interface PageAccumulator {
  tenantId: string;
  pageKey: string;
  deviceClass: string;
  points: number;
  sessions: number;
  docHeight: number | null;
  viewportWidth: number | null;
}

interface ProductAccumulator {
  tenantId: string;
  productRef: string;
  statDate: string;
  metric: ProductMetric;
  amount: number;
  revenueCents: number;
}

const cells = new Map<string, CellKey & { weight: number }>();
const pages = new Map<string, PageAccumulator>();
const products = new Map<string, ProductAccumulator>();

let enabled = false;
let timer: NodeJS.Timeout | null = null;
let flushing: Promise<void> | null = null;

/**
 * Cap on buffered rows before a flush is forced.
 *
 * Without it a burst could grow the maps without bound between ticks. Hitting
 * the cap is a signal the interval is too long for the load, not an error.
 */
const MAX_BUFFERED = 20_000;

export interface CounterStats {
  cells: number;
  pages: number;
  products: number;
}

export function bufferedCounts(): CounterStats {
  return { cells: cells.size, pages: pages.size, products: products.size };
}

export function countersEnabled(): boolean {
  return enabled;
}

/**
 * Key parts joined unambiguously.
 *
 * JSON rather than a delimiter: a page key is user-controlled and could
 * contain whatever separator character we picked, which would collide two
 * different pages onto one counter.
 */
function keyOf(parts: Array<string | number>): string {
  return JSON.stringify(parts);
}

/**
 * Start buffering.
 *
 * Off by default and turned on by the worker process, so a one-off script or a
 * test that imports these modules never accumulates state it will not flush.
 */
export function startCounterBuffer(intervalMs = 3_000): void {
  if (enabled) return;
  enabled = true;
  timer = setInterval(() => {
    void flushCounters().catch(() => {
      // Analytics counters are not worth crashing a worker over. The next tick
      // retries with whatever is still buffered.
    });
  }, intervalMs);
  timer.unref?.();
}

/** Stop buffering and write out whatever is held. */
export async function stopCounterBuffer(): Promise<void> {
  enabled = false;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await flushCounters();
}

export function bufferCells(
  tenantId: string,
  pageKey: string,
  deviceClass: string,
  kind: string,
  binned: Array<{ x: number; y: number; weight: number }>,
): void {
  for (const cell of binned) {
    const key = keyOf([tenantId, pageKey, deviceClass, kind, cell.x, cell.y]);
    const existing = cells.get(key);
    if (existing) existing.weight += cell.weight;
    else {
      cells.set(key, {
        tenantId, pageKey, deviceClass, kind, x: cell.x, y: cell.y, weight: cell.weight,
      });
    }
  }
}

export function bufferPage(
  tenantId: string,
  pageKey: string,
  deviceClass: string,
  input: {
    points?: number;
    sessions?: number;
    docHeight?: number | null;
    viewportWidth?: number | null;
  },
): void {
  const key = keyOf([tenantId, pageKey, deviceClass]);
  const existing = pages.get(key);
  if (existing) {
    existing.points += input.points ?? 0;
    existing.sessions += input.sessions ?? 0;
    // Last writer wins on the dimensions: they feed a running mean in SQL, so
    // averaging them again here would weight one flush like one sample.
    if (input.docHeight != null) existing.docHeight = input.docHeight;
    if (input.viewportWidth != null) existing.viewportWidth = input.viewportWidth;
    return;
  }
  pages.set(key, {
    tenantId,
    pageKey,
    deviceClass,
    points: input.points ?? 0,
    sessions: input.sessions ?? 0,
    docHeight: input.docHeight ?? null,
    viewportWidth: input.viewportWidth ?? null,
  });
}

export function bufferProduct(
  tenantId: string,
  productRef: string,
  metric: ProductMetric,
  amount: number,
  revenueCents: number,
  at: Date,
): void {
  const statDate = at.toISOString().slice(0, 10);
  const key = keyOf([tenantId, productRef, statDate, metric]);
  const existing = products.get(key);
  if (existing) {
    existing.amount += amount;
    existing.revenueCents += revenueCents;
    return;
  }
  products.set(key, { tenantId, productRef, statDate, metric, amount, revenueCents });
}

export function shouldFlushNow(): boolean {
  return cells.size + pages.size + products.size >= MAX_BUFFERED;
}

/**
 * Write everything buffered.
 *
 * Takes the maps and replaces them before any await, so writes arriving during
 * the flush accumulate into the next batch rather than being lost or written
 * twice. Concurrent calls share one in-flight flush.
 */
export async function flushCounters(runner: Queryable = db()): Promise<CounterStats> {
  if (flushing) {
    await flushing;
    return { cells: 0, pages: 0, products: 0 };
  }

  const cellBatch = [...cells.values()];
  const pageBatch = [...pages.values()];
  const productBatch = [...products.values()];
  cells.clear();
  pages.clear();
  products.clear();

  if (cellBatch.length === 0 && pageBatch.length === 0 && productBatch.length === 0) {
    return { cells: 0, pages: 0, products: 0 };
  }

  const work = (async () => {
    try {
      await flushCells(runner, cellBatch);
      await flushPages(runner, pageBatch);
      await flushProducts(runner, productBatch);
    } catch (err) {
      // Put the work back so the next tick retries it. Re-buffering rather
      // than dropping means a transient database blip costs latency on a
      // counter, not the counter itself.
      for (const cell of cellBatch) {
        bufferCells(cell.tenantId, cell.pageKey, cell.deviceClass, cell.kind, [cell]);
      }
      for (const page of pageBatch) {
        bufferPage(page.tenantId, page.pageKey, page.deviceClass, {
          points: page.points,
          sessions: page.sessions,
          docHeight: page.docHeight,
          viewportWidth: page.viewportWidth,
        });
      }
      for (const product of productBatch) {
        bufferProduct(
          product.tenantId,
          product.productRef,
          product.metric,
          product.amount,
          product.revenueCents,
          new Date(`${product.statDate}T00:00:00Z`),
        );
      }
      throw err;
    }
  })();

  flushing = work.then(
    () => undefined,
    () => undefined,
  );
  try {
    await work;
  } finally {
    flushing = null;
  }

  return { cells: cellBatch.length, pages: pageBatch.length, products: productBatch.length };
}

async function flushCells(
  runner: Queryable,
  batch: Array<CellKey & { weight: number }>,
): Promise<void> {
  if (batch.length === 0) return;

  // Canonical order, for the same reason the synchronous path sorts: two
  // writers taking the same row locks in different orders deadlock.
  batch.sort(
    (a, b) =>
      a.tenantId.localeCompare(b.tenantId) ||
      a.pageKey.localeCompare(b.pageKey) ||
      a.deviceClass.localeCompare(b.deviceClass) ||
      a.kind.localeCompare(b.kind) ||
      a.y - b.y ||
      a.x - b.x,
  );

  // unnest rather than a VALUES list: one plan for any batch size, and no
  // thousands-of-parameters limit to trip over.
  await runner.query(
    `INSERT INTO heatmap_cells (tenant_id, page_key, device_class, kind, x_bin, y_bin, weight)
     SELECT * FROM unnest(
       $1::uuid[], $2::text[], $3::text[], $4::text[], $5::int[], $6::int[], $7::bigint[]
     )
     ON CONFLICT (tenant_id, page_key, device_class, kind, x_bin, y_bin)
     DO UPDATE SET weight = heatmap_cells.weight + EXCLUDED.weight, updated_at = now()`,
    [
      batch.map((cell) => cell.tenantId),
      batch.map((cell) => cell.pageKey),
      batch.map((cell) => cell.deviceClass),
      batch.map((cell) => cell.kind),
      batch.map((cell) => cell.x),
      batch.map((cell) => cell.y),
      batch.map((cell) => cell.weight),
    ],
  );
}

async function flushPages(runner: Queryable, batch: PageAccumulator[]): Promise<void> {
  if (batch.length === 0) return;

  batch.sort(
    (a, b) =>
      a.tenantId.localeCompare(b.tenantId) ||
      a.pageKey.localeCompare(b.pageKey) ||
      a.deviceClass.localeCompare(b.deviceClass),
  );

  await runner.query(
    `INSERT INTO heatmap_pages (
       tenant_id, page_key, device_class, sample_sessions, sample_points,
       avg_doc_height, avg_viewport_w
     )
     SELECT * FROM unnest(
       $1::uuid[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::int[], $7::int[]
     )
     ON CONFLICT (tenant_id, page_key, device_class) DO UPDATE SET
       sample_sessions = heatmap_pages.sample_sessions + EXCLUDED.sample_sessions,
       sample_points   = heatmap_pages.sample_points + EXCLUDED.sample_points,
       avg_doc_height = CASE
         WHEN EXCLUDED.avg_doc_height IS NULL THEN heatmap_pages.avg_doc_height
         WHEN heatmap_pages.avg_doc_height IS NULL THEN EXCLUDED.avg_doc_height
         ELSE (heatmap_pages.avg_doc_height * 9 + EXCLUDED.avg_doc_height) / 10
       END,
       avg_viewport_w = CASE
         WHEN EXCLUDED.avg_viewport_w IS NULL THEN heatmap_pages.avg_viewport_w
         WHEN heatmap_pages.avg_viewport_w IS NULL THEN EXCLUDED.avg_viewport_w
         ELSE (heatmap_pages.avg_viewport_w * 9 + EXCLUDED.avg_viewport_w) / 10
       END,
       last_sample_at = now()`,
    [
      batch.map((page) => page.tenantId),
      batch.map((page) => page.pageKey),
      batch.map((page) => page.deviceClass),
      batch.map((page) => page.sessions),
      batch.map((page) => page.points),
      batch.map((page) => page.docHeight),
      batch.map((page) => page.viewportWidth),
    ],
  );
}

async function flushProducts(runner: Queryable, batch: ProductAccumulator[]): Promise<void> {
  if (batch.length === 0) return;

  // Grouped by metric because each one is a different column, and a single
  // upsert cannot write a column chosen per row.
  const byMetric = new Map<ProductMetric, ProductAccumulator[]>();
  for (const row of batch) {
    const list = byMetric.get(row.metric);
    if (list) list.push(row);
    else byMetric.set(row.metric, [row]);
  }

  for (const [metric, rows] of [...byMetric.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort(
      (a, b) =>
        a.tenantId.localeCompare(b.tenantId) ||
        a.productRef.localeCompare(b.productRef) ||
        a.statDate.localeCompare(b.statDate),
    );

    // `metric` is a ProductMetric, a closed union checked by the compiler and
    // never a value from a request. That is the only reason it is safe to put
    // a column name into the string at all.
    await runner.query(
      `INSERT INTO product_stats (tenant_id, product_ref, stat_date, ${metric}, revenue_cents)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::date[], $4::bigint[], $5::bigint[])
       ON CONFLICT (tenant_id, product_ref, stat_date) DO UPDATE SET
         ${metric}     = product_stats.${metric} + EXCLUDED.${metric},
         revenue_cents = product_stats.revenue_cents + EXCLUDED.revenue_cents`,
      [
        rows.map((row) => row.tenantId),
        rows.map((row) => row.productRef),
        rows.map((row) => row.statDate),
        rows.map((row) => row.amount),
        rows.map((row) => row.revenueCents),
      ],
    );
  }
}
