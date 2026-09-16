import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * Who did that.
 *
 * Every secret key can do everything, which is fine for one person running one
 * store and stops being fine the moment a second person has the key. Two things
 * were missing: a key attributable to a named person and limited to a role, and
 * a record of what was done.
 *
 * No login layer is added. The platform is API-first with WordPress as its
 * front end, and a session system nobody asked for would be the wrong feature.
 */

export const ROLES = ['owner', 'manager', 'support', 'readonly'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Roles as a ladder: each contains everything below it.
 *
 * A ladder rather than a permission matrix because a store has four people,
 * not four hundred, and "support can do everything readonly can" is what an
 * owner actually means. A matrix would be more expressive and less understood.
 */
const RANK: Record<Role, number> = { readonly: 0, support: 1, manager: 2, owner: 3 };

export function atLeast(have: Role, need: Role): boolean {
  return RANK[have] >= RANK[need];
}

export function assertRole(value: unknown): Role {
  const role = String(value ?? '') as Role;
  if (!ROLES.includes(role)) {
    throw ApiError.badRequest(`Role must be one of: ${ROLES.join(', ')}`);
  }
  return role;
}

export interface Operator {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: Role;
  disabled_at: Date | null;
}

export async function listOperators(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Operator[]> {
  const { rows } = await runner.query<Operator>(
    'SELECT * FROM operators WHERE tenant_id = $1 ORDER BY role DESC, email',
    [tenantId],
  );
  return rows;
}

export async function upsertOperator(
  tenantId: string,
  input: { email: string; name?: string; role?: Role; disabled?: boolean },
  runner: Queryable = db(),
): Promise<Operator> {
  const email = String(input.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw ApiError.badRequest('An operator needs a valid email address');
  }
  const role = input.role ? assertRole(input.role) : null;

  const row = await queryOne<Operator>(
    runner,
    `INSERT INTO operators (tenant_id, email, name, role, disabled_at)
     VALUES ($1, $2, COALESCE($3, ''), COALESCE($4, 'support'),
             CASE WHEN $5 THEN now() ELSE NULL END)
     ON CONFLICT (tenant_id, lower(email)) DO UPDATE SET
       name = COALESCE($3, operators.name),
       role = COALESCE($4, operators.role),
       -- Not COALESCE on a boolean: passing false is how somebody is brought
       -- back, so it has to be written rather than read as "unchanged".
       disabled_at = CASE
                       WHEN $5 IS NULL THEN operators.disabled_at
                       WHEN $5 THEN COALESCE(operators.disabled_at, now())
                       ELSE NULL
                     END,
       updated_at = now()
     RETURNING *`,
    [tenantId, email, input.name ?? null, role, input.disabled ?? null],
  );
  return row!;
}

/**
 * Remove an operator.
 *
 * Their keys survive, stripped of the attribution — revoking somebody's access
 * and silently revoking an integration key they happened to issue are different
 * decisions, and doing the second while meaning the first takes a storefront
 * down. The keys drop to the tenant default, so an owner sees them and can
 * revoke them deliberately.
 */
export async function deleteOperator(
  tenantId: string,
  email: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM operators WHERE tenant_id = $1 AND lower(email) = lower($2)',
    [tenantId, email],
  );
  return (rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit log
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  operatorId?: string | null;
  keyId?: string | null;
  actorLabel?: string;
  role?: string | null;
  action: string;
  status: number;
  target?: string | null;
  detail?: Record<string, unknown>;
  ipHash?: string | null;
}

/**
 * Record one privileged action.
 *
 * Never throws. An audit write that can fail a request turns observability
 * into an outage — and the failure mode of a lost audit line is far better
 * than the failure mode of a customer's order not being recorded because the
 * log table was full.
 */
export async function recordAudit(
  tenantId: string,
  entry: AuditEntry,
  runner: Queryable = db(),
): Promise<void> {
  try {
    await runner.query(
      `INSERT INTO audit_log (
         tenant_id, operator_id, key_id, actor_label, role,
         action, status, target, detail, ip_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        tenantId,
        entry.operatorId ?? null,
        entry.keyId ?? null,
        entry.actorLabel ?? '',
        entry.role ?? null,
        entry.action,
        entry.status,
        entry.target ?? null,
        JSON.stringify(entry.detail ?? {}),
        entry.ipHash ?? null,
      ],
    );
  } catch {
    // Deliberately silent: see above.
  }
}

export interface AuditQuery {
  operatorId?: string | null;
  target?: string | null;
  action?: string | null;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
  offset?: number;
}

export async function queryAudit(
  tenantId: string,
  query: AuditQuery = {},
  runner: Queryable = db(),
): Promise<{ rows: unknown[]; total: number }> {
  const { limitOf, offsetOf } = await import('../lib/paging.js');
  const limit = limitOf(query.limit, 50, 1000);
  const offset = offsetOf(query.offset);

  const where: string[] = ['a.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (query.operatorId) add('a.operator_id = $?', query.operatorId);
  if (query.target) add('a.target = $?', query.target);
  // Prefix, so "everything anybody did to the ledger" is one filter rather
  // than a list of every route under it.
  if (query.action) add('a.action LIKE $?', `${query.action.replace(/[\\%_]/g, '\\$&')}%`);
  if (query.from) add('a.created_at >= $?', query.from);
  if (query.to) add('a.created_at < $?', query.to);

  const clause = where.join(' AND ');

  const total = await queryOne<{ n: string }>(
    runner,
    `SELECT COUNT(*) AS n FROM audit_log a WHERE ${clause}`,
    params,
  );

  const { rows } = await runner.query(
    `SELECT a.*, o.email AS operator_email, o.name AS operator_name
       FROM audit_log a
       LEFT JOIN operators o ON o.id = a.operator_id AND o.tenant_id = a.tenant_id
      WHERE ${clause}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  return { rows, total: Number(total?.n ?? 0) };
}
