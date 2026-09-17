import { db, queryOne, type Queryable } from '../db/pool.js';
import { ApiError } from '../lib/errors.js';
import { tenantTimezone } from './rewards.js';
import { runReport, toCsv, type Report, type ReportDefinition } from './reports.js';

/**
 * The weekly numbers landing in an inbox on Monday morning.
 *
 * A report nobody opens is a report nobody has, and the difference between a
 * reporting feature and one people use is whether it arrives without being
 * asked for.
 *
 * Cadences rather than cron. An admin screen with a cron field is an admin
 * screen where somebody schedules a report for 03:17 every 13th of the month
 * by accident and does not find out for a year.
 */

export type Cadence = 'daily' | 'weekly' | 'monthly';

export interface ReportSchedule {
  id: string;
  tenant_id: string;
  report_id: string;
  cadence: Cadence;
  hour: number;
  day_of_week: number;
  day_of_month: number;
  recipients: string[];
  enabled: boolean;
  last_period: string | null;
  last_run_at: Date | null;
}

export async function listSchedules(
  tenantId: string,
  runner: Queryable = db(),
): Promise<Array<ReportSchedule & { report_key: string; report_name: string }>> {
  const { rows } = await runner.query<ReportSchedule & { report_key: string; report_name: string }>(
    `SELECT s.*, r.key AS report_key, r.name AS report_name
       FROM report_schedules s
       JOIN reports r ON r.id = s.report_id
      WHERE s.tenant_id = $1
      ORDER BY r.name`,
    [tenantId],
  );
  return rows;
}

export async function upsertSchedule(
  tenantId: string,
  input: {
    reportKey: string;
    cadence?: Cadence;
    hour?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    recipients?: string[];
    enabled?: boolean;
  },
  runner: Queryable = db(),
): Promise<ReportSchedule> {
  const report = await queryOne<{ id: string }>(
    runner,
    'SELECT id FROM reports WHERE tenant_id = $1 AND key = $2',
    [tenantId, input.reportKey],
  );
  if (!report) throw ApiError.notFound(`No report "${input.reportKey}"`);

  const recipients = (input.recipients ?? [])
    .map((address) => String(address).trim().toLowerCase())
    .filter((address) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address))
    .slice(0, 20);

  if (input.recipients && recipients.length === 0) {
    throw ApiError.badRequest('A scheduled report needs at least one valid email address');
  }

  // One schedule per report. Two schedules for the same report is a way to
  // send it twice, and the retailer who wanted a daily *and* a monthly copy
  // wanted two reports.
  const existing = await queryOne<ReportSchedule>(
    runner,
    'SELECT * FROM report_schedules WHERE tenant_id = $1 AND report_id = $2',
    [tenantId, report.id],
  );

  const row = await queryOne<ReportSchedule>(
    runner,
    existing
      ? `UPDATE report_schedules SET
           cadence = COALESCE($3, cadence),
           hour = COALESCE($4, hour),
           day_of_week = COALESCE($5, day_of_week),
           day_of_month = COALESCE($6, day_of_month),
           recipients = COALESCE($7::text[], recipients),
           enabled = COALESCE($8, enabled),
           updated_at = now()
         WHERE tenant_id = $1 AND report_id = $2
         RETURNING *`
      : `INSERT INTO report_schedules (
           tenant_id, report_id, cadence, hour, day_of_week, day_of_month, recipients, enabled
         ) VALUES (
           $1, $2, COALESCE($3, 'weekly'), COALESCE($4, 7), COALESCE($5, 1),
           COALESCE($6, 1), COALESCE($7::text[], '{}'), COALESCE($8, true)
         )
         RETURNING *`,
    [
      tenantId,
      report.id,
      input.cadence ?? null,
      input.hour ?? null,
      input.dayOfWeek ?? null,
      input.dayOfMonth ?? null,
      input.recipients ? recipients : null,
      input.enabled ?? null,
    ],
  );
  return row!;
}

