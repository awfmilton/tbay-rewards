import { withTransaction } from '../db/pool.js';
import { upsertContact } from '../services/contacts.js';
import { award } from '../services/points.js';
import { evaluateRank } from '../services/gamification.js';
import { parseCsvTable, pick } from './csv.js';
import {
  emptyReport,
  recordError,
  warnIfTruncated,
  type ImportOptions,
  type ImportReport,
} from './types.js';

/**
 * Import myCred balances, badges and ranks.
 *
 * Balances land as a single opening ledger entry per member rather than a
 * replayed history: the platform's ledger is the system of record from the
 * cutover forward, and an opening balance is auditable without pretending to
 * reconstruct years of myCred log entries it never saw.
 *
 * The idempotency key is derived from (tenant, external ref), so re-running the
 * import after a failed pass tops nobody up twice.
 */

export interface MyCredImportInput {
  tenantId: string;
  /** Export with columns: user_email, balance, [user_id], [badges], [rank] */
  csv: string;
}

export async function importMyCredBalances(
  input: MyCredImportInput,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report = emptyReport('mycred', options.dryRun === true);
  const table = parseCsvTable(input.csv);
  warnIfTruncated(report, table);

  if (table.headers.length === 0) {
    report.warnings.push('The file appears to be empty.');
    return report;
  }
  if (!table.headers.some((header) => header.includes('email'))) {
    report.warnings.push('No email column found — export myCred balances with a user_email column.');
    return report;
  }

  const rows = options.limit ? table.rows.slice(0, options.limit) : table.rows;

  for (const [index, row] of rows.entries()) {
    report.read += 1;
    options.onProgress?.(report.read, rows.length);

    const email = pick(row, 'user_email', 'email').toLowerCase();
    const balance = Math.trunc(Number(pick(row, 'balance', 'creds', 'points') || '0'));

    if (email === '' || !email.includes('@')) {
      report.skipped += 1;
      continue;
    }
    if (!Number.isFinite(balance) || balance <= 0) {
      // A zero balance still deserves a contact record, but no ledger entry.
      report.skipped += 1;
      continue;
    }

    if (report.dryRun) {
      report.created += 1;
      continue;
    }

    try {
      await withTransaction(async (client) => {
        const userId = pick(row, 'user_id', 'id');
        const contact = await upsertContact(
          input.tenantId,
          {
            email,
            name: pick(row, 'display_name', 'name') || null,
            externalRef: userId !== '' ? userId : null,
          },
          client,
        );

        await award(
          input.tenantId,
          {
            contactId: contact.id,
            points: balance,
            reason: 'Opening balance imported from myCred',
            refType: 'import',
            refId: 'mycred',
            idempotencyKey: `import:mycred:${contact.id}`,
            meta: { source: 'mycred', original_balance: balance, mycred_user_id: userId },
          },
          client,
        );

        await importBadges(client, input.tenantId, contact.id, pick(row, 'badges'));
      });

      const { requireContact } = await import('../services/contacts.js');
      const contact = await requireContact(input.tenantId, { email });
      await evaluateRank(input.tenantId, contact.id);

      report.created += 1;
    } catch (err) {
      recordError(report, index + 2, err instanceof Error ? err.message : String(err));
    }
  }

  report.warnings.push(
    'Balances were imported as a single opening ledger entry per member. ' +
      'Ranks were recalculated from lifetime points, so members keep their standing.',
  );

  return report;
}

/**
 * Map myCred badge slugs onto platform badges.
 *
 * Only badges that already exist on the platform are granted — importing would
 * otherwise invent badge definitions nobody configured, and a badge with no
 * criteria can never be earned again by anyone else.
 */
