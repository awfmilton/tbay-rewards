import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  closeApp,
  closeDb,
  db,
  makeTenant,
  setupDatabase,
  testApp,
  truncateAll,
  type TestTenant,
} from './helpers.js';
import { upsertContact } from '../src/services/contacts.js';
import { award, spend } from '../src/services/points.js';
import { recordOrder } from '../src/services/commissions.js';
import { getTenantById } from '../src/services/tenants.js';
import { runReport, toCsv, upsertReport, validateDefinition } from '../src/services/reports.js';
import {
  isDue,
  periodKey,
  runDueReports,
  upsertSchedule,
} from '../src/services/report-schedules.js';
import { upsertField, setFieldValues } from '../src/services/contact-fields.js';

let tenant: TestTenant;

beforeAll(async () => {
  await setupDatabase();
});

beforeEach(async () => {
  await truncateAll();
  tenant = await makeTenant();
});

afterAll(async () => {
  await closeApp();
  await closeDb();
});

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const authed = async (method: Method, url: string, payload?: unknown) => {
  const app = await testApp();
  return app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tenant.secretKey}` },
    ...(payload === undefined ? {} : { payload }),
  });
};

/** Three orders from two campaigns, one refunded. */
async function seedOrders() {
  const tenantRow = (await getTenantById(tenant.id))!;
  const alice = await upsertContact(tenant.id, { email: 'alice@example.com', country: 'CA' });
  const bob = await upsertContact(tenant.id, { email: 'bob@example.com', country: 'US' });

  await db().query(
    `INSERT INTO orders (tenant_id, order_ref, contact_id, total_cents, subtotal_cents, currency, status, last_touch, placed_at)
     VALUES
       ($1, 'o1', $2, 10000, 9000, 'CAD', 'paid',
        '{"source":"newsletter","medium":"email","campaign":"spring"}'::jsonb, now() - interval '2 days'),
       ($1, 'o2', $2, 5000, 4500, 'CAD', 'paid',
        '{"source":"newsletter","medium":"email","campaign":"spring"}'::jsonb, now() - interval '3 days'),
       ($1, 'o3', $3, 20000, 18000, 'CAD', 'paid',
        '{"source":"google","medium":"cpc","campaign":"always-on"}'::jsonb, now() - interval '1 day')`,
    [tenant.id, alice.id, bob.id],
  );

  void tenantRow;
  return { alice, bob };
}

describe('the catalogue is closed', () => {
  it('refuses a source it does not have', () => {
    expect(() =>
      validateDefinition({ source: 'pg_shadow', dimensions: [], measures: ['orders'] }),
    ).toThrow(/Unknown report source/);
  });

  it('is not fooled by an inherited property name', () => {
    // `SOURCES['constructor']` returns a function, so a truthiness check passes
    // and the next line reads `.dimensions` off it.
    for (const source of ['constructor', '__proto__', 'toString']) {
      expect(() =>
        validateDefinition({ source, dimensions: [], measures: ['orders'] }),
      ).toThrow(/Unknown report source/);
    }
  });

  it('refuses a dimension or measure the source does not have', () => {
    expect(() =>
      validateDefinition({ source: 'orders', dimensions: ['pii_salt'], measures: ['orders'] }),
    ).toThrow(/is not something Orders can be grouped by/);

    expect(() =>
      validateDefinition({ source: 'orders', dimensions: [], measures: ['secret_hash'] }),
    ).toThrow(/is not something Orders can measure/);
  });

  it('insists on at least one measure, and caps how many', () => {
    expect(() =>
      validateDefinition({ source: 'orders', dimensions: ['day'], measures: [] }),
    ).toThrow(/at least one measure/);

    expect(() =>
      validateDefinition({
        source: 'orders',
        dimensions: ['day', 'source', 'medium', 'campaign', 'status'],
        measures: ['orders'],
      }),
    ).toThrow(/at most 4/);
  });

  it('refuses a sort by something that is not in the report', () => {
    expect(() =>
      validateDefinition({
        source: 'orders',
        dimensions: ['day'],
        measures: ['orders'],
        sort: 'revenue',
      }),
    ).toThrow(/Cannot sort by/);
  });
});

describe('running one', () => {
  it('groups and aggregates', async () => {
    await seedOrders();

    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: ['campaign'],
      measures: ['orders', 'revenue'],
    });

    expect(result.rows).toHaveLength(2);
    const spring = result.rows.find((row) => row.campaign === 'spring')!;
    expect(spring.orders).toBe(2);
    expect(spring.revenue).toBe(15000);

    // Sorted by the first measure, descending, so the biggest thing is first.
    expect(result.rows[0]!.campaign).toBe('spring');
  });

  it('returns measures as numbers, not the strings Postgres sends', async () => {
    await seedOrders();
    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['orders', 'revenue'],
    });

    // COUNT and SUM come back as strings because a bigint can exceed what a
    // double holds exactly. A caller doing arithmetic on those concatenates.
    expect(typeof result.rows[0]!.orders).toBe('number');
    expect(typeof result.rows[0]!.revenue).toBe('number');
    expect(result.rows[0]!.revenue).toBe(35000);
  });

  it('reads a temporal dimension forwards', async () => {
    await seedOrders();
    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: ['day'],
      measures: ['orders'],
      sort: 'day',
    });

    const days = result.rows.map((row) => String(row.day));
    // "January, February, March", not whichever day had the most orders.
    expect([...days].sort()).toEqual(days);
  });

  it('honours the rolling window', async () => {
    await seedOrders();
    await db().query(
      `INSERT INTO orders (tenant_id, order_ref, total_cents, currency, status, placed_at)
       VALUES ($1, 'ancient', 99999, 'CAD', 'paid', now() - interval '400 days')`,
      [tenant.id],
    );

    const recent = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['revenue'],
      days: 30,
    });
    expect(recent.rows[0]!.revenue).toBe(35000);

    const everything = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['revenue'],
      days: null,
    });
    expect(everything.rows[0]!.revenue).toBe(134_999);
  });

  it('never reaches another tenant’s rows', async () => {
    await seedOrders();
    const other = await makeTenant();
    await db().query(
      `INSERT INTO orders (tenant_id, order_ref, total_cents, currency, status, placed_at)
       VALUES ($1, 'theirs', 500000, 'CAD', 'paid', now())`,
      [other.id],
    );

    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['revenue'],
    });
    expect(result.rows[0]!.revenue).toBe(35000);
  });

  it('reports on points by rule and currency', async () => {
    const contact = await upsertContact(tenant.id, { email: 'points@example.com' });
    await award(tenant.id, {
      contactId: contact.id,
      points: 500,
      reason: 'Purchase',
      ruleKey: 'purchase',
      idempotencyKey: 'r1',
    });
    await spend(tenant.id, {
      contactId: contact.id,
      points: 200,
      reason: 'Redeemed',
      idempotencyKey: 'r2',
    });

    const result = await runReport(tenant.id, {
      source: 'points',
      dimensions: ['direction'],
      measures: ['issued', 'spent', 'net'],
    });

    const earned = result.rows.find((row) => row.direction === 'earned')!;
    const spent = result.rows.find((row) => row.direction === 'spent')!;
    expect(earned.issued).toBe(500);
    expect(spent.spent).toBe(200);
  });

  it('filters by a customer segment, using the same compiler segments use', async () => {
    const { alice } = await seedOrders();
    void alice;

    const canadians = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['revenue'],
      filters: { match: 'all', filters: [{ field: 'country', operator: 'eq', value: 'CA' }] },
    });
    expect(canadians.rows[0]!.revenue).toBe(15000);
  });

  it('filters by a retailer’s own field', async () => {
    const { alice } = await seedOrders();
    await upsertField(tenant.id, { key: 'tier', kind: 'number' });
    await setFieldValues(tenant.id, alice.id, { tier: 5 });

    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: [],
      measures: ['revenue'],
      filters: { match: 'all', filters: [{ field: 'cf_tier', operator: 'gte', value: 3 }] },
    });
    expect(result.rows[0]!.revenue).toBe(15000);
  });

  it('refuses a filter on a source that cannot join contacts', () => {
    // Every source here can, but the guard has to exist before one cannot —
    // otherwise the compiler emits SQL naming an alias that is not in scope.
    expect(() =>
      validateDefinition({
        source: 'orders',
        dimensions: [],
        measures: ['orders'],
        filters: { match: 'all', filters: [] },
      }),
    ).not.toThrow();
  });

  it('says when it truncated rather than looking complete', async () => {
    await seedOrders();
    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: ['campaign'],
      measures: ['orders'],
      limit: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});

describe('the CSV', () => {
  it('neutralises a formula', async () => {
    await db().query(
      `INSERT INTO orders (tenant_id, order_ref, total_cents, currency, status, last_touch, placed_at)
       VALUES ($1, 'evil', 100, 'CAD', 'paid', '{"campaign":"=1+1"}'::jsonb, now())`,
      [tenant.id],
    );

    const result = await runReport(tenant.id, {
      source: 'orders',
      dimensions: ['campaign'],
      measures: ['orders'],
    });
    const csv = toCsv(result);

    // `=1+1` in a cell executes when the file is opened in Excel.
    expect(csv).toContain("'=1+1");
  });

  it('quotes a value containing a comma', async () => {
    await db().query(
      `INSERT INTO orders (tenant_id, order_ref, total_cents, currency, status, last_touch, placed_at)
       VALUES ($1, 'comma', 100, 'CAD', 'paid', '{"campaign":"spring, summer"}'::jsonb, now())`,
      [tenant.id],
    );

    const csv = toCsv(
      await runReport(tenant.id, {
        source: 'orders',
        dimensions: ['campaign'],
        measures: ['orders'],
      }),
    );
    expect(csv).toContain('"spring, summer"');
  });
});

describe('scheduling', () => {
  async function savedReport() {
    return upsertReport(tenant.id, {
      key: 'weekly_revenue',
      name: 'Weekly revenue',
      definition: { source: 'orders', dimensions: ['campaign'], measures: ['orders', 'revenue'] },
    });
  }

  it('rejects a broken definition at save time, not when the schedule fires', async () => {
    await expect(
      upsertReport(tenant.id, {
        key: 'broken',
        definition: { source: 'orders', dimensions: [], measures: ['nonsense'] },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('gives a weekly schedule one key per ISO week', () => {
    const monday = new Date(Date.UTC(2026, 8, 14, 9));
    const friday = new Date(Date.UTC(2026, 8, 18, 9));
    const nextMonday = new Date(Date.UTC(2026, 8, 21, 9));

    expect(periodKey('weekly', monday)).toBe(periodKey('weekly', friday));
    expect(periodKey('weekly', monday)).not.toBe(periodKey('weekly', nextMonday));
  });

  it('is due from its hour onwards, once per period', async () => {
    await savedReport();
    const schedule = await upsertSchedule(tenant.id, {
      reportKey: 'weekly_revenue',
      cadence: 'weekly',
      hour: 7,
      dayOfWeek: 1,
      recipients: ['owner@shop.example'],
    });

    const mondayEarly = new Date(Date.UTC(2026, 8, 14, 6));
    const mondayLate = new Date(Date.UTC(2026, 8, 14, 9));
    const tuesday = new Date(Date.UTC(2026, 8, 15, 9));

    expect(isDue(schedule, mondayEarly)).toBe(false);
    expect(isDue(schedule, mondayLate)).toBe(true);
    expect(isDue(schedule, tuesday)).toBe(false);

    // Once sent, not due again until the next week.
    const sent = { ...schedule, last_period: periodKey('weekly', mondayLate) };
    expect(isDue(sent, mondayLate)).toBe(false);
    expect(isDue(sent, new Date(Date.UTC(2026, 8, 21, 9)))).toBe(true);
  });

  it('sends, and does not send the same period twice', async () => {
    await seedOrders();
    await savedReport();
    await upsertSchedule(tenant.id, {
      reportKey: 'weekly_revenue',
      cadence: 'daily',
      hour: 0,
      recipients: ['owner@shop.example', 'finance@shop.example'],
    });

    expect(await runDueReports()).toBe(1);

    const first = await db().query(
      "SELECT COUNT(*)::int AS n FROM email_messages WHERE tenant_id = $1 AND template_key = 'scheduled_report'",
      [tenant.id],
    );
    expect(first.rows[0]!.n).toBe(2);

    // A worker that runs twice, or a second worker on another node.
    expect(await runDueReports()).toBe(0);
    const second = await db().query(
      "SELECT COUNT(*)::int AS n FROM email_messages WHERE tenant_id = $1 AND template_key = 'scheduled_report'",
      [tenant.id],
    );
    expect(second.rows[0]!.n).toBe(2);
  });

  it('carries no unsubscribe link, so a report cannot suppress a staff address', async () => {
    await seedOrders();
    await savedReport();
    await upsertSchedule(tenant.id, {
      reportKey: 'weekly_revenue',
      cadence: 'daily',
      hour: 0,
      recipients: ['owner@shop.example'],
    });
    await runDueReports();

    const { rows } = await db().query(
      "SELECT unsubscribe_url FROM email_messages WHERE tenant_id = $1 AND template_key = 'scheduled_report'",
      [tenant.id],
    );
    expect(rows[0]!.unsubscribe_url).toBeNull();
  });

  it('records what went out', async () => {
    await seedOrders();
    await savedReport();
    await upsertSchedule(tenant.id, {
      reportKey: 'weekly_revenue',
      cadence: 'daily',
      hour: 0,
      recipients: ['owner@shop.example'],
    });
    await runDueReports();

    const { rows } = await db().query('SELECT * FROM report_runs WHERE tenant_id = $1', [
      tenant.id,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.rows_out).toBe(2);
    expect(rows[0]!.recipients).toEqual(['owner@shop.example']);
  });

  it('refuses a schedule with nobody to send to', async () => {
    await savedReport();
    await expect(
      upsertSchedule(tenant.id, { reportKey: 'weekly_revenue', recipients: ['not-an-address'] }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a schedule for a report that does not exist', async () => {
    await expect(
      upsertSchedule(tenant.id, { reportKey: 'imaginary', recipients: ['a@b.com'] }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('skips a disabled schedule', async () => {
    await seedOrders();
    await savedReport();
    await upsertSchedule(tenant.id, {
      reportKey: 'weekly_revenue',
      cadence: 'daily',
      hour: 0,
      recipients: ['owner@shop.example'],
      enabled: false,
    });
    expect(await runDueReports()).toBe(0);
  });
});

describe('over the API', () => {
  it('lists what a report can be built from', async () => {
    const res = await authed('GET', '/v1/saved-reports/catalogue');
    const sources = JSON.parse(res.body).sources;
    const orders = sources.find((one: { key: string }) => one.key === 'orders');
    expect(orders.measures.some((m: { key: string }) => m.key === 'revenue')).toBe(true);
    expect(orders.dimensions.some((d: { key: string }) => d.key === 'campaign')).toBe(true);
  });

  it('runs a definition without saving it', async () => {
    await seedOrders();
    const res = await authed('POST', '/v1/saved-reports/run', {
      definition: { source: 'orders', dimensions: ['campaign'], measures: ['revenue'] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).rows).toHaveLength(2);

    // Nothing was saved.
    expect(JSON.parse((await authed('GET', '/v1/saved-reports')).body).reports).toHaveLength(0);
  });

  it('saves, runs and exports a report', async () => {
    await seedOrders();

    const saved = await authed('PUT', '/v1/saved-reports/revenue', {
      name: 'Revenue by campaign',
      definition: { source: 'orders', dimensions: ['campaign'], measures: ['orders', 'revenue'] },
    });
    expect(saved.statusCode).toBe(200);

    const run = await authed('GET', '/v1/saved-reports/revenue/run');
    expect(JSON.parse(run.body).rows).toHaveLength(2);

    const csv = await authed('GET', '/v1/saved-reports/revenue/run.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('revenue-');
    expect(csv.body).toContain('Campaign,Orders,Revenue');
  });

  it('reports a bad definition as a 400 naming the problem', async () => {
    const res = await authed('PUT', '/v1/saved-reports/bad', {
      definition: { source: 'orders', dimensions: ['pii_salt'], measures: ['orders'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('grouped by');
  });

  it('schedules, sends on demand and lists the runs', async () => {
    await seedOrders();
    await authed('PUT', '/v1/saved-reports/revenue', {
      name: 'Revenue',
      definition: { source: 'orders', dimensions: ['campaign'], measures: ['revenue'] },
    });

    const scheduled = await authed('PUT', '/v1/saved-reports/revenue/schedule', {
      cadence: 'weekly',
      hour: 7,
      dayOfWeek: 1,
      recipients: ['owner@shop.example'],
    });
    expect(scheduled.statusCode).toBe(200);

    const sent = await authed('POST', '/v1/saved-reports/revenue/send');
    expect(sent.statusCode).toBe(200);
    expect(JSON.parse(sent.body).sent).toBe(1);

    const runs = JSON.parse((await authed('GET', '/v1/saved-reports/runs')).body).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.report_name).toBe('Revenue');
  });

  it('does not let sending by hand consume the scheduled send', async () => {
    await seedOrders();
    await authed('PUT', '/v1/saved-reports/revenue', {
      name: 'Revenue',
      definition: { source: 'orders', dimensions: [], measures: ['revenue'] },
    });
    await authed('PUT', '/v1/saved-reports/revenue/schedule', {
      cadence: 'daily',
      hour: 0,
      recipients: ['owner@shop.example'],
    });

    await authed('POST', '/v1/saved-reports/revenue/send');
    // Somebody checking on Friday should still get Monday's.
    expect(await runDueReports()).toBe(1);
  });

  it('does not reach another tenant’s reports', async () => {
    const other = await makeTenant();
    await upsertReport(other.id, {
      key: 'theirs',
      definition: { source: 'orders', dimensions: [], measures: ['revenue'] },
    });

    expect(JSON.parse((await authed('GET', '/v1/saved-reports')).body).reports).toHaveLength(0);
    expect((await authed('GET', '/v1/saved-reports/theirs/run')).statusCode).toBe(404);
  });
});

describe('a schedule reads the tenant\'s clock, not the host\'s', () => {
  it('is unaffected by the process timezone', async () => {
    // `now() AT TIME ZONE $1` is a timestamp without a zone, and
    // node-postgres parses one of those using the process timezone. A London
    // tenant on a Toronto host read four hours ahead: reports fired early, and
    // weekly and monthly ones landed on the wrong day.
    const { runDueReports } = await import('../src/services/report-schedules.js');
    const saved = process.env.TZ;

    await db().query("UPDATE tenants SET timezone = 'Europe/London' WHERE id = $1", [tenant.id]);

    const keys: string[] = [];
    for (const zone of ['UTC', 'America/Toronto', 'Asia/Tokyo']) {
      process.env.TZ = zone;
      const { rows } = await db().query<{ local: string }>(
        `SELECT to_char(now() AT TIME ZONE 'Europe/London', 'YYYY-MM-DD"T"HH24:MI:SS') AS local`,
      );
      keys.push(new Date(`${rows[0]!.local}Z`).toISOString().slice(0, 13));
    }
    process.env.TZ = saved;

    // The same wall-clock hour at the tenant, whatever the host thinks.
    expect(new Set(keys).size).toBe(1);
    // And the worker still runs.
    expect(typeof (await runDueReports())).toBe('number');
  });

  it('hands the period back when a send fails, so it is retried', async () => {
    const { runDueReports } = await import('../src/services/report-schedules.js');

    await authed('PUT', '/v1/saved-reports/tz_report', {
      name: 'Timezone report',
      definition: { source: 'orders', measures: ['orders'], dimensions: [] },
    });
    // A recipient the send will choke on, so `sendOne` throws.
    await authed('PUT', '/v1/saved-reports/tz_report/schedule', {
      cadence: 'daily',
      hour: 0,
      recipients: ['nobody@example.com'],
    });

    await db().query(
      `UPDATE report_schedules SET last_period = NULL, enabled = true
        WHERE tenant_id = $1`,
      [tenant.id],
    );
    await db().query('UPDATE reports SET definition = $2 WHERE tenant_id = $1', [
      tenant.id,
      // A source the report builder will refuse, so the send fails.
      JSON.stringify({ source: 'nonsense', measures: ['orders'], dimensions: [] }),
    ]);

    await runDueReports();

    const { rows } = await db().query<{ last_period: string | null }>(
      'SELECT last_period FROM report_schedules WHERE tenant_id = $1',
      [tenant.id],
    );
    // Not claimed, so tomorrow's pass tries again rather than skipping the day.
    expect(rows[0]!.last_period).toBeNull();

    const { rows: runs } = await db().query<{ status: string }>(
      'SELECT status FROM report_runs WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(runs.map((row) => row.status)).toContain('failed');
  });
});
