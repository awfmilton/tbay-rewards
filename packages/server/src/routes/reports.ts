import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/pool.js';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { parse } from './collect.js';
import { dateRangeSchema, parseDateRange } from './schemas.js';
import {
  blogLinkPerformance,
  overview,
  rewardsReport,
  timeseries,
  topPages,
  trafficSources,
} from '../services/analytics.js';
import { getHeatmap, listHeatmapPages } from '../services/heatmap.js';
import { topProducts } from '../services/products.js';
import { cartStats } from '../services/carts.js';

/** Reporting API. Secret-key only — these responses contain customer data. */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    await requireSecretKey(request);
  });

  app.get('/v1/reports/overview', async (request) => {
    const tenant = tenantOf(request);
    const range = parseDateRange(parse(dateRangeSchema, request.query));
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      overview: await overview(tenant.id, range.from, range.to),
      timeseries: await timeseries(tenant.id, range.from, range.to),
    };
  });

  app.get('/v1/reports/sources', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(dateRangeSchema, request.query);
    const range = parseDateRange(query);
    return { sources: await trafficSources(tenant.id, range.from, range.to, query.limit ?? 50) };
  });

  app.get('/v1/reports/pages', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(dateRangeSchema, request.query);
    const range = parseDateRange(query);
    return { pages: await topPages(tenant.id, range.from, range.to, query.limit ?? 25) };
  });

  app.get('/v1/reports/products', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(
      dateRangeSchema.extend({
        metric: z.enum(['views', 'clicks', 'add_to_carts', 'purchases']).optional(),
      }),
      request.query,
    );
    const range = parseDateRange(query);
    return {
      products: await topProducts(db(), tenant.id, {
        from: range.from,
        to: range.to,
        metric: query.metric ?? 'clicks',
        limit: query.limit ?? 25,
      }),
    };
  });

  app.get('/v1/reports/carts', async (request) => {
    const tenant = tenantOf(request);
    const range = parseDateRange(parse(dateRangeSchema, request.query));
    return { carts: await cartStats(tenant.id, range.from, range.to) };
  });

  app.get('/v1/reports/blog-links', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(dateRangeSchema, request.query);
    const range = parseDateRange(query);
    return { links: await blogLinkPerformance(tenant.id, range.from, range.to, query.limit ?? 100) };
  });

  app.get('/v1/reports/rewards', async (request) => {
    const tenant = tenantOf(request);
    return { rewards: await rewardsReport(tenant.id) };
  });

  app.get('/v1/reports/heatmap/pages', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(z.object({ limit: z.coerce.number().int().max(500).optional() }), request.query);
    return { pages: await listHeatmapPages(db(), tenant.id, query.limit ?? 50) };
  });

  app.get('/v1/reports/heatmap', async (request) => {
    const tenant = tenantOf(request);
    const query = parse(
      z.object({
        page: z.string().min(1).max(512),
        device: z.enum(['desktop', 'tablet', 'mobile', 'unknown']).optional(),
        kind: z.enum(['click', 'move', 'scroll']).optional(),
      }),
      request.query,
    );
    return {
      heatmap: await getHeatmap(db(), tenant.id, {
        pageKey: query.page,
        deviceClass: query.device ?? 'desktop',
        kind: query.kind ?? 'click',
      }),
    };
  });
}
