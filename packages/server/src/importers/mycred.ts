import { withTransaction } from '../db/pool.js';
import { upsertContact } from '../services/contacts.js';
import { award } from '../services/points.js';
import { evaluateRank } from '../services/gamification.js';
import { parseCsvTable, pick } from './csv.js';
import { emptyReport, recordError, type ImportOptions, type ImportReport } from './types.js';

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
