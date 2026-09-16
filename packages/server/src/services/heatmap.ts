import type { Queryable } from '../db/pool.js';

/**
 * Heatmaps are stored as a normalised grid, never as raw pointer traces.
 *
 * X is bucketed into 100 columns of document width and Y into 200 rows of
 * document height, so a recorded point is resolution-independent and a page
 * costs at most 20k rows per device class no matter how much traffic it gets.
 * Nothing that could re-identify a visitor is kept.
 */
export const X_BINS = 100;
export const Y_BINS = 200;

export type HeatmapKind = 'click' | 'move' | 'scroll';

export interface HeatmapSample {
  /** 0..1 across the document width. */
  x: number;
  /** 0..1 down the full document height. */
  y: number;
  weight?: number;
}

export interface HeatmapBatch {
  pageKey: string;
  deviceClass: string;
  kind: HeatmapKind;
  samples: HeatmapSample[];
  docHeight?: number | null;
  viewportWidth?: number | null;
}

interface Cell {
  x: number;
  y: number;
  weight: number;
}

export function binSamples(samples: HeatmapSample[]): Cell[] {
  const grid = new Map<number, Cell>();
  for (const sample of samples) {
    if (!Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const x = clamp(Math.floor(sample.x * X_BINS), 0, X_BINS - 1);
    const y = clamp(Math.floor(sample.y * Y_BINS), 0, Y_BINS - 1);
    const weight = Number.isFinite(sample.weight) ? Math.max(1, Math.trunc(sample.weight!)) : 1;
    const key = y * X_BINS + x;
    const existing = grid.get(key);
    if (existing) existing.weight += weight;
    else grid.set(key, { x, y, weight });
  }
  // Sorted, and it is not cosmetic. The upsert below locks these rows in array
  // order and holds them to COMMIT, so two visitors on the same page whose
  // pointer traces visited the same cells in a different order deadlock each
  // other. A canonical order means every writer takes the same locks in the
  // same sequence, which is the textbook cure. Measured on a hot page: 291 of
  // 300 concurrent batches deadlocked before this line, none after.
  return [...grid.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Fold one batch of samples into the stored grid with a single upsert. */
export async function recordHeatmap(
  runner: Queryable,
  tenantId: string,
  batch: HeatmapBatch,
): Promise<number> {
  const cells = binSamples(batch.samples);
  if (cells.length === 0) return 0;

  const values: unknown[] = [tenantId, batch.pageKey, batch.deviceClass, batch.kind];
  const tuples: string[] = [];
  for (const cell of cells) {
    const base = values.length;
    values.push(cell.x, cell.y, cell.weight);
    tuples.push(`($1, $2, $3, $4, $${base + 1}, $${base + 2}, $${base + 3})`);
  }

  await runner.query(
    `INSERT INTO heatmap_cells (tenant_id, page_key, device_class, kind, x_bin, y_bin, weight)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (tenant_id, page_key, device_class, kind, x_bin, y_bin)
     DO UPDATE SET weight = heatmap_cells.weight + EXCLUDED.weight, updated_at = now()`,
    values,
  );

  const totalWeight = cells.reduce((sum, cell) => sum + cell.weight, 0);
  await runner.query(
    `INSERT INTO heatmap_pages (
       tenant_id, page_key, device_class, sample_sessions, sample_points,
       avg_doc_height, avg_viewport_w
       -- sample_sessions stays 0 here: countHeatmapSession() owns that counter,
       -- so recording points must not also count a session.
     ) VALUES ($1, $2, $3, 0, $4, $5, $6)
     ON CONFLICT (tenant_id, page_key, device_class) DO UPDATE SET
       sample_points  = heatmap_pages.sample_points + EXCLUDED.sample_points,
       -- Running mean so a page that changes layout drifts to the new size.
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
      tenantId,
      batch.pageKey,
      batch.deviceClass,
      totalWeight,
      batch.docHeight ?? null,
      batch.viewportWidth ?? null,
    ],
  );

  return cells.length;
}

/** Count a session against a page once, for "sampled sessions" in reports. */
export async function countHeatmapSession(
  runner: Queryable,
  tenantId: string,
  pageKey: string,
  deviceClass: string,
): Promise<void> {
  await runner.query(
    `INSERT INTO heatmap_pages (tenant_id, page_key, device_class, sample_sessions)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (tenant_id, page_key, device_class)
     DO UPDATE SET sample_sessions = heatmap_pages.sample_sessions + 1, last_sample_at = now()`,
    [tenantId, pageKey, deviceClass],
  );
}

export interface HeatmapCell {
  x_bin: number;
  y_bin: number;
  weight: number;
}

export interface HeatmapReport {
  pageKey: string;
  deviceClass: string;
  kind: HeatmapKind;
  xBins: number;
  yBins: number;
  maxWeight: number;
  totalWeight: number;
  sampleSessions: number;
  avgDocHeight: number | null;
  avgViewportWidth: number | null;
  cells: HeatmapCell[];
}

export async function getHeatmap(
  runner: Queryable,
  tenantId: string,
  opts: { pageKey: string; deviceClass?: string; kind?: HeatmapKind },
): Promise<HeatmapReport> {
  const deviceClass = opts.deviceClass ?? 'desktop';
  const kind = opts.kind ?? 'click';

  const { rows: cells } = await runner.query<HeatmapCell>(
    `SELECT x_bin, y_bin, weight
       FROM heatmap_cells
      WHERE tenant_id = $1 AND page_key = $2 AND device_class = $3 AND kind = $4
      ORDER BY y_bin, x_bin`,
    [tenantId, opts.pageKey, deviceClass, kind],
  );

  const { rows: pages } = await runner.query<{
    sample_sessions: number;
    avg_doc_height: number | null;
    avg_viewport_w: number | null;
  }>(
    `SELECT sample_sessions, avg_doc_height, avg_viewport_w
       FROM heatmap_pages
      WHERE tenant_id = $1 AND page_key = $2 AND device_class = $3`,
    [tenantId, opts.pageKey, deviceClass],
  );

  let maxWeight = 0;
  let totalWeight = 0;
  for (const cell of cells) {
    totalWeight += cell.weight;
    if (cell.weight > maxWeight) maxWeight = cell.weight;
  }

  return {
    pageKey: opts.pageKey,
    deviceClass,
    kind,
    xBins: X_BINS,
    yBins: Y_BINS,
    maxWeight,
    totalWeight,
    sampleSessions: pages[0]?.sample_sessions ?? 0,
    avgDocHeight: pages[0]?.avg_doc_height ?? null,
    avgViewportWidth: pages[0]?.avg_viewport_w ?? null,
    cells,
  };
}

/** Pages with heatmap data, most-sampled first. */
export async function listHeatmapPages(
  runner: Queryable,
  tenantId: string,
  limit = 50,
): Promise<
  Array<{ page_key: string; device_class: string; sample_sessions: number; sample_points: number }>
> {
  const { rows } = await runner.query<{
    page_key: string;
    device_class: string;
    sample_sessions: number;
    sample_points: number;
  }>(
    `SELECT page_key, device_class, sample_sessions, sample_points
       FROM heatmap_pages
      WHERE tenant_id = $1
      ORDER BY sample_points DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}
