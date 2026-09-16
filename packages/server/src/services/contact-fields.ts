import { db, queryOne, withTransaction, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';

/**
 * Fields the retailer defines, not us.
 *
 * Segments filter over a fixed catalogue of platform fields. A flag store
 * wants to segment on "province"; a rewards programme on "membership tier".
 * Those are the retailer's data, and there was nowhere to put them that
 * anything could read back.
 */

export type FieldKind = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface ContactField {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
  options: string[];
  display_order: number;
}

/**
 * Which column a kind lands in.
 *
 * A module constant, so the column name in the SQL below is never derived from
 * anything a caller supplied — the same rule the segment filter compiler is
 * built around.
 */
const COLUMN: Record<FieldKind, 'text_value' | 'number_value' | 'date_value' | 'bool_value'> = {
  text: 'text_value',
  select: 'text_value',
  number: 'number_value',
  date: 'date_value',
  boolean: 'bool_value',
};

/** Every value column, so one can be set and the rest cleared. */
const VALUE_COLUMNS = ['text_value', 'number_value', 'date_value', 'bool_value'] as const;

export function columnFor(kind: FieldKind): string {
  return COLUMN[kind];
}

const cache = new Map<string, { fields: ContactField[]; at: number }>();
const TTL_MS = 60_000;

export function forgetContactFields(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function listFields(
  tenantId: string,
  runner: Queryable = db(),
  fresh = false,
): Promise<ContactField[]> {
  const hit = cache.get(tenantId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.fields;

  const { rows } = await runner.query<ContactField>(
    'SELECT * FROM contact_fields WHERE tenant_id = $1 ORDER BY display_order, label',
    [tenantId],
  );
  cache.set(tenantId, { fields: rows, at: Date.now() });
  return rows;
}

export async function getField(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<ContactField | null> {
  const fields = await listFields(tenantId, runner);
  const found = fields.find((field) => field.key === key);
  if (found) return found;

  // The cache is per process, so a field defined a moment ago on one worker is
  // unknown to the others for up to a minute. One forced re-read before saying
  // no costs a query on a path that was going to fail anyway.
  if (!cache.has(tenantId)) return null;
  const fresh = await listFields(tenantId, runner, true);
  return fresh.find((field) => field.key === key) ?? null;
}

export async function upsertField(
  tenantId: string,
  input: {
    key: string;
    label?: string;
    description?: string;
    kind?: FieldKind;
    options?: string[];
    displayOrder?: number;
  },
  runner: Queryable = db(),
): Promise<ContactField> {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(key)) {
    throw ApiError.badRequest('A field key is 2-40 chars of a-z, 0-9 or underscore');
  }

  const existing = await getField(tenantId, key, runner);
  const kind = input.kind ?? existing?.kind ?? 'text';
  if (!Object.hasOwn(COLUMN, kind)) {
    throw ApiError.badRequest(`"${String(kind)}" is not a field type`);
  }

  // Changing the type would leave every value written under the old one in a
  // column the new one never reads: a "tier" field switched from text to
  // number would silently read as empty for everybody. Refused rather than
  // migrated, because there is no correct automatic answer — "gold" is not a
  // number, and guessing one is worse than saying no.
  if (existing && input.kind && input.kind !== existing.kind) {
    const held = await queryOne<{ n: string }>(
      runner,
      'SELECT COUNT(*) AS n FROM contact_field_values WHERE tenant_id = $1 AND field_key = $2',
      [tenantId, key],
    );
    if (Number(held?.n ?? 0) > 0) {
      throw ApiError.unprocessable(
        `"${key}" already holds ${held!.n} values as a ${existing.kind} field. ` +
          'Delete it and create it again if the type is wrong.',
        { values: Number(held!.n), current_kind: existing.kind },
      );
    }
  }

  const options = (input.options ?? existing?.options ?? [])
    .map((option) => String(option).trim())
    .filter((option) => option !== '')
    .slice(0, 100);

  if (kind === 'select' && options.length === 0) {
    throw ApiError.badRequest('A list field needs at least one option');
  }

  const row = await queryOne<ContactField>(
    runner,
    `INSERT INTO contact_fields (tenant_id, key, label, description, kind, options, display_order)
     VALUES ($1, $2, $3, COALESCE($4, ''), $5, $6::text[], COALESCE($7, 0))
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       label = COALESCE(EXCLUDED.label, contact_fields.label),
       description = COALESCE($4, contact_fields.description),
       kind = EXCLUDED.kind,
       options = EXCLUDED.options,
       display_order = COALESCE($7, contact_fields.display_order),
       updated_at = now()
     RETURNING *`,
    [
      tenantId,
      key,
      input.label ?? existing?.label ?? key,
      input.description ?? null,
      kind,
      options,
      input.displayOrder ?? null,
    ],
  );

  forgetContactFields(tenantId);
  return row!;
}

export async function deleteField(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  // The values go with it. A stored value for a field that no longer exists is
  // unreadable — nothing knows its type — and a key reused later would inherit
  // it.
  await runner.query(
    'DELETE FROM contact_field_values WHERE tenant_id = $1 AND field_key = $2',
    [tenantId, key],
  );
  const { rowCount } = await runner.query(
    'DELETE FROM contact_fields WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  forgetContactFields(tenantId);
  return (rowCount ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce and validate one value against its field.
 *
 * Here rather than at read time, and that is the whole design. A value stored
 * as text and cast when a segment reads it means one contact whose "spend" is
 * "lots" raises in the middle of an audience build — a 500 from a screen that
 * did nothing wrong, hours after the bad value was written. Failing here makes
 * it a 400 to whoever wrote it, naming the field.
 */
export function coerce(
  field: ContactField,
  value: unknown,
): { column: string; value: string | number | Date | boolean | null } {
  const column = columnFor(field.kind);
  if (value === null || value === undefined || value === '') {
    return { column, value: null };
  }

  switch (field.kind) {
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(n)) {
        throw ApiError.badRequest(`"${field.label}" takes a number`);
      }
      return { column, value: n };
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(d.getTime())) {
        throw ApiError.badRequest(`"${field.label}" takes a date`);
      }
      return { column, value: d };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { column, value };
      const text = String(value).trim().toLowerCase();
      if (['true', 'yes', '1', 'on'].includes(text)) return { column, value: true };
      if (['false', 'no', '0', 'off'].includes(text)) return { column, value: false };
      throw ApiError.badRequest(`"${field.label}" takes yes or no`);
    }
    case 'select': {
      const text = String(value).trim();
      // Case-insensitively, because a retailer typing "Ontario" into an import
      // meant the "ontario" option — but stored as the option's own spelling,
      // so a segment on it matches one thing rather than four.
      const match = field.options.find(
        (option) => option.toLowerCase() === text.toLowerCase(),
      );
      if (!match) {
        throw ApiError.badRequest(
          `"${text}" is not one of the choices for "${field.label}"`,
          { options: field.options },
        );
      }
      return { column, value: match };
    }
    default:
      return { column, value: String(value).slice(0, 2000) };
  }
}

export async function setFieldValues(
  tenantId: string,
  contactId: string,
  values: Record<string, unknown>,
  runner?: Queryable,
): Promise<Record<string, unknown>> {
  const run = async (client: Queryable): Promise<Record<string, unknown>> => {
    const fields = await listFields(tenantId, client);
    const byKey = new Map(fields.map((field) => [field.key, field]));

    for (const [key, raw] of Object.entries(values)) {
      const field = byKey.get(key);
      // Refused rather than ignored. A typo'd key that silently does nothing
      // is an integration that looks like it works and quietly holds no data.
      if (!field) {
        throw ApiError.badRequest(`"${key}" is not a field this store has defined`, {
          known: fields.map((one) => one.key),
        });
      }

      const { column, value } = coerce(field, raw);

      if (value === null) {
        await client.query(
          'DELETE FROM contact_field_values WHERE tenant_id = $1 AND contact_id = $2 AND field_key = $3',
          [tenantId, contactId, key],
        );
        continue;
      }

      // The other three are cleared, so a row whose field changed type before
      // anything was stored cannot keep a value in a column nothing reads.
      // Postgres refuses two assignments to one column, so the target is
      // excluded from the clearing list rather than set twice.
      const cleared = VALUE_COLUMNS.filter((name) => name !== column)
        .map((name) => `${name} = NULL`)
        .join(', ');

      // Every name here comes from the module constants above, never input.
      await client.query(
        `INSERT INTO contact_field_values (tenant_id, contact_id, field_key, ${column})
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, contact_id, field_key) DO UPDATE SET
           ${column} = EXCLUDED.${column},
           ${cleared},
           updated_at = now()`,
        [tenantId, contactId, key, value],
      );
    }

    return getFieldValues(tenantId, contactId, client);
  };

  return runner ? run(runner) : withTransaction(run);
}

export async function getFieldValues(
  tenantId: string,
  contactId: string,
  runner: Queryable = db(),
): Promise<Record<string, unknown>> {
  const fields = await listFields(tenantId, runner);
  const { rows } = await runner.query<{
    field_key: string;
    text_value: string | null;
    number_value: string | null;
    date_value: Date | null;
    bool_value: boolean | null;
  }>(
    'SELECT * FROM contact_field_values WHERE tenant_id = $1 AND contact_id = $2',
    [tenantId, contactId],
  );

  const held = new Map(rows.map((row) => [row.field_key, row]));
  const out: Record<string, unknown> = {};

  // Every defined field appears, set or not. A screen rendering "province: —"
  // is clearer than one where the row vanishes when nobody has filled it in.
  for (const field of fields) {
    const row = held.get(field.key);
    if (!row) {
      out[field.key] = null;
      continue;
    }
    switch (field.kind) {
      case 'number':
        // numeric comes back as a string from node-postgres, because a numeric
        // can exceed what a double holds exactly.
        out[field.key] = row.number_value === null ? null : Number(row.number_value);
        break;
      case 'date':
        out[field.key] = row.date_value;
        break;
      case 'boolean':
        out[field.key] = row.bool_value;
        break;
      default:
        out[field.key] = row.text_value;
    }
  }

  return out;
}
