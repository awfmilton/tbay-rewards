import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { parse } from './collect.js';
import { contactHandleSchema } from './schemas.js';
import { requireContact } from '../services/contacts.js';
import {
  DEFAULT_TEMPLATES,
  deleteTemplate,
  getTemplate,
  listTemplates,
  upsertTemplate,
} from '../services/email.js';
import {
  addExclusion,
  listExclusions,
  removeExclusion,
  EXCLUSION_KINDS,
  type ExclusionKind,
} from '../services/exclusions.js';
import {
  deleteProductRule,
  listProductRules,
  upsertProductRule,
} from '../services/product-rules.js';
import {
  assignRankManually,
  deleteBadge,
  deleteRank,
  listBadges,
  listRanks,
  reevaluateAll,
  revokeBadge,
  unpinRank,
  upsertBadge,
  upsertRank,
} from '../services/gamification.js';

/**
 * Admin surfaces for things that used to be database-only.
 *
 * A parity review against myCred and Mautic found the engine complete but
 * several of its tables unreachable: badges and ranks could not be created,
 * email templates could not be edited, and there was no way to say "staff do
 * not earn points" without writing SQL. Everything here is a control surface
 * over behaviour that already existed.
 *
 * All of it sits behind the tenant's secret key — never the public site key.
 */

