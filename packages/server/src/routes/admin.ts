import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, queryOne } from '../db/pool.js';
import { requireSecretKey, tenantOf } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { parse } from './collect.js';
import { contactHandleSchema, pointTypeField } from './schemas.js';
import { limitOf, uuidOf } from '../lib/paging.js';
import {
  eraseContact,
  exportContact,
  getRetentionPolicy,
  setRetentionPolicy,
} from '../services/privacy.js';
import {
  deleteTopic,
  getPreferences,
  listTopics,
  setPreferences,
  upsertTopic,
} from '../services/preferences.js';
import {
  deleteField,
  getFieldValues,
  listFields,
  setFieldValues,
  upsertField,
} from '../services/contact-fields.js';
import { findDuplicates, mergeContacts, previewMerge } from '../services/merge.js';
import {
  ROLES,
  deleteOperator,
  listOperators,
  queryAudit,
  upsertOperator,
} from '../services/operators.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import {
  deleteReport,
  describeSources,
  listReports,
  runReport,
  toCsv,
  upsertReport,
} from '../services/reports.js';
import {
  deleteSchedule,
  listSchedules,
  sendNow,
  upsertSchedule,
} from '../services/report-schedules.js';
import {
  deletePointType,
  listPointTypes,
  upsertPointType,
} from '../services/point-types.js';
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

/**
 * The shape of a report definition.
 *
 * Shape only — every name inside is checked against the catalogue in
 * services/reports.ts, which is where "is this a real dimension" is decided.
 * Zod cannot know that, and duplicating the catalogue here would be two lists
 * to keep in step.
 */
const reportDefinitionSchema = z.object({
  source: z.string().max(40),
  dimensions: z.array(z.string().max(60)).max(4).default([]),
  measures: z.array(z.string().max(60)).min(1).max(8),
  filters: z.record(z.unknown()).optional(),
  days: z.number().int().min(1).max(3650).nullable().optional(),
  sort: z.string().max(60).nullish(),
  sortAsc: z.boolean().optional(),
  limit: z.number().int().min(1).max(50_000).optional(),
});

