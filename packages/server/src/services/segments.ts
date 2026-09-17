import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { limitOf, offsetOf } from '../lib/paging.js';
import { listFields } from './contact-fields.js';
import { compileGroup, type CustomFields, type FilterGroup } from './segment-filters.js';
import { assertGamificationKey } from './gamification.js';

/**
 * Dynamic segments.
 *
 * A segment is *defined* by its filters and nothing else. `segment_members` is
 * a cache of the last evaluation, which exists for two reasons: evaluating a
 * filter tree per contact per send does not scale, and a broadcast needs a
 * stable audience — a contact who stops matching halfway through a send should
 * not vanish from it mid-flight.
 *
 * So: counting and previewing run the filters live, sending runs from the
 * materialised list, and `build` is what moves one to the other.
 */

export interface Segment {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  definition: FilterGroup;
  member_count: number;
  last_built_at: Date | null;
  last_build_ms: number | null;
  build_error: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

async function timezoneOf(tenantId: string, runner: Queryable): Promise<string> {
  const row = await queryOne<{ timezone: string | null }>(
    runner,
    'SELECT timezone FROM tenants WHERE id = $1',
    [tenantId],
  );
  return row?.timezone?.trim() || 'UTC';
}

export async function upsertSegment(
  tenantId: string,
  input: {
    key: string;
    name?: string;
    description?: string;
    definition?: FilterGroup;
    enabled?: boolean;
  },
  runner: Queryable = db(),
): Promise<Segment> {
  const key = assertGamificationKey(input.key, 'segment key');

  if (input.definition) {
    // Compile now so a broken definition is rejected at save time rather than
    // at send time, when an admin is watching a broadcast fail instead of a
    // form.
    compileGroup(
      input.definition,
      await timezoneOf(tenantId, runner),
      0,
      0,
      undefined,
      await customFieldsFor(tenantId, runner),
    );
  }

  const row = await queryOne<Segment>(
    runner,
    `INSERT INTO segments (tenant_id, key, name, description, definition, enabled)
     VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{"match":"all","filters":[]}'::jsonb),
             COALESCE($6, true))
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, segments.name),
       description = COALESCE(EXCLUDED.description, segments.description),
       definition = COALESCE($5::jsonb, segments.definition),
       enabled = COALESCE($6, segments.enabled),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      key,
      input.name ?? key,
      input.description ?? '',
      input.definition ? JSON.stringify(input.definition) : null,
      input.enabled ?? null,
    ],
  );
  return row!;
}

export async function getSegment(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<Segment | null> {
  return queryOne<Segment>(
    runner,
    'SELECT * FROM segments WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
}

export async function listSegments(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Segment[]> {
  const { rows } = await runner.query<Segment>(
    'SELECT * FROM segments WHERE tenant_id = $1 ORDER BY name',
    [tenantId],
  );
  return rows;
}

export async function deleteSegment(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM segments WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rowCount ?? 0) > 0;
}

interface CompiledQuery {
  where: string;
  params: unknown[];
}

/** The retailer's own fields, as the compiler wants them: key to kind. */
export async function customFieldsFor(tenantId: string, runner: Queryable): Promise<CustomFields> {
  const fields = await listFields(tenantId, runner);
  return new Map(fields.map((field) => [field.key, field.kind]));
}

async function compileFor(
  tenantId: string,
  definition: FilterGroup,
  runner: Queryable,
): Promise<CompiledQuery> {
  const timezone = await timezoneOf(tenantId, runner);
  // $1 is the tenant, so filter parameters start at index 1.
  const compiled = compileGroup(
    definition,
    timezone,
    1,
    0,
    undefined,
    await customFieldsFor(tenantId, runner),
  );
  return {
    where: `c.tenant_id = $1 AND (${compiled.sql})`,
    params: [tenantId, ...compiled.params],
  };
}

/** How many contacts a definition matches right now, without saving it. */
export async function countMatching(
  tenantId: string,
  definition: FilterGroup,
  runner: Queryable = db(),
): Promise<number> {
  const { where, params } = await compileFor(tenantId, definition, runner);
  const row = await queryOne<{ n: string }>(
    runner,
    `SELECT COUNT(*) AS n FROM contacts c WHERE ${where}`,
    params,
  );
  return Number(row?.n ?? 0);
}

/**
 * A sample of who matches, for the filter builder.
 *
 * An admin about to mail forty thousand people should be able to see twenty of
 * them first. A count alone does not catch "I meant *not* tagged vip".
 */
export async function previewMatching(
  tenantId: string,
  definition: FilterGroup,
  limit = 20,
  runner: Queryable = db(),
): Promise<Array<{ id: string; email: string | null; name: string | null }>> {
  const { where, params } = await compileFor(tenantId, definition, runner);
  const { rows } = await runner.query<{ id: string; email: string | null; name: string | null }>(
    `SELECT c.id, c.email, c.name FROM contacts c
      WHERE ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limitOf(limit, 20, 100)}`,
    params,
  );
  return rows;
}

export interface BuildResult {
  key: string;
  members: number;
  added: number;
  removed: number;
  durationMs: number;
}

/**
 * Materialise a segment's membership.
 *
 * Differential rather than delete-and-reinsert: `added_at` is worth keeping
 * (it answers "how long has this person been in the win-back segment"), and a
 * truncate would make the segment briefly empty for anything reading it
 * concurrently.
 */
export async function buildSegment(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<BuildResult> {
  const segment = await getSegment(tenantId, key, runner);
  if (!segment) throw ApiError.notFound(`No segment "${key}"`);

  const started = Date.now();

  try {
    const { where, params } = await compileFor(tenantId, segment.definition, runner);
    const segmentParam = `$${params.length + 1}`;

    const added = await runner.query(
      `INSERT INTO segment_members (segment_id, contact_id)
       SELECT ${segmentParam}, c.id FROM contacts c WHERE ${where}
       ON CONFLICT (segment_id, contact_id) DO NOTHING`,
      [...params, segment.id],
    );

    const removed = await runner.query(
      `DELETE FROM segment_members m
        WHERE m.segment_id = ${segmentParam}
          AND NOT EXISTS (
            SELECT 1 FROM contacts c WHERE c.id = m.contact_id AND ${where}
          )`,
      [...params, segment.id],
    );

    const total = await queryOne<{ n: string }>(
      runner,
      'SELECT COUNT(*) AS n FROM segment_members WHERE segment_id = $1',
      [segment.id],
    );

    const members = Number(total?.n ?? 0);
    const durationMs = Date.now() - started;

    await runner.query(
      `UPDATE segments
          SET member_count = $2, last_built_at = now(), last_build_ms = $3,
              build_error = NULL, updated_at = now()
        WHERE id = $1`,
      [segment.id, members, durationMs],
    );

    return {
      key: segment.key,
      members,
      added: added.rowCount ?? 0,
      removed: removed.rowCount ?? 0,
      durationMs,
    };
  } catch (err) {
    // Record the failure on the segment rather than only throwing: a segment
    // that silently stopped rebuilding is how a broadcast goes to a stale
    // audience without anyone noticing.
    const message = err instanceof Error ? err.message : String(err);
    await runner.query(
      'UPDATE segments SET build_error = $2, updated_at = now() WHERE id = $1',
      [segment.id, message.slice(0, 500)],
    );
    throw err;
  }
}

/** Rebuild every enabled segment. Called by the worker. */
export async function buildAllSegments(
  runner: Queryable = db(),
): Promise<{ built: number; failed: number }> {
  const { rows } = await runner.query<{ tenant_id: string; key: string }>(
    'SELECT tenant_id, key FROM segments WHERE enabled ORDER BY last_built_at NULLS FIRST',
  );

  let built = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await buildSegment(row.tenant_id, row.key, runner);
      built += 1;
    } catch {
      // buildSegment already recorded the reason on the segment.
      failed += 1;
    }
  }
  return { built, failed };
}

export interface AudienceOptions {
  /** Only contacts who may lawfully receive marketing. */
  marketingOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * The contacts a send should actually reach.
 *
 * Reads the materialised membership, then applies the consent and suppression
 * rules on top. Those are deliberately *not* part of the segment definition: a
 * segment answers "who are these people", and consent answers "may we mail
 * them". Folding the second into the first means every segment an admin builds
 * has to remember the rule, and one that forgets mails people who opted out.
 */
export async function segmentAudience(
  tenantId: string,
  key: string,
  options: AudienceOptions = {},
  runner: Queryable = db(),
): Promise<Array<{ id: string; email: string; name: string | null }>> {
  const segment = await getSegment(tenantId, key, runner);
  if (!segment) throw ApiError.notFound(`No segment "${key}"`);

  const limit = limitOf(options.limit, 500, 10_000);
  const offset = offsetOf(options.offset);

  const { rows } = await runner.query<{ id: string; email: string; name: string | null }>(
    `SELECT c.id, c.email, c.name
       FROM segment_members m
       JOIN contacts c ON c.id = m.contact_id
      WHERE m.segment_id = $1
        AND c.email IS NOT NULL
        AND ($2::boolean IS NOT TRUE OR c.marketing_consent)
        AND NOT EXISTS (
          SELECT 1 FROM email_suppressions s
           WHERE s.tenant_id = c.tenant_id
             AND s.email = lower(coalesce(c.email_normalised, c.email))
             AND (s.expires_at IS NULL OR s.expires_at > now())
        )
      ORDER BY c.id
      LIMIT ${limit} OFFSET ${offset}`,
    [segment.id, options.marketingOnly ?? true],
  );

  return rows;
}

export async function audienceSize(
  tenantId: string,
  key: string,
  marketingOnly = true,
  runner: Queryable = db(),
): Promise<number> {
  const segment = await getSegment(tenantId, key, runner);
  if (!segment) throw ApiError.notFound(`No segment "${key}"`);

  const row = await queryOne<{ n: string }>(
    runner,
    `SELECT COUNT(*) AS n
       FROM segment_members m
       JOIN contacts c ON c.id = m.contact_id
      WHERE m.segment_id = $1
        AND c.email IS NOT NULL
        AND ($2::boolean IS NOT TRUE OR c.marketing_consent)
        AND NOT EXISTS (
          SELECT 1 FROM email_suppressions s
           WHERE s.tenant_id = c.tenant_id
             AND s.email = lower(coalesce(c.email_normalised, c.email))
             AND (s.expires_at IS NULL OR s.expires_at > now())
        )`,
    [segment.id, marketingOnly],
  );
  return Number(row?.n ?? 0);
}
