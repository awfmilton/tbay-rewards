import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { limitOf, offsetOf } from '../lib/paging.js';
import { compileGroup, type CustomFields, type FilterGroup } from './segment-filters.js';
import { listFields } from './contact-fields.js';
import { tenantTimezone } from './rewards.js';

/**
 * Reports a retailer composes, rather than the ones we thought of.
 *
 * "Revenue by campaign, monthly, for the last year." "Points issued per rule
 * since we changed the rates." Nobody can enumerate those in advance, and
 * today they are answered by somebody writing SQL against production, or not
 * at all.
 *
 * The definition is the retailer's; the shape of it is not. A report names a
 * source, some dimensions and some measures, each looked up in a fixed
 * catalogue — the same discipline the segment filter compiler is built on, for
 * the same reason. "Let admins pick any column" is how a reporting screen
 * becomes an arbitrary-read primitive over the whole schema, including other
 * tenants' rows, pii salts and key hashes.
 */

interface Dimension {
  /** SQL yielding the grouping value, in terms of the source's aliases. */
  sql: string;
  label: string;
  /** Whether the value is a date bucket, which sorts chronologically. */
  temporal?: boolean;
}

interface Measure {
  sql: string;
  label: string;
  format?: 'money' | 'number';
}

interface Source {
  label: string;
  /** The FROM clause, with its aliases. */
  from: string;
  /** Where the tenant predicate goes. */
  tenantColumn: string;
  /** What a date range filters on. */
  dateColumn: string;
  dimensions: Record<string, Dimension>;
  measures: Record<string, Measure>;
  /**
   * Whether a contact segment filter can be applied.
   *
   * Only where the source joins `contacts c` — the filter compiler writes SQL
   * in terms of that alias, so offering it anywhere else would produce a query
   * that does not run.
   */
  segmentable?: boolean;
}

/**
 * Date buckets, shared by every source.
 *
 * In the tenant's timezone, because a "day" that rolls over at 20:00 local is
 * a daily report nobody can reconcile against their till.
 */
function dateBuckets(column: string): Record<string, Dimension> {
  const bucket = (unit: string) =>
    `to_char(date_trunc('${unit}', ${column} AT TIME ZONE $TZ), '${
      unit === 'month' ? 'YYYY-MM' : unit === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM-DD'
    }')`;
  return {
    day: { sql: bucket('day'), label: 'Day', temporal: true },
    week: { sql: bucket('week'), label: 'Week', temporal: true },
    month: { sql: bucket('month'), label: 'Month', temporal: true },
  };
}