const keySchema = z.string().regex(/^[a-z0-9_]{2,64}$/, 'Use 2-64 chars of a-z, 0-9 or underscore');

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // `onRequest`, not `preHandler`: authentication should reject before the
  // body is read, and the role guard in lib/authorise.ts runs at preHandler —
  // which is the phase after this one, so by then the key has been resolved.
  app.addHook('onRequest', async (request) => {
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
    return { removed: await removeExclusion(tenant.id, uuidOf(request.params.id, 'id')!) };
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
    return { removed: await deleteProductRule(tenant.id, uuidOf(request.params.id, 'id')!) };
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
          // So a screen showing this person can tell they are already erased
          // rather than offering to erase them a second time.
          erased_at: contact.erased_at,
        },
        fields: await listFields(tenant.id),
        field_values: await getFieldValues(tenant.id, contact.id),
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
  /**
   * Everything a segment can filter on, platform and retailer alike.
   *
   * The custom ones are addressed `cf_<key>` so they cannot shadow a built-in
   * — a retailer defining a field called "email" gets `cf_email`, and the
   * platform's `email` still means the address.
   */
  app.get('/v1/segments/fields', async (request) => {
    const tenant = tenantOf(request);
    const custom = await listFields(tenant.id);
    return {
      fields: [
        ...describeFields(),
        ...custom.map((field) => ({
          key: `cf_${field.key}`,
          label: field.label,
          kind: field.kind === 'select' ? 'text' : field.kind,
          custom: true,
          options: field.options,
        })),
      ],
    };
  });

  // ── Saved reports ──────────────────────────────────────────────────────────
  //
  // `/v1/saved-reports`, not `/v1/reports`. The latter is the fixed analytics
  // — overview, pages, products, traffic sources — and a `:key` parameter
  // mounted there would shadow every one of them, including the
  // `/v1/reports/sources` this very endpoint nearly collided with.

  /** Everything a report can be built from: sources, dimensions, measures. */
  app.get('/v1/saved-reports/catalogue', async () => ({ sources: describeSources() }));

  app.get('/v1/saved-reports', async (request) => {
    const tenant = tenantOf(request);
    return {
      reports: await listReports(tenant.id),
      schedules: await listSchedules(tenant.id),
    };
  });

  app.put<{ Params: { key: string } }>('/v1/saved-reports/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(500).optional(),
      definition: reportDefinitionSchema,
    });
    const input = parse(schema, request.body);
    return {
      report: await upsertReport(tenant.id, {
        key: request.params.key,
        ...input,
        // The filter tree's *shape* is checked by the segment filter compiler,
        // which is where every field name and operator is looked up. Zod only
        // knows it is an object.
        definition: input.definition as never,
      }),
    };
  });

  app.delete<{ Params: { key: string } }>('/v1/saved-reports/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteReport(tenant.id, request.params.key) };
  });

  /**
   * Run a definition without saving it, so the admin screen can show the
   * numbers while somebody is still deciding what to ask for.
   */
  app.post('/v1/saved-reports/run', async (request) => {
    const tenant = tenantOf(request);
    const input = parse(z.object({ definition: reportDefinitionSchema }), request.body);
    return runReport(tenant.id, input.definition as never);
  });

  app.get<{ Params: { key: string } }>('/v1/saved-reports/:key/run', async (request) => {
    const tenant = tenantOf(request);
    const report = await queryOne<{ definition: unknown }>(
      db(),
      'SELECT definition FROM reports WHERE tenant_id = $1 AND key = $2',
      [tenant.id, request.params.key],
    );
    if (!report) throw ApiError.notFound(`No report "${request.params.key}"`);
    return runReport(tenant.id, report.definition as never);
  });

  app.get<{ Params: { key: string } }>('/v1/saved-reports/:key/run.csv', async (request, reply) => {
    const tenant = tenantOf(request);
    const report = await queryOne<{ definition: unknown; name: string }>(
      db(),
      'SELECT definition, name FROM reports WHERE tenant_id = $1 AND key = $2',
      [tenant.id, request.params.key],
    );
    if (!report) throw ApiError.notFound(`No report "${request.params.key}"`);

    const result = await runReport(tenant.id, report.definition as never);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="${request.params.key}-${stamp}.csv"`,
      )
      .send(toCsv(result));
  });

  app.put<{ Params: { key: string } }>('/v1/saved-reports/:key/schedule', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      cadence: z.enum(['daily', 'weekly', 'monthly']).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      dayOfWeek: z.number().int().min(0).max(6).optional(),
      // 28 rather than 31, so February never silently skips a send.
      dayOfMonth: z.number().int().min(1).max(28).optional(),
      recipients: z.array(z.string().email().max(254)).max(20).optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body ?? {});
    return {
      schedule: await upsertSchedule(tenant.id, { reportKey: request.params.key, ...input }),
    };
  });

  app.delete<{ Params: { key: string } }>('/v1/saved-reports/:key/schedule', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteSchedule(tenant.id, request.params.key) };
  });

  /** Send one now, without consuming the scheduled send. */
  app.post<{ Params: { key: string } }>('/v1/saved-reports/:key/send', async (request) => {
    const tenant = tenantOf(request);
    return sendNow(tenant.id, request.params.key);
  });

  app.get<{ Querystring: { limit?: string } }>('/v1/saved-reports/runs', async (request) => {
    const tenant = tenantOf(request);
    const limit = limitOf(request.query.limit, 50, 500);
    const { rows } = await db().query(
      `SELECT rr.*, r.key AS report_key, r.name AS report_name
         FROM report_runs rr
         LEFT JOIN reports r ON r.id = rr.report_id
        WHERE rr.tenant_id = $1
        ORDER BY rr.created_at DESC LIMIT ${limit}`,
      [tenant.id],
    );
    return { runs: rows };
  });

  // ── Operators, keys and the record ─────────────────────────────────────────
  //
  // Everything here needs the `owner` role; see lib/authorise.ts. A manager who
  // can mint an owner key is an owner.

  app.get('/v1/operators', async (request) => {
    const tenant = tenantOf(request);
    return { operators: await listOperators(tenant.id) };
  });

  app.put('/v1/operators', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      email: z.string().email().max(254),
      name: z.string().max(200).optional(),
      role: z.enum(ROLES).optional(),
      disabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body);
    return { operator: await upsertOperator(tenant.id, input) };
  });

  app.delete<{ Params: { email: string } }>('/v1/operators/:email', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteOperator(tenant.id, request.params.email) };
  });

  app.get('/v1/keys', async (request) => {
    const tenant = tenantOf(request);
    const { rows } = await db().query(
      `SELECT k.key_id, k.kind, k.label, k.role, k.last_used_at, k.revoked_at, k.created_at,
              o.email AS operator_email
         FROM tenant_keys k
         LEFT JOIN operators o ON o.id = k.operator_id
        WHERE k.tenant_id = $1
        ORDER BY k.created_at DESC`,
      [tenant.id],
    );
    // No hashes, ever: a list of keys is not a way to get one.
    return { keys: rows };
  });

  /**
   * Issue a key, optionally narrower than the person holding it.
   *
   * The secret is returned once and never again — it is stored as a hash, so
   * there is nothing to show a second time even if somebody asks.
   */
  app.post('/v1/keys', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      label: z.string().max(120).optional(),
      operatorEmail: z.string().email().max(254).optional(),
      role: z.enum(ROLES).optional(),
    });
    const input = parse(schema, request.body ?? {});

    let operatorId: string | null = null;
    if (input.operatorEmail) {
      const operator = await queryOne<{ id: string }>(
        db(),
        'SELECT id FROM operators WHERE tenant_id = $1 AND lower(email) = lower($2)',
        [tenant.id, input.operatorEmail],
      );
      if (!operator) throw ApiError.notFound(`No operator "${input.operatorEmail}"`);
      operatorId = operator.id;
    }

    const keyId = `tbs_${randomToken(8)}`;
    const secret = randomToken(24);
    await db().query(
      `INSERT INTO tenant_keys (tenant_id, kind, key_id, secret_hash, label, operator_id, role)
       VALUES ($1, 'secret', $2, $3, $4, $5, $6)`,
      [tenant.id, keyId, hashToken(secret), input.label ?? '', operatorId, input.role ?? null],
    );

    return {
      key_id: keyId,
      secret: `${keyId}.${secret}`,
      role: input.role ?? null,
      note: 'Shown once. It is stored as a hash, so it cannot be shown again.',
    };
  });

  app.delete<{ Params: { keyId: string } }>('/v1/keys/:keyId', async (request) => {
    const tenant = tenantOf(request);
    const { rowCount } = await db().query(
      `UPDATE tenant_keys SET revoked_at = now()
        WHERE tenant_id = $1 AND key_id = $2 AND revoked_at IS NULL`,
      [tenant.id, request.params.keyId],
    );
    return { revoked: (rowCount ?? 0) > 0 };
  });

  /**
   * What was done, and by whom.
   *
   * Append-only: there is deliberately no edit or delete here, for the same
   * reason the points ledger has none. A log somebody can rewrite answers no
   * question worth asking.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/audit',
    async (request) => {
      const tenant = tenantOf(request);
      const date = (value: string | undefined): Date | null => {
        if (!value) return null;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) {
          throw ApiError.badRequest(`"${value}" is not a date the server understands`);
        }
        return parsed;
      };

      const result = await queryAudit(tenant.id, {
        operatorId: uuidOf(request.query.operatorId, 'operatorId'),
        target: request.query.target ?? null,
        action: request.query.action ?? null,
        from: date(request.query.from),
        to: date(request.query.to),
        limit: Number(request.query.limit) || 50,
        offset: Number(request.query.offset) || 0,
      });

      return { total: result.total, entries: result.rows };
    },
  );

  // ── Merging duplicates ─────────────────────────────────────────────────────

  /**
   * Contacts that look like the same person.
   *
   * Deliberately narrow: a shared phone number or a shared name is a
   * household, not a duplicate.
   */
  app.get<{ Querystring: { limit?: string } }>('/v1/contacts/duplicates', async (request) => {
    const tenant = tenantOf(request);
    return {
      duplicates: await findDuplicates(tenant.id, limitOf(request.query.limit, 50, 500)),
    };
  });

  app.get<{ Querystring: { keep?: string; merge?: string } }>(
    '/v1/contacts/merge/preview',
    async (request) => {
      const tenant = tenantOf(request);
      const keep = uuidOf(request.query.keep, 'keep');
      const merge = uuidOf(request.query.merge, 'merge');
      if (!keep || !merge) throw ApiError.badRequest('Both "keep" and "merge" are required');
      return previewMerge(tenant.id, keep, merge);
    },
  );

  /**
   * Merge one contact into another. Irreversible, and it moves points.
   *
   * The survivor keeps its own id, so every link a retailer has already saved
   * — a WordPress user meta, a webhook payload, a printed card — still
   * resolves.
   */
  app.post('/v1/contacts/merge', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      keep: z.string().uuid(),
      merge: z.string().uuid(),
    });
    const input = parse(schema, request.body);
    return mergeContacts(tenant.id, input.keep, input.merge);
  });

  // ── The retailer's own contact fields ──────────────────────────────────────

  app.get('/v1/contacts/fields', async (request) => {
    const tenant = tenantOf(request);
    return { fields: await listFields(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/contacts/fields/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      label: z.string().min(1).max(120).optional(),
      description: z.string().max(400).optional(),
      kind: z.enum(['text', 'number', 'date', 'boolean', 'select']).optional(),
      options: z.array(z.string().min(1).max(120)).max(100).optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
    });
    const input = parse(schema, request.body ?? {});
    return { field: await upsertField(tenant.id, { key: request.params.key, ...input }) };
  });

  app.delete<{ Params: { key: string } }>('/v1/contacts/fields/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteField(tenant.id, request.params.key) };
  });

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/contacts/field-values',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return { values: await getFieldValues(tenant.id, contact.id) };
    },
  );

  app.put('/v1/contacts/field-values', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      values: z.record(z.unknown()),
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);
    return { values: await setFieldValues(tenant.id, contact.id, input.values) };
  });

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
        'point_type', 'delta_points', 'reason', 'rule_key', 'ref_type', 'ref_id',
        'status',
      ];
      const lines = [header.join(',')];
      for (const row of result.rows) {
        lines.push(
          [
            new Date(row.created_at).toISOString(),
            row.contact_id,
            row.contact_email ?? '',
            row.contact_name ?? '',
            row.point_type,
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
      pointType: pointTypeField,
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

  // ── Email topics ───────────────────────────────────────────────────────────
  //
  // What a recipient can choose between on the preference page. A retailer who
  // defines none keeps today's behaviour exactly: no topics, so nothing is
  // filtered by topic and the page offers only the pause.

  app.get('/v1/email/topics', async (request) => {
    const tenant = tenantOf(request);
    return { topics: await listTopics(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/email/topics/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(120).optional(),
      description: z.string().max(400).optional(),
      selectable: z.boolean().optional(),
      defaultOn: z.boolean().optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
    });
    const input = parse(schema, request.body ?? {});
    return { topic: await upsertTopic(tenant.id, { key: request.params.key, ...input }) };
  });

  app.delete<{ Params: { key: string } }>('/v1/email/topics/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deleteTopic(tenant.id, request.params.key) };
  });

  /**
   * What people chose instead of leaving.
   *
   * The number that says whether the preference page is earning its keep: a
   * pause or a topic change is somebody who would otherwise have unsubscribed.
   */
  app.get<{ Querystring: { days?: string } }>('/v1/email/preferences/report', async (request) => {
    const tenant = tenantOf(request);
    const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 365);
    const { rows } = await db().query(
      `SELECT action, COUNT(*)::int AS n FROM preference_changes
        WHERE tenant_id = $1 AND created_at >= now() - ($2 || ' days')::interval
        GROUP BY action ORDER BY action`,
      [tenant.id, String(days)],
    );
    return { days, changes: rows };
  });

  /** One contact's preferences, for the customer screen. */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/email/preferences',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return { preferences: await getPreferences(tenant.id, contact.id) };
    },
  );

  app.put('/v1/email/preferences', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      topics: z.record(z.boolean()).optional(),
      pauseDays: z.number().int().min(0).max(365).nullable().optional(),
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    return {
      preferences: await setPreferences(tenant.id, contact.id, {
        topics: input.topics,
        pauseDays: input.pauseDays,
      }),
    };
  });

  // ── Privacy ────────────────────────────────────────────────────────────────

  /**
   * Everything held about one person, for a subject access request.
   *
   * Deliberately the raw rows rather than a summary: somebody asking what is
   * held is entitled to what is held, not to our description of it.
   */
  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/v1/privacy/export',
    async (request) => {
      const tenant = tenantOf(request);
      const contact = await requireContact(tenant.id, request.query);
      return exportContact(tenant.id, contact.id);
    },
  );

  /**
   * Erase a person, keeping the retailer's books.
   *
   * The contact row survives, stripped of everything that identifies them.
   * Deleting it would cascade through the points ledger and take the
   * retailer's own financial record with it.
   */
  app.post('/v1/privacy/erase', async (request) => {
    const tenant = tenantOf(request);
    const schema = contactHandleSchema.extend({
      reason: z.enum(['request', 'retention', 'admin']).optional(),
      requestedBy: z.string().max(191).optional(),
      /**
       * Default true. An anonymised row with a spendable balance is a
       * liability nobody can reconcile — pay it out first if that is owed.
       */
      forfeitPoints: z.boolean().optional(),
    });
    const input = parse(schema, request.body);
    const contact = await requireContact(tenant.id, input);

    return eraseContact(tenant.id, contact.id, {
      reason: input.reason,
      requestedBy: input.requestedBy ?? null,
      forfeitPoints: input.forfeitPoints,
    });
  });

  /** Proof that erasures were carried out. Holds no personal data. */
  app.get<{ Querystring: { limit?: string } }>('/v1/privacy/erasures', async (request) => {
    const tenant = tenantOf(request);
    const limit = limitOf(request.query.limit, 50, 500);
    const { rows } = await db().query(
      `SELECT id, contact_id, reason, requested_by, points_forfeited, rows_deleted, erased_at
         FROM erasure_log WHERE tenant_id = $1
        ORDER BY erased_at DESC LIMIT ${limit}`,
      [tenant.id],
    );
    return { erasures: rows };
  });

  app.get('/v1/privacy/retention', async (request) => {
    const tenant = tenantOf(request);
    return { retention: await getRetentionPolicy(tenant.id) };
  });

  app.put('/v1/privacy/retention', async (request) => {
    const tenant = tenantOf(request);
    const window = z.number().int().min(1).max(3650).nullable().optional();
    const schema = z.object({
      eventDays: window,
      sessionDays: window,
      emailBodyDays: window,
      notificationDays: window,
    });
    const input = parse(schema, request.body ?? {});

    return {
      retention: await setRetentionPolicy(tenant.id, {
        event_days: input.eventDays ?? null,
        session_days: input.sessionDays ?? null,
        email_body_days: input.emailBodyDays ?? null,
        notification_days: input.notificationDays ?? null,
      }),
    };
  });

  // ── Point types ────────────────────────────────────────────────────────────
  //
  // A retailer running one currency never touches these; the default is
  // installed with the tenant and every other endpoint falls back to it.

  app.get('/v1/point-types', async (request) => {
    const tenant = tenantOf(request);
    return { point_types: await listPointTypes(tenant.id) };
  });

  app.put<{ Params: { key: string } }>('/v1/point-types/:key', async (request) => {
    const tenant = tenantOf(request);
    const schema = z.object({
      name: z.string().min(1).max(100).optional(),
      /** What one and many are called in the storefront. */
      singular: z.string().min(1).max(50).optional(),
      plural: z.string().min(1).max(50).optional(),
      isDefault: z.boolean().optional(),
      /** May become store credit or TBAY. */
      convertible: z.boolean().optional(),
      /** May be sent to another member. */
      transferable: z.boolean().optional(),
      displayOrder: z.number().int().min(0).max(10_000).optional(),
      enabled: z.boolean().optional(),
    });
    const input = parse(schema, request.body ?? {});
    return {
      point_type: await upsertPointType(tenant.id, { key: request.params.key, ...input }),
    };
  });

  app.delete<{ Params: { key: string } }>('/v1/point-types/:key', async (request) => {
    const tenant = tenantOf(request);
    return { removed: await deletePointType(tenant.id, request.params.key) };
  });

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
      pointType: pointTypeField,
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
    const input = parse(
      contactHandleSchema.extend({ pointType: pointTypeField }),
      request.body,
    );
    const contact = await requireContact(tenant.id, input);
    return unpinRank(tenant.id, contact.id, undefined, input.pointType);
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
    contactId: uuidOf(query.contactId, 'contactId'),
    ruleKey: query.ruleKey ?? null,
    pointType: query.pointType ?? null,
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