export async function deleteSchedule(
  tenantId: string,
  reportKey: string,
  runner: Queryable = db(),
): Promise<boolean> {
  const { rowCount } = await runner.query(
    `DELETE FROM report_schedules s USING reports r
      WHERE r.id = s.report_id AND s.tenant_id = $1 AND r.key = $2`,
    [tenantId, reportKey],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * The period a schedule is currently in, in the retailer's timezone.
 *
 * Stored on the row once sent, so a worker that runs twice — or a second
 * worker on another node — does not send Monday's report twice. A timestamp
 * comparison would not do: "have we sent since 07:00" is true five minutes
 * later and false after a clock change.
 */
export function periodKey(cadence: Cadence, local: Date): string {
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');

  if (cadence === 'daily') return `${year}-${month}-${day}`;
  if (cadence === 'monthly') return `${year}-${month}`;

  // ISO week, so a Monday report has one key regardless of which calendar
  // month the week straddles.
  const thursday = new Date(local.getTime());
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const start = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - start) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Wall-clock time at the tenant, as a Date whose UTC fields read local.
 *
 * Returned as text and reassembled here rather than let through as a
 * timestamp. `now() AT TIME ZONE $1` is a `timestamp without time zone`, and
 * node-postgres parses one of those using the *process* timezone — so on a
 * container running anything but UTC, the fields this function promises were
 * shifted by the host's offset. A London tenant on a Toronto host read four
 * hours ahead: reports fired early, and weekly and monthly ones landed on the
 * wrong day because the weekday and date had rolled.
 */
async function localNow(tenantId: string, runner: Queryable): Promise<Date> {
  const zone = await tenantTimezone(tenantId, runner);
  const row = await queryOne<{ local: string }>(
    runner,
    `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD"T"HH24:MI:SS') AS local`,
    [zone],
  );
  // The `Z` is what makes the UTC getters read the tenant's wall clock, which
  // is what `periodKey` and `isDue` are written against.
  return new Date(`${row!.local}Z`);
}

export function isDue(schedule: ReportSchedule, local: Date): boolean {
  if (!schedule.enabled) return false;
  if (local.getUTCHours() < schedule.hour) return false;

  if (schedule.cadence === 'weekly' && local.getUTCDay() !== schedule.day_of_week) return false;
  // Clamped to 28 by the schema, so February never silently skips a send.
  if (schedule.cadence === 'monthly' && local.getUTCDate() !== schedule.day_of_month) return false;

  return periodKey(schedule.cadence, local) !== schedule.last_period;
}

/**
 * Send every schedule that is due.
 *
 * Claimed with a conditional UPDATE on `last_period` rather than a lock: the
 * period is the claim, so two workers racing produce one send and one no-op
 * without either of them waiting.
 */
export async function runDueReports(runner: Queryable = db()): Promise<number> {
  const { rows: schedules } = await runner.query<ReportSchedule & { definition: ReportDefinition }>(
    `SELECT s.*, r.definition, r.name AS report_name, r.key AS report_key
       FROM report_schedules s
       JOIN reports r ON r.id = s.report_id
      WHERE s.enabled AND array_length(s.recipients, 1) > 0`,
  );

  let sent = 0;

  for (const schedule of schedules) {
    try {
      const local = await localNow(schedule.tenant_id, runner);
      if (!isDue(schedule, local)) continue;

      const period = periodKey(schedule.cadence, local);

      // The claim. Whoever wins this update sends; anybody else sees zero rows
      // and moves on.
      const { rowCount } = await runner.query(
        `UPDATE report_schedules SET last_period = $2, last_run_at = now()
          WHERE id = $1 AND last_period IS DISTINCT FROM $2`,
        [schedule.id, period],
      );
      if ((rowCount ?? 0) === 0) continue;

      try {
        await sendOne(schedule as never, period, runner);
        sent += 1;
      } catch (err) {
        // Hand the period back. The claim is written before the send so two
        // workers cannot both send — but keeping it after a failure meant the
        // period was simply skipped: Monday's report never went and never
        // retried, because the next pass saw the period already claimed.
        //
        // Safe to retry: `sendOne` queues with a dedupe key per recipient and
        // period, so a failure after some messages were queued does not
        // produce a second copy of them.
        await runner
          .query(
            `UPDATE report_schedules SET last_period = $2
              WHERE id = $1 AND last_period = $3`,
            [schedule.id, schedule.last_period, period],
          )
          .catch(() => {});
        throw err;
      }
    } catch (err) {
      await runner
        .query(
          `INSERT INTO report_runs (tenant_id, report_id, schedule_id, status, error)
           VALUES ($1, $2, $3, 'failed', $4)`,
          [
            schedule.tenant_id,
            schedule.report_id,
            schedule.id,
            err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          ],
        )
        .catch(() => {});
    }
  }

  return sent;
}

async function sendOne(
  schedule: ReportSchedule & {
    definition: ReportDefinition;
    report_name: string;
    report_key: string;
  },
  period: string,
  runner: Queryable,
): Promise<void> {
  const result = await runReport(schedule.tenant_id, schedule.definition, runner);
  const csv = toCsv(result);

  const { queueEmail } = await import('./email.js');
  const { getTenantById } = await import('./tenants.js');
  const tenant = await getTenantById(schedule.tenant_id);

  const summary = result.rows
    .slice(0, 10)
    .map(
      (row) =>
        `<tr>${result.columns
          .map((column) => `<td style="padding:4px 10px;">${escapeCell(row[column.key])}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  const html = `
    <p style="margin:0 0 16px;">${escapeCell(schedule.report_name)}${
      result.from ? ` — since ${escapeCell(result.from.slice(0, 10))}` : ''
    }</p>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr>${result.columns
        .map(
          (column) =>
            `<th style="padding:4px 10px;text-align:left;border-bottom:1px solid #ddd;">${escapeCell(
              column.label,
            )}</th>`,
        )
        .join('')}</tr>
      ${summary}
    </table>
    <p style="margin:16px 0 0;font-size:13px;color:#6e6e73;">
      ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}${
        result.truncated ? ' (truncated)' : ''
      }. The full table is attached as a CSV.
    </p>`;

  for (const recipient of schedule.recipients) {
    await queueEmail(
      {
        tenantId: schedule.tenant_id,
        to: recipient,
        subject: `${schedule.report_name} — ${period}`,
        html,
        text: csv,
        templateKey: 'scheduled_report',
        // Per recipient per period, so a retry after a partial failure sends
        // to whoever missed out rather than to everybody again.
        dedupeKey: `report:${schedule.id}:${period}:${recipient}`,
        // No unsubscribeUrl, which is what marks a message transactional here:
        // the frequency cap counts messages that have one. A report to the
        // retailer's own staff is not marketing and must not consume a
        // customer-facing allowance — nor carry an unsubscribe link that would
        // suppress a member of staff from the store's own mail.
      },
      runner,
    );
  }

  await runner.query(
    `INSERT INTO report_runs (tenant_id, report_id, schedule_id, period, rows_out, recipients)
     VALUES ($1, $2, $3, $4, $5, $6::text[])`,
    [
      schedule.tenant_id,
      schedule.report_id,
      schedule.id,
      period,
      result.rows.length,
      schedule.recipients,
    ],
  );

  void tenant;
}

function escapeCell(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Send one now, whatever its schedule says. */
export async function sendNow(
  tenantId: string,
  reportKey: string,
  runner: Queryable = db(),
): Promise<{ sent: number; rows: number }> {
  const row = await queryOne<
    ReportSchedule & { definition: ReportDefinition; report_name: string; report_key: string }
  >(
    runner,
    `SELECT s.*, r.definition, r.name AS report_name, r.key AS report_key
       FROM report_schedules s
       JOIN reports r ON r.id = s.report_id
      WHERE s.tenant_id = $1 AND r.key = $2`,
    [tenantId, reportKey],
  );
  if (!row) throw ApiError.notFound(`No schedule for report "${reportKey}"`);
  if (row.recipients.length === 0) {
    throw ApiError.unprocessable('That schedule has nobody to send to');
  }

  // A distinct period key, so sending by hand does not consume the scheduled
  // send — somebody checking the report on Friday should still get Monday's.
  const period = `manual-${new Date().toISOString().slice(0, 19)}`;
  await sendOne(row, period, runner);

  const result = await runReport(tenantId, row.definition, runner);
  return { sent: row.recipients.length, rows: result.rows.length };
}
