import { ApiError } from '../lib/errors.js';

/**
 * Compiling a saved filter tree into SQL.
 *
 * The one rule this file exists to enforce: **no value from a definition ever
 * reaches the SQL string**. Field names are looked up in a fixed table,
 * operators are looked up in a fixed table, and every value becomes a bound
 * parameter. A segment definition is admin-supplied data that gets stored and
 * replayed later, so treating it as trusted would be a stored SQL injection
 * with a delay fuse.
 *
 * Dates are resolved in the *tenant's* timezone. "Ordered in the last 30 days"
 * meaning something different depending on where the database happens to run
 * is the kind of bug nobody reports and everybody notices.
 */

export type MatchMode = 'all' | 'any';

export type Operator =
  | 'eq' | 'ne'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'in' | 'not_in'
  | 'is_set' | 'is_not_set'
  | 'in_last_days' | 'not_in_last_days'
  | 'before' | 'after';

export interface Filter {
  field: string;
  operator: Operator;
  value?: unknown;
}

export interface FilterGroup {
  match: MatchMode;
  filters?: Filter[];
  groups?: FilterGroup[];
}

type FieldKind = 'text' | 'number' | 'boolean' | 'date' | 'text_array' | 'json';

interface FieldDef {
  kind: FieldKind;
  /**
   * SQL that yields the value for the contact aliased `c`.
   *
   * A correlated subquery rather than a join: the compiler has no way to know
   * what other filters will be present, and a join per filter would multiply
   * rows and silently break counts.
   */
  sql: string;
  label: string;
}

/**
 * Every field a segment may filter on.
 *
 * A closed list, deliberately. "Let admins filter on any column" is how a
 * settings screen becomes an arbitrary-read primitive over the whole schema —
 * including other tenants' rows, pii salts and key hashes.
 */
