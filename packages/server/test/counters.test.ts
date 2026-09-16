import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import {
  DESKTOP_UA,
  closeApp,
  closeDb,
  db,
  ids,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import {
  bufferCells,
  bufferProduct,
  bufferedCounts,
  flushCounters,
  startCounterBuffer,
  stopCounterBuffer,
} from '../src/services/counters.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();
});

afterEach(async () => {
  // Never leave the buffer on between tests: it is process-global state and a
  // leaked timer would write into the next test's truncated tables.
  await stopCounterBuffer();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

describe('folding counters in memory', () => {
  it('collapses repeat hits on one cell into a single row', async () => {
    for (let i = 0; i < 100; i += 1) {
      bufferCells(tenant.id, '/product/canoe', 'desktop', 'move', [{ x: 5, y: 9, weight: 1 }]);
    }

    // This is the whole point: a hundred visitors on the same spot is one row
    // to write, not a hundred row versions.
    expect(bufferedCounts().cells).toBe(1);

    await flushCounters();

    const { rows } = await db().query<{ weight: string }>(
      'SELECT weight::text FROM heatmap_cells WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.weight)).toBe(100);
  });

  it('keeps different pages apart even when a page key contains punctuation', async () => {
    // Keys are JSON-joined rather than delimiter-joined, because a page key is
    // user-controlled and could contain whatever separator we picked.
    bufferCells(tenant.id, 'a","b', 'desktop', 'move', [{ x: 1, y: 1, weight: 1 }]);
    bufferCells(tenant.id, 'a', 'desktop', 'move', [{ x: 1, y: 1, weight: 1 }]);

    expect(bufferedCounts().cells).toBe(2);
    await flushCounters();

    const { rows } = await db().query('SELECT page_key FROM heatmap_cells WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows).toHaveLength(2);
  });

  it('adds to what is already stored rather than replacing it', async () => {
    bufferCells(tenant.id, '/p', 'desktop', 'move', [{ x: 1, y: 1, weight: 5 }]);
    await flushCounters();
    bufferCells(tenant.id, '/p', 'desktop', 'move', [{ x: 1, y: 1, weight: 7 }]);
    await flushCounters();

    const { rows } = await db().query<{ weight: string }>(
      'SELECT weight::text FROM heatmap_cells WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(rows[0]!.weight)).toBe(12);
  });

  it('folds product metrics per day and writes each metric to its own column', async () => {
    const day = new Date('2026-03-04T10:00:00Z');
    bufferProduct(tenant.id, 'canoe', 'views', 3, 0, day);
    bufferProduct(tenant.id, 'canoe', 'views', 2, 0, day);
    bufferProduct(tenant.id, 'canoe', 'clicks', 1, 0, day);
    bufferProduct(tenant.id, 'canoe', 'purchases', 1, 4_999, day);

    await flushCounters();

    const { rows } = await db().query<{ views: string; clicks: string; purchases: string; revenue_cents: string }>(
      `SELECT views::text, clicks::text, purchases::text, revenue_cents::text
         FROM product_stats WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.views)).toBe(5);
    expect(Number(rows[0]!.clicks)).toBe(1);
    expect(Number(rows[0]!.purchases)).toBe(1);
    expect(Number(rows[0]!.revenue_cents)).toBe(4_999);
  });

  it('does not lose a write that arrives during a flush', async () => {
    bufferCells(tenant.id, '/p', 'desktop', 'move', [{ x: 1, y: 1, weight: 1 }]);

    // Start the flush, then write while it is in flight. The maps are swapped
    // before the first await, so this lands in the next batch rather than
    // being cleared unwritten.
    const inFlight = flushCounters();
    bufferCells(tenant.id, '/p', 'desktop', 'move', [{ x: 1, y: 1, weight: 1 }]);
    await inFlight;
    await flushCounters();

    const { rows } = await db().query<{ weight: string }>(
      'SELECT weight::text FROM heatmap_cells WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(Number(rows[0]!.weight)).toBe(2);
  });

  it('flushes what it holds when the buffer is stopped', async () => {
    startCounterBuffer(60_000); // long interval, so only the stop can flush it
    bufferCells(tenant.id, '/p', 'desktop', 'move', [{ x: 2, y: 3, weight: 4 }]);

    await stopCounterBuffer();

    const { rows } = await db().query('SELECT 1 FROM heatmap_cells WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows).toHaveLength(1);
  });
});

describe('ingest through the buffer', () => {
  it('produces the same totals buffered as it does synchronously', async () => {
    const app = await testApp();

    async function ingest(): Promise<void> {
      const { visitor, session } = ids();
      await app.inject({
        method: 'POST',
        url: '/v1/collect',
        headers: { 'x-tbay-key': tenant.publicKey, 'user-agent': DESKTOP_UA },
        payload: {
          visitor,
          session,
          url: 'https://shop.example.com/product/canoe',
          events: [
            { type: 'pageview', url: 'https://shop.example.com/product/canoe' },
            {
              type: 'product_view',
              url: 'https://shop.example.com/product/canoe',
              productRef: 'canoe',
            },
          ],
          heatmaps: [
            {
              pageKey: '/product/canoe',
              kind: 'move',
              deviceClass: 'desktop',
              samples: [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }],
            },
          ],
        },
      });
    }

    // Synchronous first.
    for (let i = 0; i < 5; i += 1) await ingest();
    const direct = await totals();

    await truncateAll();
    tenant = await makeTenant();

    // Then the same load with buffering on.
    startCounterBuffer(60_000);
    for (let i = 0; i < 5; i += 1) await ingest();
    await stopCounterBuffer();
    const buffered = await totals();

    // Same numbers, far fewer writes to produce them.
    expect(buffered).toEqual(direct);
  });

  async function totals(): Promise<Record<string, number>> {
    const { rows } = await db().query<{ weight: string; views: string; points: string }>(
      `SELECT
         (SELECT COALESCE(SUM(weight), 0) FROM heatmap_cells WHERE tenant_id = $1)::text AS weight,
         (SELECT COALESCE(SUM(views), 0) FROM product_stats WHERE tenant_id = $1)::text AS views,
         (SELECT COALESCE(SUM(sample_points), 0) FROM heatmap_pages WHERE tenant_id = $1)::text AS points`,
      [tenant.id],
    );
    return {
      weight: Number(rows[0]!.weight),
      views: Number(rows[0]!.views),
      points: Number(rows[0]!.points),
    };
  }
});
