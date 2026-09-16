import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { parse } from './collect.js';
import { contactHandleSchema } from './schemas.js';
import { requireContact } from '../services/contacts.js';
import { queryLedger, type LedgerQuery } from '../services/points.js';
import { contactSummary, contactTimeline } from '../services/timeline.js';
import { listSuppressions, suppress, unsuppress } from '../services/deliverability.js';
import { engagementReport } from '../services/email-tracking.js';
import {
  audienceSize,
  buildSegment,
  countMatching,
  deleteSegment,
  getSegment,
  listSegments,
  previewMatching,
  upsertSegment,
} from '../services/segments.js';
import { describeFields } from '../services/segment-filters.js';
import {
  deleteAutomation,
  listAutomations,
  listRuns,
  upsertAutomation,
  validateSteps,
} from '../services/automations.js';
import {
  broadcastReport,
  cancelBroadcast,
  listBroadcasts,
  startBroadcast,
  upsertBroadcast,
} from '../services/broadcasts.js';
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

  // ── Contact timeline ───────────────────────────────────────────────────────

  /**
   * Everything that happened to one contact, newest first.
   *
   * The question support actually asks. Accepts the usual contact handles so
   * it can be reached with an email address, which is all a support agent has.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/contacts/timeline',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);

      const kinds = request.query.kinds
        ? request.query.kinds.split(',').map((kind) => kind.trim()).filter(Boolean)
        : null;

      const before = request.query.before ? new Date(request.query.before) : null;
      if (before && Number.isNaN(before.getTime())) {
        throw ApiError.badRequest(`"${request.query.before}" is not a date`);
      }

      return {
        contact: {
          id: contact.id,
          email: contact.email,
          name: contact.name,
          tags: contact.tags,
          marketing_consent: contact.marketing_consent,
        },
        summary: await contactSummary(tenant.id, contact.id),
        timeline: await contactTimeline(tenant.id, contact.id, {
          limit: Number(request.query.limit) || 50,
          before,
          kinds: kinds as never,
        }),
      };
    },
  );

  // ── Automations ────────────────────────────────────────────────────────────

  app.get('/v1/automations', async (request) => {
    const tenant = tenantOf(request);
    return { automations: await listAutomations(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/automations/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      triggerType: z.string().max(64).optional(),
      conditions: z.array(z.record(z.unknown())).max(20).optional(),
      /**
       * The step list. Shape-checked loosely here and validated properly by
       * `validateSteps`, which knows which action and control types exist —
       * duplicating that list in a zod enum would give two places to forget.
       */
      actions: z.array(z.record(z.unknown())).max(50).optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body);

    if (input.actions) validateSteps(input.actions as never);

    const existing = (await listAutomations(tenant.id)).find(
      (row) => row.key === request.params.key,
    );

    const triggerType = input.triggerType ?? existing?.trigger_type;
    if (!triggerType) throw ApiError.badRequest('An automation needs a triggerType');

    const automation = await upsertAutomation(tenant.id, {
      key: request.params.key,
      name: input.name ?? existing?.name ?? request.params.key,
      triggerType,
      conditions: (input.conditions ?? existing?.conditions ?? []) as never,
      actions: (input.actions ?? existing?.actions ?? []) as never,
      enabled: input.enabled ?? existing?.enabled ?? true,
    });
    return { automation };
  });

  app.delete<{ Params: { key: string } }>('/v1/automations/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteAutomation(tenant.id, request.params.key) };
  });

  /** Parked runs, so an admin can see a sequence actually waiting. */
  app.get<{ Querystring: { key?: string } }>('/v1/automations/runs', async (request) => {
    const tenant = tenantOf(request);
    return { runs: await listRuns(tenant.id, request.query.key) };
  });

  // ── Segments ───────────────────────────────────────────────────────────────

  /** The field catalogue, so a UI can render a filter builder from it. */
  app.get('/v1/segments/fields', async () => ({ fields: describeFields() }));

  app.get('/v1/segments', async (request) => {
    const tenant = tenantOf(request);
    return { segments: await listSegments(tenant.id) };
  });

  app.get<{ Params: { key: string } }>('/v1/segments/:key', async (request) => {
    const tenant = tenantOf(request);
    const segment = await getSegment(tenant.id, request.params.key);
    if (!segment) throw ApiError.notFound(`No segment "${request.params.key}"`);
    return { segment };
  });

  app.put<{ Params: { key: string } }>('/v1/segments/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      // Shape-checked here, compiled in the service — the compiler is the only
      // thing that knows which fields and operators are real.
      definition: filterGroupSchema.optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body);

    const segment = await upsertSegment(tenant.id, {
      key: request.params.key,
      ...input,
      definition: input.definition as never,
    });
    return { segment };
  });

  app.delete<{ Params: { key: string } }>('/v1/segments/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteSegment(tenant.id, request.params.key) };
  });

  /**
   * Count and sample a definition without saving it.
   *
   * An admin about to mail forty thousand people should see twenty of them
   * first: a count alone does not catch "I meant *not* tagged vip".
   */
  app.post('/v1/segments/preview', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(
      z.object({ definition: filterGroupSchema, limit: z.number().int().min(1).max(100).optional() }),
      request.body,
    );
    const definition = input.definition as never;
    return {
      count: await countMatching(tenant.id, definition),
      sample: await previewMatching(tenant.id, definition, input.limit ?? 20),
    };
  });

  app.post<{ Params: { key: string } }>('/v1/segments/:key/build', async (request) => {
    const tenant = tenantOf(request);
    return buildSegment(tenant.id, request.params.key);
  });

  app.get<{ Params: { key: string }; Querystring: { marketingOnly?: string } }>(
    '/v1/segments/:key/audience',
    async (request) => {
      const tenant = tenantOf(request);
      const marketingOnly = request.query.marketingOnly !== 'false';
      return {
        marketing_only: marketingOnly,
        size: await audienceSize(tenant.id, request.params.key, marketingOnly),
      };
    },
  );

  // ── Broadcasts ─────────────────────────────────────────────────────────────

  app.get('/v1/broadcasts', async (request) => {
    const tenant = tenantOf(request);
    return { broadcasts: await listBroadcasts(tenant.id) };
  });

  app.get<{ Params: { key: string } }>('/v1/broadcasts/:key', async (request) => {
    const tenant = tenantOf(request);
    return broadcastReport(tenant.id, request.params.key);
  });

  app.put<{ Params: { key: string } }>('/v1/broadcasts/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      segmentKey: z.string().max(64).optional(),
      templateKey: z.string().max(64).optional(),
      subject: z.string().max(300).nullish(),
      sendAt: z.string().max(40).nullish(),
    });
    const input = parse(schema, request.body);
    return { broadcast: await upsertBroadcast(tenant.id, { key: request.params.key, ...input }) };
  });

  /**
   * Arm a broadcast.
   *
   * Separate from the PUT that writes it, because sending to a whole segment
   * is not something to do by accident while editing a subject line.
   */
  app.post<{ Params: { key: string } }>('/v1/broadcasts/:key/send', async (request) => {
    const tenant = tenantOf(request);
    return { broadcast: await startBroadcast(tenant.id, request.params.key) };
  });

  app.post<{ Params: { key: string } }>('/v1/broadcasts/:key/cancel', async (request) => {
    const tenant = tenantOf(request);
    return { broadcast: await cancelBroadcast(tenant.id, request.params.key) };
  });

  // ── Deliverability ─────────────────────────────────────────────────────────

  app.get('/v1/email/suppressions', async (request) => {
    const tenant = tenantOf(request);
    return { suppressions: await listSuppressions(tenant.id) };
  });

  app.post('/v1/email/suppressions', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      email: z.string().email().max(254),
      reason: z.enum(['hard_bounce', 'complaint', 'manual', 'repeated_failure']).default('manual'),
      detail: z.string().max(500).optional(),
    });
    const input = parse(schema, request.body);
    return { suppression: await suppress(tenant.id, input.email, input.reason, input.detail) };
  });

  /**
   * Remove an address from suppression.
   *
   * Legitimate when a mailbox is fixed or a bounce was misclassified. It does
   * *not* restore marketing consent — a complaint withdrew that, and only the
   * person themselves can give it back.
   */
  app.delete<{ Params: { email: string } }>('/v1/email/suppressions/:email', async (request) => {
    const tenant = tenantOf(request);
    // Fastify has already decoded the path parameter. Decoding again turns a
    // literal `%` in an address into a URIError and a 500.
    return { removed: await unsuppress(tenant.id, request.params.email) };
  });

  app.get<{ Querystring: { days?: string } }>('/v1/email/engagement', async (request) => {
    const tenant = tenantOf(request);
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 365);
    return { days, templates: await engagementReport(tenant.id, days) };
  });

  // ── Ledger search and export ───────────────────────────────────────────────

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/rewards/ledger',
    async (request) => {
      const tenant = tenantOf(request);
      const query = parseLedgerQuery(request.query);
      const result = await queryLedger(tenant.id, query);
      return {
        total: result.total,
        limit: query.limit,
        offset: query.offset,
        entries: result.rows,
      };
    },
  );

  /**
   * CSV of the same query.
   *
   * Capped at 50,000 rows and built in memory, which is the honest limit of
   * this approach — a tenant needing more should page the JSON endpoint. The
   * cap is enforced rather than silently truncating: a short export that looks
   * complete is worse than a refusal.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/rewards/ledger.csv',
    async (request, reply) => {
      const tenant = tenantOf(request);
      const query = parseLedgerQuery(request.query, { limit: 50_000, maxLimit: 50_000 });

      const result = await queryLedger(tenant.id, query);
      if (result.total > 50_000) {
        throw ApiError.unprocessable(
          `That range has ${result.total} entries, above the 50,000 export limit. Narrow the dates.`,
          { total: result.total, limit: 50_000 },
        );
      }

      const header = [
        'created_at', 'contact_id', 'contact_email', 'contact_name',
        'delta_points', 'reason', 'rule_key', 'ref_type', 'ref_id', 'status',
      ];
      const lines = [header.join(',')];
      for (const row of result.rows) {
        lines.push(
          [
            new Date(row.created_at).toISOString(),
            row.contact_id,
            row.contact_email ?? '',
            row.contact_name ?? '',
            String(row.delta_points),
            row.reason,
            row.rule_key ?? '',
            row.ref_type ?? '',
            row.ref_id ?? '',
            row.status,
          ]
            .map(csvCell)
            .join(','),
        );
      }

      const stamp = new Date().toISOString().slice(0, 10);
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="points-ledger-${stamp}.csv"`);
      return lines.join('\r\n');
    },
  );

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

/** Shared by the JSON and CSV ledger endpoints so they cannot drift. */
function parseLedgerQuery(
  query: Record<string, string | undefined>,
  defaults: { limit?: number; maxLimit?: number } = {},
): LedgerQuery & { limit: number; offset: number } {
  const maxLimit = defaults.maxLimit ?? 1000;
  const limit = Math.min(
    Math.max(Number(query.limit) || defaults.limit || 50, 1),
    maxLimit,
  );

  const date = (value: string | undefined): Date | null => {
    if (!value) return null;
    const parsed = new Date(value);
    // An unparseable date would become `Invalid Date` and silently match
    // nothing, which reads as "no results" rather than "bad input".
    if (Number.isNaN(parsed.getTime())) {
      throw ApiError.badRequest(`"${value}" is not a date the server understands`);
    }
    return parsed;
  };

  const status = (['pending', 'cleared', 'reversed'] as const).find(
    (candidate) => candidate === query.status,
  );
  const direction = (['credit', 'debit'] as const).find(
    (candidate) => candidate === query.direction,
  );

  return {
    contactId: query.contactId ?? null,
    ruleKey: query.ruleKey ?? null,
    refType: query.refType ?? null,
    status: status ?? null,
    direction: direction ?? null,
    from: date(query.from),
    to: date(query.to),
    search: query.search ? query.search.slice(0, 120) : null,
    limit,
    offset: Math.max(Number(query.offset) || 0, 0),
  };
}