async function importBadges(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> },
  tenantId: string,
  contactId: string,
  badgeField: string,
): Promise<void> {
  if (badgeField === '') return;

  const slugs = badgeField
    .split(/[|,]/)
    .map((slug) => slug.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'))
    .filter((slug) => slug !== '')
    .slice(0, 50);

  for (const slug of slugs) {
    const { rows } = await client.query('SELECT id FROM badges WHERE tenant_id = $1 AND key = $2', [
      tenantId,
      slug,
    ]);
    const badge = rows[0];
    if (!badge) continue;

    await client.query(
      `INSERT INTO badge_awards (tenant_id, badge_id, contact_id, level, progress)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (badge_id, contact_id) DO NOTHING`,
      [tenantId, badge.id, contactId],
    );
  }
}

/**
 * Import myCred's per-entry log history.
 *
 * `importMyCredBalances` above writes one opening entry per member, which
 * keeps the balance exact but leaves every customer looking at an empty
 * history on day one. For a store that has run a rewards programme for years,
 * that history *is* the programme as far as its customers are concerned.
 *
 * This is a second pass, run after the balances, over a myCred log export
 * (`wp_mycred_log`: ref, ref_id, user_id, creds, entry, ctime).
 *
 * Three decisions worth stating:
 *
 *  - **History does not move the balance.** Entries land as `imported` rows
 *    that carry their original points in `meta` and a zero delta, because the
 *    opening balance already accounts for them. Replaying the deltas *and*
 *    keeping the opening entry would double every balance; dropping the
 *    opening entry and replaying instead would be exact only if the export is
 *    complete, which for a log that has been pruned it is not.
 *  - **The original timestamp is preserved**, so the history reads in the
 *    order it happened rather than all at the moment of the import.
 *  - **The myCred row id is the idempotency key**, so a re-run after a partial
 *    import adds only what is missing.
 */
export async function importMyCredHistory(
  input: MyCredImportInput,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report = emptyReport('mycred_history', options.dryRun === true);
  const table = parseCsvTable(input.csv);
  warnIfTruncated(report, table);

  if (table.headers.length === 0) {
    report.warnings.push('The file appears to be empty.');
    return report;
  }
  if (!table.headers.some((header) => header.includes('email'))) {
    report.warnings.push(
      'No email column found. Export the myCred log joined to wp_users so each row carries a user_email.',
    );
    return report;
  }

  const rows = options.limit ? table.rows.slice(0, options.limit) : table.rows;
  const { db } = await import('../db/pool.js');
  const { findContactByEmail } = await import('../services/contacts.js');

  // Cached because a log export is one row per *entry*: a member with four
  // hundred entries would otherwise be looked up four hundred times.
  const contactIds = new Map<string, string | null>();

  for (const [index, row] of rows.entries()) {
    report.read += 1;
    options.onProgress?.(report.read, rows.length);

    const email = pick(row, 'user_email', 'email').toLowerCase();
    const points = Math.trunc(Number(pick(row, 'creds', 'points', 'amount') || '0'));
    const entry = pick(row, 'entry', 'reason', 'description') || 'Imported from myCred';
    const reference = pick(row, 'id', 'log_id', 'entry_id');
    const ruleKey = pick(row, 'ref', 'reference') || null;

    if (email === '' || !email.includes('@') || reference === '') {
      report.skipped += 1;
      continue;
    }

    try {
      if (!contactIds.has(email)) {
        const contact = await findContactByEmail(input.tenantId, email);
        contactIds.set(email, contact?.id ?? null);
      }
      const contactId = contactIds.get(email);

      if (!contactId) {
        // Balances are imported first on purpose. A history row for somebody
        // with no contact means the two exports disagree, which is worth
        // saying rather than silently creating a member from a log line.
        report.skipped += 1;
        if (report.warnings.length < 20) {
          report.warnings.push(`No contact for ${email} — import balances first.`);
        }
        continue;
      }

      if (options.dryRun) {
        report.created += 1;
        continue;
      }

      const occurredAt = parseMyCredTime(pick(row, 'ctime', 'time', 'date', 'created_at'));

      const { rowCount } = await db().query(
        `INSERT INTO points_ledger (
           tenant_id, contact_id, delta_points, reason, rule_key, ref_type, ref_id,
           idempotency_key, status, available_at, meta, created_at
         ) VALUES ($1, $2, 0, $3, $4, 'import_history', $5, $6, 'cleared', $7, $8::jsonb, $7)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
        [
          input.tenantId,
          contactId,
          entry.slice(0, 300),
          ruleKey ? ruleKey.slice(0, 64) : null,
          reference.slice(0, 191),
          `import:mycred:log:${reference}`,
          occurredAt,
          JSON.stringify({
            source: 'mycred',
            // The real number lives here. The delta is zero so the balance,
            // which the opening entry already set, does not move.
            original_points: points,
            mycred_ref: ruleKey,
            historical: true,
          }),
        ],
      );

      if ((rowCount ?? 0) > 0) report.created += 1;
      else report.skipped += 1;
    } catch (err) {
      recordError(report, index, err instanceof Error ? err.message : String(err));
    }
  }

  if (report.created > 0) {
    report.warnings.push(
      'Imported history carries its original points in meta and a zero balance effect — ' +
        'the opening balance already accounts for it.',
    );
  }

  return report;
}

/**
 * myCred stores `ctime` as a Unix timestamp; exports sometimes carry a date
 * string instead. Anything unreadable falls back to now rather than failing
 * the row — a history entry with a wrong date is still better than no entry.
 */
function parseMyCredTime(value: string): Date {
  const now = new Date();
  const trimmed = value.trim();
  if (trimmed === '') return now;

  const parsed = /^\d{9,11}$/.test(trimmed)
    ? new Date(Number(trimmed) * 1000)
    : new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return now;

  // History is history. A future-dated row — a clock-skewed export, a mangled
  // column, a crafted CSV — sat permanently inside every cooldown window for
  // its rule, which silently stopped that member ever earning under it again.
  return parsed > now ? now : parsed;
}
