import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * Several currencies per retailer.
 *
 * "Points you spend" and "status credits you only accumulate" is the classic
 * pair, and the second only means anything if it genuinely cannot be spent —
 * hence `convertible` and `transferable` as properties of the currency rather
 * than checks scattered through the call sites.
 *
 * The default type is `points`, which is what every row written before this
 * existed already is. A retailer who never creates a second type never sees
 * any of this: every function here defaults to theirs.
 */

export const DEFAULT_POINT_TYPE = 'points';

export interface PointType {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  singular: string;
  plural: string;
  is_default: boolean;
  /** May become store credit or TBAY. */
  convertible: boolean;
  /** May be sent to another member. */
  transferable: boolean;
  display_order: number;
  enabled: boolean;
}

/**
 * Cached because nearly every award, spend and balance read needs one, and a
 * retailer's currency list changes about once a year.
 */
const cache = new Map<string, { types: PointType[]; at: number }>();
const TTL_MS = 60_000;

export function forgetPointTypes(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function listPointTypes(
  tenantId: string,
  runner: Queryable = db(),
  fresh = false,
): Promise<PointType[]> {
  const hit = cache.get(tenantId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.types;

  const { rows } = await runner.query<PointType>(
    `SELECT * FROM point_types WHERE tenant_id = $1 ORDER BY display_order, key`,
    [tenantId],
  );

  // A tenant created before this existed, or mid-migration, still has to be
  // able to earn. Treating an empty list as the implicit default is what keeps
  // the whole feature additive.
  const types =
    rows.length > 0
      ? rows
      : [
          {
            id: '',
            tenant_id: tenantId,
            key: DEFAULT_POINT_TYPE,
            name: 'Points',
            singular: 'point',
            plural: 'points',
            is_default: true,
            convertible: true,
            transferable: true,
            display_order: 0,
            enabled: true,
          },
        ];

  cache.set(tenantId, { types, at: Date.now() });
  return types;
}

export async function defaultPointType(
  tenantId: string,
  runner: Queryable = db(),
): Promise<PointType> {
  const types = await listPointTypes(tenantId, runner);
  return types.find((type) => type.is_default) ?? types[0]!;
}

/**
 * Resolve a caller-supplied type key.
 *
 * An unknown key is an error rather than a silent fall back to the default:
 * quietly awarding the wrong currency is worse than refusing, because nobody
 * notices until a status board has spendable points on it.
 */
export async function resolvePointType(
  tenantId: string,
  key: string | null | undefined,
  runner: Queryable = db(),
): Promise<PointType> {
  if (!key) return defaultPointType(tenantId, runner);

  let types = await listPointTypes(tenantId, runner);
  let found = types.find((type) => type.key === key);

  // The cache is per process. A currency created a moment ago on one worker is
  // unknown to the others for up to a minute, and an unknown key throws — so a
  // retailer who creates "status" and immediately awards it would see a
  // rejection from whichever worker happened to take the request. One forced
  // re-read before refusing costs a query on a path that was going to fail
  // anyway.
  if (!found && cache.has(tenantId)) {
    types = await listPointTypes(tenantId, runner, true);
    found = types.find((type) => type.key === key);
  }

  if (!found) {
    throw ApiError.badRequest(
      `Unknown point type "${key}". Known: ${types.map((type) => type.key).join(', ')}`,
    );
  }
  if (!found.enabled) {
    throw ApiError.unprocessable(`The "${found.name}" currency is turned off`);
  }
  return found;
}

/** Throws unless this currency may leave the platform. */
export async function assertConvertible(
  tenantId: string,
  key: string | null | undefined,
  runner: Queryable = db(),
): Promise<PointType> {
  const type = await resolvePointType(tenantId, key, runner);
  if (!type.convertible) {
    throw ApiError.unprocessable(
      `${type.name} cannot be exchanged for store credit or tokens`,
      { point_type: type.key },
    );
  }
  return type;
}

/** Throws unless this currency may be sent between members. */
export async function assertTransferable(
  tenantId: string,
  key: string | null | undefined,
  runner: Queryable = db(),
): Promise<PointType> {
  const type = await resolvePointType(tenantId, key, runner);
  if (!type.transferable) {
    throw ApiError.unprocessable(`${type.name} cannot be sent to another member`, {
      point_type: type.key,
    });
  }
  return type;
}

export async function upsertPointType(
  tenantId: string,
  input: {
    key: string;
    name?: string;
    singular?: string;
    plural?: string;
    isDefault?: boolean;
    convertible?: boolean;
    transferable?: boolean;
    displayOrder?: number;
    enabled?: boolean;
  },
  runner: Queryable = db(),
): Promise<PointType> {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(key)) {
    throw ApiError.badRequest('A point type key is 2-32 chars of a-z, 0-9 or underscore');
  }

  // Clearing the old default first: the unique index would otherwise reject
  // the write with a constraint error rather than a useful message.
  if (input.isDefault) {
    await runner.query(
      'UPDATE point_types SET is_default = false, updated_at = now() WHERE tenant_id = $1 AND key <> $2',
      [tenantId, key],
    );
  }

  const row = await queryOne<PointType>(
    runner,
    `INSERT INTO point_types (
       tenant_id, key, name, singular, plural, is_default, convertible,
       transferable, display_order, enabled
     ) VALUES (
       $1, $2, $3,
       COALESCE($4, 'point'), COALESCE($5, 'points'),
       COALESCE($6, false), COALESCE($7, false), COALESCE($8, false),
       COALESCE($9, 0), COALESCE($10, true)
     )
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, point_types.name),
       singular = COALESCE($4, point_types.singular),
       plural = COALESCE($5, point_types.plural),
       is_default = COALESCE($6, point_types.is_default),
       convertible = COALESCE($7, point_types.convertible),
       transferable = COALESCE($8, point_types.transferable),
       display_order = COALESCE($9, point_types.display_order),
       enabled = COALESCE($10, point_types.enabled),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      key,
      input.name ?? key,
      input.singular ?? null,
      input.plural ?? null,
      input.isDefault ?? null,
      input.convertible ?? null,
      input.transferable ?? null,
      input.displayOrder ?? null,
      input.enabled ?? null,
    ],
  );

  forgetPointTypes(tenantId);
  return row!;
}

/**
 * Remove a currency.
 *
 * Refused while any of it is still held. The ledger is append-only and a
 * balance is a claim on the retailer; deleting the currency it is denominated
 * in would leave rows nobody can read and members holding something that no
 * longer has a name.
 */
export async function deletePointType(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  if (key === DEFAULT_POINT_TYPE) {
    throw ApiError.unprocessable('The default currency cannot be removed');
  }

  const held = await queryOne<{ n: string }>(
    runner,
    `SELECT COUNT(*) AS n FROM points_balances
      WHERE tenant_id = $1 AND point_type = $2 AND (balance > 0 OR pending > 0)`,
    [tenantId, key],
  );
  if (Number(held?.n ?? 0) > 0) {
    throw ApiError.unprocessable(
      `${held!.n} members still hold that currency. Zero the balances first.`,
      { holders: Number(held!.n) },
    );
  }

  const { rowCount } = await runner.query(
    'DELETE FROM point_types WHERE tenant_id = $1 AND key = $2 AND NOT is_default',
    [tenantId, key],
  );
  forgetPointTypes(tenantId);
  return (rowCount ?? 0) > 0;
}

/** Install the default currency for a new retailer. */
export async function installDefaultPointType(
  tenantId: string,
  runner: Queryable = db(),
): Promise<void> {
  await runner.query(
    `INSERT INTO point_types (tenant_id, key, name, is_default, convertible, transferable)
     VALUES ($1, $2, 'Points', true, true, true)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [tenantId, DEFAULT_POINT_TYPE],
  );
  forgetPointTypes(tenantId);
}