export const FIELDS: Record<string, FieldDef> = {
  email:            { kind: 'text',   sql: 'c.email',              label: 'Email' },
  name:             { kind: 'text',   sql: 'c.name',               label: 'Name' },
  country:          { kind: 'text',   sql: 'c.country',            label: 'Country' },
  locale:           { kind: 'text',   sql: 'c.locale',             label: 'Language' },
  tags:             { kind: 'text_array', sql: 'c.tags',           label: 'Tags' },
  marketing_consent:{ kind: 'boolean',sql: 'c.marketing_consent',  label: 'Marketing consent' },
  is_writer:        { kind: 'boolean',sql: 'c.is_writer',          label: 'Is a writer' },
  wallet_address:   { kind: 'text',   sql: 'c.wallet_address',     label: 'Wallet address' },
  created_at:       { kind: 'date',   sql: 'c.created_at',         label: 'First seen' },
  last_seen_at:     { kind: 'date',   sql: 'c.last_seen_at',       label: 'Last seen' },
  consent_at:       { kind: 'date',   sql: 'c.consent_at',         label: 'Consented' },

  points_balance: {
    kind: 'number',
    sql: `(SELECT COALESCE(b.balance, 0) FROM points_balances b
            WHERE b.tenant_id = c.tenant_id AND b.contact_id = c.id)`,
    label: 'Points balance',
  },
  lifetime_points: {
    kind: 'number',
    sql: `(SELECT COALESCE(b.lifetime_earned, 0) FROM points_balances b
            WHERE b.tenant_id = c.tenant_id AND b.contact_id = c.id)`,
    label: 'Points earned, all time',
  },
  rank_key: {
    kind: 'text',
    sql: `(SELECT r.key FROM points_balances b JOIN ranks r ON r.id = b.current_rank_id
            WHERE b.tenant_id = c.tenant_id AND b.contact_id = c.id)`,
    label: 'Rank',
  },
  order_count: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM orders o
            WHERE o.contact_id = c.id AND o.status <> 'refunded')`,
    label: 'Number of orders',
  },
  total_spent_cents: {
    kind: 'number',
    sql: `(SELECT COALESCE(SUM(o.total_cents), 0) FROM orders o
            WHERE o.contact_id = c.id AND o.status <> 'refunded')`,
    label: 'Total spent',
  },
  last_order_at: {
    kind: 'date',
    sql: `(SELECT MAX(o.placed_at) FROM orders o
            WHERE o.contact_id = c.id AND o.status <> 'refunded')`,
    label: 'Last order',
  },
  last_opened_email_at: {
    kind: 'date',
    sql: `(SELECT MAX(m.opened_at) FROM email_messages m WHERE m.contact_id = c.id)`,
    label: 'Last opened an email',
  },
  last_clicked_email_at: {
    kind: 'date',
    sql: `(SELECT MAX(m.first_clicked_at) FROM email_messages m WHERE m.contact_id = c.id)`,
    label: 'Last clicked an email',
  },
  emails_sent: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM email_messages m
            WHERE m.contact_id = c.id AND m.status = 'sent')`,
    label: 'Emails received',
  },
  session_count: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM sessions s
            JOIN visitors v ON v.id = s.visitor_id
           WHERE v.contact_id = c.id)`,
    label: 'Visits',
  },
  badge_count: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM badge_awards a WHERE a.contact_id = c.id)`,
    label: 'Badges earned',
  },
  referral_count: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM referrals r
            WHERE r.referrer_contact_id = c.id AND r.status = 'qualified')`,
    label: 'Referrals',
  },
  abandoned_cart_count: {
    kind: 'number',
    sql: `(SELECT COUNT(*) FROM carts ct
            WHERE ct.contact_id = c.id AND ct.status = 'abandoned')`,
    label: 'Abandoned carts',
  },
  is_suppressed: {
    kind: 'boolean',
    sql: `EXISTS (SELECT 1 FROM email_suppressions s
                   WHERE s.tenant_id = c.tenant_id
                     AND s.email = lower(coalesce(c.email_normalised, c.email, '')))`,
    label: 'Email suppressed',
  },
};

/** Which operators each kind of field allows. */
const ALLOWED: Record<FieldKind, Operator[]> = {
  text: ['eq', 'ne', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_set', 'is_not_set'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'is_set', 'is_not_set'],
  boolean: ['eq', 'ne'],
  date: ['in_last_days', 'not_in_last_days', 'before', 'after', 'is_set', 'is_not_set'],
  text_array: ['contains', 'not_contains', 'in', 'not_in', 'is_set', 'is_not_set'],
  json: ['eq', 'ne', 'contains', 'is_set', 'is_not_set'],
};

export interface CompiledFilter {
  sql: string;
  params: unknown[];
}

const MAX_DEPTH = 4;
const MAX_FILTERS = 50;

/**
 * Total filters in one definition, across every nested group.
 *
 * The per-group limit alone allowed tens of thousands once nested, and every
 * filter is a correlated subquery re-evaluated over the whole contacts table
 * on each rebuild — a cost that lands on the database every tenant shares.
 */
const MAX_TOTAL_FILTERS = 200;

/**
 * Compile a filter group into a WHERE fragment for a query aliased `c`.
 *
 * `startIndex` is the number of parameters the caller has already bound, so
 * the fragment can be spliced into a larger query.
 */
export function compileGroup(
  group: FilterGroup,
  timezone: string,
  startIndex = 0,
  depth = 0,
  budget: { remaining: number } = { remaining: MAX_TOTAL_FILTERS },
): CompiledFilter {
  if (depth > MAX_DEPTH) {
    throw ApiError.badRequest(`Segment filters may not nest more than ${MAX_DEPTH} deep`);
  }

  const match = group.match === 'any' ? 'OR' : 'AND';
  const params: unknown[] = [];
  const parts: string[] = [];
  let index = startIndex;

  const filters = group.filters ?? [];
  const groups = group.groups ?? [];

  if (filters.length + groups.length > MAX_FILTERS) {
    throw ApiError.badRequest(`A filter group may hold at most ${MAX_FILTERS} entries`);
  }

  budget.remaining -= filters.length;
  if (budget.remaining < 0) {
    throw ApiError.badRequest(
      `A segment may hold at most ${MAX_TOTAL_FILTERS} filters in total`,
    );
  }

  for (const filter of filters) {
    const compiled = compileFilter(filter, timezone, index);
    parts.push(compiled.sql);
    params.push(...compiled.params);
    index += compiled.params.length;
  }

  for (const nested of groups) {
    const compiled = compileGroup(nested, timezone, index, depth + 1, budget);
    parts.push(`(${compiled.sql})`);
    params.push(...compiled.params);
    index += compiled.params.length;
  }

  // An empty group matches everyone rather than nobody. A segment saved with
  // no filters yet is "all contacts", which is what an admin means by it; the
  // alternative silently sends to zero people and looks like a broken send.
  if (parts.length === 0) return { sql: 'TRUE', params: [] };

  return { sql: parts.join(` ${match} `), params };
}

function compileFilter(filter: Filter, timezone: string, startIndex: number): CompiledFilter {
  // `Object.hasOwn`, not a truthiness check: `FIELDS['__proto__']`,
  // `['constructor']` and `['toString']` all return inherited values, so a
  // plain lookup passes and then `field.kind` is undefined — a TypeError and a
  // 500 out of the one function whose whole job is rejecting bad definitions
  // with a 400.
  const field = Object.hasOwn(FIELDS, filter.field) ? FIELDS[filter.field] : undefined;
  if (!field) {
    throw ApiError.badRequest(`Unknown segment field "${String(filter.field)}"`);
  }

  const operator = filter.operator;
  if (!ALLOWED[field.kind].includes(operator)) {
    throw ApiError.badRequest(
      `Operator "${String(operator)}" cannot be used on ${field.label}`,
    );
  }

  const column = field.sql;
  const p = (offset = 0) => `$${startIndex + 1 + offset}`;

  switch (operator) {
    case 'is_set':
      return {
        sql: field.kind === 'text_array'
          ? `COALESCE(array_length(${column}, 1), 0) > 0`
          : `${column} IS NOT NULL`,
        params: [],
      };
    case 'is_not_set':
      return {
        sql: field.kind === 'text_array'
          ? `COALESCE(array_length(${column}, 1), 0) = 0`
          : `${column} IS NULL`,
        params: [],
      };
  }

  if (field.kind === 'text_array') {
    const values = asStringList(filter.value);
    switch (operator) {
      case 'contains':
      case 'in':
        // Overlap, so "in [vip, gold]" means "has either", which is what the
        // UI's multi-select reads as.
        return { sql: `${column} && ${p()}::text[]`, params: [values] };
      case 'not_contains':
      case 'not_in':
        return { sql: `NOT (${column} && ${p()}::text[])`, params: [values] };
    }
  }

  if (field.kind === 'date') {
    switch (operator) {
      case 'in_last_days':
        return {
          sql: `${column} >= (date_trunc('day', now() AT TIME ZONE ${p(1)})
                              AT TIME ZONE ${p(1)}) - (${p()} || ' days')::interval`,
          params: [String(asPositiveInt(filter.value)), timezone],
        };
      case 'not_in_last_days':
        // NULL means "never", which must count as "not in the last N days".
        return {
          sql: `(${column} IS NULL OR ${column} < (date_trunc('day', now() AT TIME ZONE ${p(1)})
                              AT TIME ZONE ${p(1)}) - (${p()} || ' days')::interval)`,
          params: [String(asPositiveInt(filter.value)), timezone],
        };
      case 'before':
        return { sql: `${column} < ${p()}::timestamptz`, params: [asDate(filter.value)] };
      case 'after':
        return { sql: `${column} > ${p()}::timestamptz`, params: [asDate(filter.value)] };
    }
  }

  if (field.kind === 'boolean') {
    const value = Boolean(filter.value);
    return {
      sql: operator === 'eq' ? `${column} IS ${value ? 'TRUE' : 'NOT TRUE'}`
                             : `${column} IS ${value ? 'NOT TRUE' : 'TRUE'}`,
      params: [],
    };
  }

  if (field.kind === 'number') {
    const value = asNumber(filter.value);
    const sqlOp = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[
      operator as 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
    ];
    // COALESCE so "balance < 100" includes people with no balance row, which
    // is what "fewer than 100 points" means to the person asking.
    return { sql: `COALESCE(${column}, 0) ${sqlOp} ${p()}`, params: [value] };
  }

  // text
  switch (operator) {
    case 'eq':
      return { sql: `lower(${column}) = lower(${p()})`, params: [asString(filter.value)] };
    case 'ne':
      return {
        // NULL is not equal to anything, so a plain <> would drop contacts who
        // have no value at all — rarely what "is not X" is meant to say.
        sql: `(${column} IS NULL OR lower(${column}) <> lower(${p()}))`,
        params: [asString(filter.value)],
      };
    case 'contains':
      return { sql: `${column} ILIKE ${p()}`, params: [`%${escapeLike(asString(filter.value))}%`] };
    case 'not_contains':
      return {
        sql: `(${column} IS NULL OR ${column} NOT ILIKE ${p()})`,
        params: [`%${escapeLike(asString(filter.value))}%`],
      };
    case 'starts_with':
      return { sql: `${column} ILIKE ${p()}`, params: [`${escapeLike(asString(filter.value))}%`] };
    case 'ends_with':
      return { sql: `${column} ILIKE ${p()}`, params: [`%${escapeLike(asString(filter.value))}`] };
    case 'in':
      return { sql: `lower(${column}) = ANY(${p()}::text[])`, params: [asStringList(filter.value).map((v) => v.toLowerCase())] };
    case 'not_in':
      return {
        sql: `(${column} IS NULL OR NOT (lower(${column}) = ANY(${p()}::text[])))`,
        params: [asStringList(filter.value).map((v) => v.toLowerCase())],
      };
  }

  throw ApiError.badRequest(`Operator "${String(operator)}" is not supported`);
}

/**
 * `_` and `%` are wildcards in LIKE.
 *
 * Without this, searching for `a_b` matches `axb`, and a value of `%` matches
 * everyone — which turns "contains" into "send to the whole list".
 */
function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw ApiError.badRequest('That filter needs a text value');
}

function asStringList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 || list.length > 100) {
    throw ApiError.badRequest('A list filter needs between 1 and 100 values');
  }
  return list.map(asString);
}

function asNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw ApiError.badRequest('That filter needs a number');
  return parsed;
}

function asPositiveInt(value: unknown): number {
  const parsed = Math.trunc(asNumber(value));
  if (parsed < 0 || parsed > 36_500) {
    throw ApiError.badRequest('A day count must be between 0 and 36500');
  }
  return parsed;
}

function asDate(value: unknown): string {
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw ApiError.badRequest(`"${String(value)}" is not a date`);
  }
  return parsed.toISOString();
}

/** The field catalogue, for an admin UI to render a filter builder from. */
export function describeFields(): Array<{
  field: string;
  label: string;
  kind: FieldKind;
  operators: Operator[];
}> {
  return Object.entries(FIELDS).map(([field, def]) => ({
    field,
    label: def.label,
    kind: def.kind,
    operators: ALLOWED[def.kind],
  }));
}