export const SOURCES: Record<string, Source> = {
  orders: {
    label: 'Orders',
    from: `orders o LEFT JOIN contacts c ON c.id = o.contact_id AND c.tenant_id = o.tenant_id`,
    tenantColumn: 'o.tenant_id',
    dateColumn: 'o.placed_at',
    segmentable: true,
    dimensions: {
      ...dateBuckets('o.placed_at'),
      status: { sql: 'o.status', label: 'Status' },
      currency: { sql: 'o.currency', label: 'Currency' },
      source: { sql: "coalesce(o.last_touch->>'source', '(direct)')", label: 'Source' },
      medium: { sql: "coalesce(o.last_touch->>'medium', '(none)')", label: 'Medium' },
      campaign: { sql: "coalesce(o.last_touch->>'campaign', '(none)')", label: 'Campaign' },
      first_touch_source: {
        sql: "coalesce(o.first_touch->>'source', '(direct)')",
        label: 'First-touch source',
      },
      link_code: { sql: "coalesce(o.attributed_link_code, '(none)')", label: 'Link' },
      country: { sql: "coalesce(c.country, '(unknown)')", label: 'Country' },
    },
    measures: {
      orders: { sql: 'COUNT(*)', label: 'Orders' },
      customers: { sql: 'COUNT(DISTINCT o.contact_id)', label: 'Customers' },
      revenue: { sql: 'COALESCE(SUM(o.total_cents), 0)', label: 'Revenue', format: 'money' },
      subtotal: { sql: 'COALESCE(SUM(o.subtotal_cents), 0)', label: 'Subtotal', format: 'money' },
      average_order: {
        sql: 'COALESCE(ROUND(AVG(o.total_cents)), 0)',
        label: 'Average order',
        format: 'money',
      },
    },
  },

  points: {
    label: 'Points',
    from: `points_ledger l LEFT JOIN contacts c ON c.id = l.contact_id AND c.tenant_id = l.tenant_id`,
    tenantColumn: 'l.tenant_id',
    dateColumn: 'l.created_at',
    segmentable: true,
    dimensions: {
      ...dateBuckets('l.created_at'),
      point_type: { sql: 'l.point_type', label: 'Currency' },
      rule_key: { sql: "coalesce(l.rule_key, '(none)')", label: 'Rule' },
      ref_type: { sql: "coalesce(l.ref_type, '(none)')", label: 'Kind' },
      status: { sql: 'l.status', label: 'Status' },
      direction: {
        sql: `CASE WHEN l.delta_points >= 0 THEN 'earned' ELSE 'spent' END`,
        label: 'Direction',
      },
    },
    measures: {
      entries: { sql: 'COUNT(*)', label: 'Entries' },
      members: { sql: 'COUNT(DISTINCT l.contact_id)', label: 'Members' },
      net: { sql: 'COALESCE(SUM(l.delta_points), 0)', label: 'Net points' },
      issued: {
        sql: 'COALESCE(SUM(CASE WHEN l.delta_points > 0 THEN l.delta_points ELSE 0 END), 0)',
        label: 'Points issued',
      },
      spent: {
        sql: 'COALESCE(SUM(CASE WHEN l.delta_points < 0 THEN -l.delta_points ELSE 0 END), 0)',
        label: 'Points spent',
      },
    },
  },

  commissions: {
    label: 'Writer commissions',
    from: `commissions cm LEFT JOIN contacts c ON c.id = cm.owner_contact_id AND c.tenant_id = cm.tenant_id`,
    tenantColumn: 'cm.tenant_id',
    dateColumn: 'cm.created_at',
    segmentable: true,
    dimensions: {
      ...dateBuckets('cm.created_at'),
      status: { sql: 'cm.status', label: 'Status' },
      writer: { sql: "coalesce(c.name, c.email, '(unknown)')", label: 'Writer' },
      product_ref: { sql: "coalesce(cm.product_ref, '(none)')", label: 'Product' },
      currency: { sql: 'cm.currency', label: 'Currency' },
    },
    measures: {
      commissions: { sql: 'COUNT(*)', label: 'Commissions' },
      writers: { sql: 'COUNT(DISTINCT cm.owner_contact_id)', label: 'Writers' },
      earned: { sql: 'COALESCE(SUM(cm.amount_cents), 0)', label: 'Commission', format: 'money' },
      attributed: {
        sql: 'COALESCE(SUM(cm.subtotal_cents), 0)',
        label: 'Attributed sales',
        format: 'money',
      },
    },
  },

  email: {
    label: 'Email',
    from: `email_messages m LEFT JOIN contacts c ON c.id = m.contact_id AND c.tenant_id = m.tenant_id`,
    tenantColumn: 'm.tenant_id',
    dateColumn: 'm.created_at',
    segmentable: true,
    dimensions: {
      ...dateBuckets('m.created_at'),
      template_key: { sql: "coalesce(m.template_key, '(none)')", label: 'Template' },
      status: { sql: 'm.status', label: 'Status' },
      bounce_type: { sql: "coalesce(m.bounce_type, '(none)')", label: 'Bounce' },
    },
    measures: {
      messages: { sql: 'COUNT(*)', label: 'Messages' },
      sent: { sql: `COUNT(*) FILTER (WHERE m.status = 'sent')`, label: 'Sent' },
      opened: { sql: 'COUNT(*) FILTER (WHERE m.opened_at IS NOT NULL)', label: 'Opened' },
      clicked: { sql: 'COUNT(*) FILTER (WHERE m.first_clicked_at IS NOT NULL)', label: 'Clicked' },
      bounced: { sql: 'COUNT(*) FILTER (WHERE m.bounce_type IS NOT NULL)', label: 'Bounced' },
    },
  },

  contacts: {
    label: 'Customers',
    from: 'contacts c',
    tenantColumn: 'c.tenant_id',
    dateColumn: 'c.created_at',
    segmentable: true,
    dimensions: {
      ...dateBuckets('c.created_at'),
      country: { sql: "coalesce(c.country, '(unknown)')", label: 'Country' },
      locale: { sql: "coalesce(c.locale, '(unknown)')", label: 'Language' },
      consent: {
        sql: `CASE WHEN c.marketing_consent THEN 'opted in' ELSE 'not opted in' END`,
        label: 'Marketing consent',
      },
      is_writer: {
        sql: `CASE WHEN c.is_writer THEN 'writer' ELSE 'customer' END`,
        label: 'Writer',
      },
    },
    measures: {
      contacts: { sql: 'COUNT(*)', label: 'Customers' },
      with_orders: {
        sql: `COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM orders o2 WHERE o2.contact_id = c.id AND o2.status <> 'refunded'))`,
        label: 'With an order',
      },
    },
  },
};