const keySchema = z.string().regex(/^[a-z0-9_]{2,64}$/, 'Use 2-64 chars of a-z, 0-9 or underscore');

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', async (request) => {
    if (!request.url.startsWith('/v1/')) return;
    await requireSecretKey(request);
  });

  // ── Email templates ────────────────────────────────────────────────────────

  app.get('/v1/email/templates', async (request) => {
    const tenant = tenantOf(request);
    return { templates: await listTemplates(tenant.id) };
  });

  app.get<{ Params: { key: string } }>('/v1/email/templates/:key', async (request) => {
    const tenant = tenantOf(request);
    const template = await getTemplate(tenant.id, request.params.key);
    if (!template) throw ApiError.notFound(`No template "${request.params.key}"`);
    return { key: request.params.key, template };
  });

  app.put<{ Params: { key: string } }>('/v1/email/templates/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      subject: z.string().min(1).max(300),
      html: z.string().min(1).max(200_000),
      text: z.string().max(200_000).nullish(),
      transactional: z.boolean().optional(),
    });
    const input = parse(schema, request.body);

    await upsertTemplate(tenant.id, request.params.key, {
      subject: input.subject,
      html: input.html,
      text: input.text ?? null,
      transactional: input.transactional ?? false,
    });
    return { key: request.params.key, saved: true };
  });

  /** Reverts to the built-in template rather than leaving the tenant with none. */
  app.delete<{ Params: { key: string } }>('/v1/email/templates/:key', async (request) => {
    const tenant = tenantOf(request);
    const removed = await deleteTemplate(tenant.id, request.params.key);
    return {
      key: request.params.key,
      removed,
      reverted_to_default: Boolean(DEFAULT_TEMPLATES[request.params.key]),
    };
  });

  // ── Who does not earn ──────────────────────────────────────────────────────

  app.get('/v1/rewards/exclusions', async (request) => {
    const tenant = tenantOf(request);
    return { exclusions: await listExclusions(tenant.id) };
  });

  app.post('/v1/rewards/exclusions', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      kind: z.enum(EXCLUSION_KINDS as [ExclusionKind, ...ExclusionKind[]]),
      value: z.string().min(1).max(320),
      note: z.string().max(500).optional(),
    });
    const input = parse(schema, request.body);
    return { exclusion: await addExclusion(tenant.id, input) };
  });

  app.delete<{ Params: { id: string } }>('/v1/rewards/exclusions/:id', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await removeExclusion(tenant.id, request.params.id) };
  });

  // ── Per-product point overrides ────────────────────────────────────────────

  app.get<{ Querystring: { ruleKey?: string } }>('/v1/rewards/product-rules', async (request) => {
    const tenant = tenantOf(request);
    return { rules: await listProductRules(tenant.id, request.query.ruleKey) };
  });

  app.post('/v1/rewards/product-rules', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      ruleKey: keySchema.default('purchase'),
      matchKind: z.enum(['product', 'category']),
      matchValue: z.string().min(1).max(200),
      mode: z.enum(['multiplier', 'fixed', 'exclude']),
      multiplier: z.number().min(0).max(1000).optional(),
      points: z.number().int().min(0).max(1_000_000).optional(),
      note: z.string().max(500).optional(),
    });
    const input = parse(schema, request.body);
    return { rule: await upsertProductRule(tenant.id, input) };
  });

  app.delete<{ Params: { id: string } }>('/v1/rewards/product-rules/:id', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteProductRule(tenant.id, request.params.id) };
  });

  // ── Badges ─────────────────────────────────────────────────────────────────

  app.get('/v1/gamification/badges/admin', async (request) => {
    const tenant = tenantOf(request);
    return { badges: await listBadges(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/gamification/badges/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      imageUrl: z.string().url().max(500).nullish(),
      // Validated in the service, which the importers also go through.
      criteria: z.record(z.unknown()).optional(),
      tiers: z
        .array(
          z.object({
            level: z.number().int().min(1).max(100),
            threshold: z.number().min(0),
            label: z.string().max(100).optional(),
            image_url: z.string().url().max(500).nullish(),
          }),
        )
        .max(20)
        .optional(),
      pointsPerTier: z.number().int().min(0).max(1_000_000).optional(),
      manualOnly: z.boolean().optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body);

    const badge = await upsertBadge(tenant.id, {
      key: request.params.key,
      ...input,
      criteria: input.criteria as never,
      tiers: input.tiers as never,
    });
    return { badge };
  });

  app.delete<{ Params: { key: string } }>('/v1/gamification/badges/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteBadge(tenant.id, request.params.key) };
  });

  app.post<{ Params: { key: string } }>(
    '/v1/gamification/badges/:key/revoke',
    async (request) => {
      const tenant = tenantOf(request);
      const schema = contactHandleSchema.extend({
        // Off by default: points earned under the rules as they stood are not
        // ours to take back because a badge was a mistake.
        reclaimPoints: z.boolean().optional(),
      });
      const input = parse(schema, request.body);
      const contact = await requireContact(tenant.id, input);

      const result = await revokeBadge(tenant.id, contact.id, request.params.key, {
        reclaimPoints: input.reclaimPoints ?? false,
      });
      return result;
    },
  );

  // ── Ranks ──────────────────────────────────────────────────────────────────

  app.get('/v1/gamification/ranks/admin', async (request) => {
    const tenant = tenantOf(request);
    return { ranks: await listRanks(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/gamification/ranks/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      imageUrl: z.string().url().max(500).nullish(),
      minPoints: z.number().int().min(0).optional(),
      maxPoints: z.number().int().min(0).nullish(),
      perks: z.record(z.unknown()).optional(),
      manualOnly: z.boolean().optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body);
    return { rank: await upsertRank(tenant.id, { key: request.params.key, ...input }) };
  });

  app.delete<{ Params: { key: string } }>('/v1/gamification/ranks/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteRank(tenant.id, request.params.key) };
  });

  app.post('/v1/gamification/ranks/assign', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({ rankKey: keySchema });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);
    return { rank: await assignRankManually(tenant.id, contact.id, input.rankKey) };
  });

  app.post('/v1/gamification/ranks/unassign', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(contactHandleSchema, request.body);
    const contact = await requireContact(tenant.id, input);
    return unpinRank(tenant.id, contact.id);
  });

  /**
   * Recompute badges and ranks for everyone.
   *
   * myCred's "Assign Ranks to Users", needed after editing thresholds or
   * importing balances. Synchronous and batched; a very large tenant should
   * expect this to take a while and is safe to re-run.
   */
  app.post('/v1/gamification/reevaluate', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      badges: z.boolean().optional(),
      ranks: z.boolean().optional(),
      batchSize: z.number().int().min(1).max(5000).optional(),
    });
    const input = parse(schema, request.body ?? {});
    return reevaluateAll(tenant.id, input);
  });
}