/**
 * Quote a CSV field.
 *
 * The leading apostrophe on =, +, - and @ is deliberate: without it a reason
 * or customer name starting with one of those is executed as a formula when
 * the file is opened in Excel or Sheets. A ledger export is exactly the kind
 * of file someone opens in a spreadsheet, and the text came from the public
 * internet.
 */
function csvCell(value: string): string {
  const text = String(value ?? '');

  // A plain number is left alone. Guarding `-50` turned every debit in the
  // ledger into the text `'-50`, which is not a number in any spreadsheet and
  // makes the export useless for the one thing it is for — adding up points.
  const isNumber = /^-?\d+(?:\.\d+)?$/.test(text);

  const guarded = !isNumber && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Shape of a filter group, recursively.
 *
 * Only the shape: which fields and operators are real is the compiler's
 * business, and duplicating that list here would give two places to forget to
 * update. Depth is bounded by the compiler too, but bounding it here as well
 * stops a deeply nested body from costing anything to reject.
 */
const filterSchema = z.object({
  field: z.string().max(64),
  operator: z.string().max(32),
  value: z.unknown().optional(),
});

const filterGroupSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    match: z.enum(['all', 'any']).default('all'),
    filters: z.array(filterSchema).max(50).optional(),
    groups: z.array(filterGroupSchema).max(20).optional(),
  }),
);