export interface ReportDefinition {
  source: string;
  dimensions: string[];
  measures: string[];
  /** A contact segment, compiled by the existing filter compiler. */
  filters?: FilterGroup;
  /** Rolling window in days; `range: null` means everything. */
  days?: number | null;
  /** A measure or dimension key to order by, descending unless `sortAsc`. */
  sort?: string | null;
  sortAsc?: boolean;
  limit?: number;
}

export function describeSources(): Array<Record<string, unknown>> {
  return Object.entries(SOURCES).map(([key, source]) => ({
    key,
    label: source.label,
    segmentable: source.segmentable ?? false,
    dimensions: Object.entries(source.dimensions).map(([id, dimension]) => ({
      key: id,
      label: dimension.label,
      temporal: dimension.temporal ?? false,
    })),
    measures: Object.entries(source.measures).map(([id, measure]) => ({
      key: id,
      label: measure.label,
      format: measure.format ?? 'number',
    })),
  }));
}

const MAX_DIMENSIONS = 4;
const MAX_MEASURES = 8;

/**
 * Check a definition against the catalogue.
 *
 * Called on save as well as on run, so a broken report is rejected while an
 * admin is looking at the form rather than three weeks later when its schedule
 * fires at 6am and nobody is watching.
 */
export function validateDefinition(definition: ReportDefinition): {
  source: Source;
  dimensions: Array<[string, Dimension]>;
  measures: Array<[string, Measure]>;
} {
  // `Object.hasOwn`, never a truthiness check: `SOURCES['constructor']` returns
  // an inherited value, so a plain lookup passes and the next line reads
  // `.dimensions` off a function.
  const sourceKey = String(definition.source ?? '');
  if (!Object.hasOwn(SOURCES, sourceKey)) {
    throw ApiError.badRequest(`Unknown report source "${sourceKey}"`);
  }
  const source = SOURCES[sourceKey]!;

  const dimensionKeys = definition.dimensions ?? [];
  const measureKeys = definition.measures ?? [];

  if (dimensionKeys.length > MAX_DIMENSIONS) {
    throw ApiError.badRequest(`A report may group by at most ${MAX_DIMENSIONS} things`);
  }
  if (measureKeys.length === 0) {
    throw ApiError.badRequest('A report needs at least one measure');
  }
  if (measureKeys.length > MAX_MEASURES) {
    throw ApiError.badRequest(`A report may show at most ${MAX_MEASURES} measures`);
  }

  const dimensions = dimensionKeys.map((key): [string, Dimension] => {
    const name = String(key);
    if (!Object.hasOwn(source.dimensions, name)) {
      throw ApiError.badRequest(`"${name}" is not something ${source.label} can be grouped by`);
    }
    return [name, source.dimensions[name]!];
  });

  const measures = measureKeys.map((key): [string, Measure] => {
    const name = String(key);
    if (!Object.hasOwn(source.measures, name)) {
      throw ApiError.badRequest(`"${name}" is not something ${source.label} can measure`);
    }
    return [name, source.measures[name]!];
  });

  if (definition.filters && !source.segmentable) {
    throw ApiError.badRequest(`${source.label} cannot be filtered by customer`);
  }

  if (definition.sort) {
    const sort = String(definition.sort);
    const known =
      measureKeys.map(String).includes(sort) || dimensionKeys.map(String).includes(sort);
    if (!known) {
      throw ApiError.badRequest(`Cannot sort by "${sort}": it is not in the report`);
    }
  }

  return { source, dimensions, measures };
}

