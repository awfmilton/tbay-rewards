import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * Who does not earn points.
 *
 * Every store hits this on its first day: staff place test orders, the owner
 * buys something, and both end up on the leaderboard above real customers.
 * myCred solves it with excluded user ids and roles in settings; this is the
 * same idea, stored per tenant so it can be managed through the API.
 *
 * Exclusion suppresses *earning*, not identity — an excluded contact is still
 * tracked, still receives email, and keeps whatever balance they already had.
 * Silently voiding history would be worse than never awarding in the first
 * place.
 */

export type ExclusionKind = 'contact' | 'email' | 'email_domain' | 'role' | 'tag';

export const EXCLUSION_KINDS: ExclusionKind[] = [
  'contact',
  'email',
  'email_domain',
  'role',
  'tag',
];

export interface RewardExclusion {
  id: string;
  tenant_id: string;
  kind: ExclusionKind;
  value: string;
  note: string;
  created_at: Date;
}

/** Normalise so a match never depends on how the value was typed. */
export function normaliseExclusionValue(kind: ExclusionKind, value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) throw ApiError.badRequest('An exclusion needs a value');
  if (kind === 'email_domain') return trimmed.replace(/^@+/, '');
  return trimmed;
}

export async function addExclusion(
  tenantId: string,
  input: { kind: ExclusionKind; value: string; note?: string },
  runner: Queryable = db(),
): Promise<RewardExclusion> {
  if (!EXCLUSION_KINDS.includes(input.kind)) {
    throw ApiError.badRequest(`kind must be one of ${EXCLUSION_KINDS.join(', ')}`);
  }
  const value = normaliseExclusionValue(input.kind, input.value);
  const row = await queryOne<RewardExclusion>(
    runner,
    `INSERT INTO reward_exclusions (tenant_id, kind, value, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, kind, value) DO UPDATE SET note = EXCLUDED.note
     RETURNING *`,
    [tenantId, input.kind, value, input.note ?? ''],
  );
  return row!;
}

export async function removeExclusion(
  tenantId: string,
  id: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM reward_exclusions WHERE tenant_id = $1 AND id = $2',
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

export async function listExclusions(
  tenantId: string,
  runner: Queryable = db(),
): Promise<RewardExclusion[]> {
  const { rows } = await runner.query<RewardExclusion>(
    'SELECT * FROM reward_exclusions WHERE tenant_id = $1 ORDER BY kind, value',
    [tenantId],
  );
  return rows;
}

/**
 * Is this contact excluded from earning?
 *
 * One query rather than five: the contact's own identifiers are assembled in
 * SQL and matched against the table, so adding an exclusion kind later means
 * one more branch here and nothing in the hot path of `trigger`.
 *
 * Roles come from the WordPress plugin via `attributes.roles`, because the
 * platform has no notion of a WordPress role on its own.
 */
export async function isExcluded(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<{ excluded: boolean; reason: string | null }> {
  const row = await queryOne<{ kind: string; value: string }>(
    runner,
    `WITH me AS (
       SELECT id,
              lower(coalesce(email_normalised, email, '')) AS email,
              tags,
              coalesce(attributes->'roles', '[]'::jsonb) AS roles
         FROM contacts
        WHERE tenant_id = $1 AND id = $2
     )
     SELECT x.kind, x.value
       FROM reward_exclusions x, me
      WHERE x.tenant_id = $1
        AND (
          (x.kind = 'contact'      AND x.value = me.id::text)
       OR (x.kind = 'email'        AND me.email <> '' AND x.value = me.email)
       OR (x.kind = 'email_domain' AND me.email <> '' AND me.email LIKE '%@' || x.value)
       OR (x.kind = 'tag'          AND x.value = ANY (SELECT lower(t) FROM unnest(me.tags) AS t))
       OR (x.kind = 'role'         AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(me.roles) AS r
               WHERE lower(r) = x.value))
        )
      LIMIT 1`,
    [tenantId, contactId],
  );

  if (!row) return { excluded: false, reason: null };
  return { excluded: true, reason: `${row.kind}:${row.value}` };
}