export interface ReportResult {
  source: string;
  columns: Array<{ key: string; label: string; kind: 'dimension' | 'measure'; format?: string }>;
  rows: Array<Record<string, string | number>>;
  /** The window actually used, so a CSV can say what it covers. */
  from: string | null;
  to: string;
  truncated: boolean;
}

const MAX_ROWS = 50_000;

export async function runReport(
  tenantId: string,
  definition: ReportDefinition,
  runner: Queryable = db(),
): Promise<ReportResult> {
  const { source, dimensions, measures } = validateDefinition(definition);

  const params: unknown[] = [tenantId];
  const timezone = await tenantTimezone(tenantId, runner);

  // Bound only when a date bucket actually uses it. Postgres cannot infer a
  // type for a parameter that appears nowhere in the statement, and refuses
  // the whole query with "could not determine data type of parameter $2" — so
  // a report with no temporal dimension would fail on the parameter it never
  // needed.
  const needsTimezone = dimensions.some(([, dimension]) => dimension.sql.includes('$TZ'));
  let tzParam = '';
  if (needsTimezone) {
    params.push(timezone);
    // `::text`, because `AT TIME ZONE` is overloaded on text and interval and
    // an untyped parameter matches neither.
    tzParam = `$${params.length}::text`;
  }

  const where: string[] = [`${source.tenantColumn} = $1`];

  const days = definition.days === undefined ? 90 : definition.days;
  let fromLabel: string | null = null;
  if (days !== null) {
    const clamped = Math.min(Math.max(Math.trunc(days), 1), 3650);
    params.push(String(clamped));
    where.push(`${source.dateColumn} >= now() - ($${params.length} || ' days')::interval`);
    fromLabel = new Date(Date.now() - clamped * 86_400_000).toISOString();
  }

  // The contact segment, compiled by the same thing that compiles a segment —
  // rather than a second filter language that would need auditing separately.
  if (definition.filters) {
    const custom: CustomFields = new Map(
      (await listFields(tenantId, runner)).map((field) => [field.key, field.kind]),
    );
    const compiled = compileGroup(
      definition.filters,
      timezone,
      params.length,
      0,
      undefined,
      custom,
    );
    where.push(`(${compiled.sql})`);
    params.push(...compiled.params);
  }

  // Every fragment below comes from the catalogue above; only the timezone and
  // the window are bound values, and they are bound.
  const selectDimensions = dimensions.map(
    ([key, dimension]) => `${dimension.sql.replace(/\$TZ/g, tzParam)} AS "${key}"`,
  );
  const selectMeasures = measures.map(([key, measure]) => `${measure.sql} AS "${key}"`);
  const groupBy = dimensions.map((_, index) => String(index + 1));

  const sortKey = definition.sort ? String(definition.sort) : measures[0]![0];
  const direction = definition.sortAsc ? 'ASC' : 'DESC';
  // A temporal dimension reads forwards: "January, February, March", not
  // whichever month had the most orders.
  const temporal = dimensions.find(([key]) => key === sortKey)?.[1]?.temporal;
  const orderBy = temporal ? `"${sortKey}" ASC` : `"${sortKey}" ${direction}`;

  const limit = limitOf(definition.limit, 500, MAX_ROWS);

  const sql = `
    SELECT ${[...selectDimensions, ...selectMeasures].join(', ')}
      FROM ${source.from}
     WHERE ${where.join(' AND ')}
     ${groupBy.length > 0 ? `GROUP BY ${groupBy.join(', ')}` : ''}
     ORDER BY ${orderBy}
     LIMIT ${limit + 1}`;

  const { rows } = await runner.query<Record<string, string | number>>(sql, params);
  const truncated = rows.length > limit;

  return {
    source: definition.source,
    columns: [
      ...dimensions.map(([key, dimension]) => ({
        key,
        label: dimension.label,
        kind: 'dimension' as const,
      })),
      ...measures.map(([key, measure]) => ({
        key,
        label: measure.label,
        kind: 'measure' as const,
        format: measure.format ?? 'number',
      })),
    ],
    rows: rows.slice(0, limit).map((row) => {
      // node-postgres returns COUNT and SUM as strings, because a bigint can
      // exceed what a double holds exactly. A report of "1247" rendered as
      // "1247" either way, but a caller doing arithmetic on it would be
      // concatenating.
      const out: Record<string, string | number> = {};
      for (const [key, value] of Object.entries(row)) {
        const isMeasure = measures.some(([name]) => name === key);
        out[key] = isMeasure && value !== null ? Number(value) : (value as string);
      }
      return out;
    }),
    from: fromLabel,
    to: new Date().toISOString(),
    truncated,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved reports
// ─────────────────────────────────────────────────────────────────────────────

export interface Report {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  description: string;
  definition: ReportDefinition;
}

export async function listReports(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Report[]> {
  const { rows } = await runner.query<Report>(
    'SELECT * FROM reports WHERE tenant_id = $1 ORDER BY name',
    [tenantId],
  );
  return rows;
}

export async function upsertReport(
  tenantId: string,
  input: { key: string; name?: string; description?: string; definition: ReportDefinition },
  runner: Queryable = db(),
): Promise<Report> {
  const key = String(input.key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,64}$/.test(key)) {
    throw ApiError.badRequest('A report key is 2-64 chars of a-z, 0-9 or underscore');
  }

  // Rejected here, not when the schedule fires.
  validateDefinition(input.definition);

  const row = await queryOne<Report>(
    runner,
    `INSERT INTO reports (tenant_id, key, name, description, definition)
     VALUES ($1, $2, $3, COALESCE($4, ''), $5::jsonb)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       name = COALESCE(EXCLUDED.name, reports.name),
       description = COALESCE($4, reports.description),
       definition = EXCLUDED.definition,
       updated_at = now()
     RETURNING *`,
    [tenantId, key, input.name ?? key, input.description ?? null, JSON.stringify(input.definition)],
  );
  return row!;
}

export async function deleteReport(
  tenantId: string,
  key: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    'DELETE FROM reports WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rowCount ?? 0) > 0;
}

/** A report's rows as a CSV, with a header explaining what it covers. */
export function toCsv(result: ReportResult): string {
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? '' : String(value);
    // Formula injection: a cell opening with =, +, - or @ executes when the
    // file is opened in Excel. Prefixed with an apostrophe, which every
    // spreadsheet reads as "this is text".
    const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
  };

  const lines = [result.columns.map((column) => cell(column.label)).join(',')];
  for (const row of result.rows) {
    lines.push(result.columns.map((column) => cell(row[column.key])).join(','));
  }
  return lines.join('\n');
}
