import { db, withTransaction } from '../db/pool.js';
import { upsertContact } from '../services/contacts.js';
import { createLink } from '../services/links.js';
import { parseCsvTable, pick } from './csv.js';
import {
  emptyReport,
  recordError,
  warnIfTruncated,
  type ImportOptions,
  type ImportReport,
} from './types.js';

/**
 * Import writer links and commission history from the flagswag theme.
 *
 * The theme kept its own tables (wp_flagswag_links, _clicks, _commissions). This
 * reads an export of those and recreates each link *with its original code*, so
 * links already published in blog posts and shared on social keep working
 * against the new platform. That is the whole reason to import rather than
 * start fresh: an affiliate link that 404s is a broken promise to the writer.
 */

export interface FlagswagLinksInput {
  tenantId: string;
  /** Columns: code, target_url, owner_email, [post_id], [product_id], [rate_bps], [clicks] */
  csv: string;
}

export async function importFlagswagLinks(
  input: FlagswagLinksInput,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report = emptyReport('flagswag_links', options.dryRun === true);
  const table = parseCsvTable(input.csv);
  warnIfTruncated(report, table);

  if (!table.headers.includes('code')) {
    report.warnings.push('No code column found — export wp_flagswag_links with its code column.');
    return report;
  }

  const rows = options.limit ? table.rows.slice(0, options.limit) : table.rows;

  for (const [index, row] of rows.entries()) {
    report.read += 1;
    options.onProgress?.(report.read, rows.length);

    const code = pick(row, 'code').trim();
    const target = pick(row, 'target_url', 'target', 'url').trim();
    const ownerEmail = pick(row, 'owner_email', 'writer_email', 'email').toLowerCase();

    if (code === '' || target === '') {
      report.skipped += 1;
      continue;
    }

    if (report.dryRun) {
      report.created += 1;
      continue;
    }

    try {
      const existing = await db().query('SELECT id FROM links WHERE code = $1', [code]);
      if (existing.rows.length > 0) {
        report.updated += 1;
        continue;
      }

      await withTransaction(async (client) => {
        let ownerContactId: string | null = null;
        if (ownerEmail !== '' && ownerEmail.includes('@')) {
          const owner = await upsertContact(input.tenantId, { email: ownerEmail }, client);
          ownerContactId = owner.id;
          await client.query('UPDATE contacts SET is_writer = true WHERE id = $1', [owner.id]);
        }

        const rate = Number(pick(row, 'rate_bps', 'commission_rate_bps') || '500');

        const link = await createLink(
          input.tenantId,
          {
            // Reusing the original code is what keeps published links alive.
            code,
            targetUrl: target,
            kind: 'writer',
            ownerContactId,
            productRef: pick(row, 'product_id', 'product_ref') || null,
            postRef: pick(row, 'post_id', 'post_ref') || null,
            label: pick(row, 'label', 'title') || null,
            commissionRateBps: Number.isFinite(rate) ? Math.trunc(rate) : 500,
          },
          client,
        );

        // Carry the historical click total so reports do not show a cliff at
        // the cutover. Individual click rows are not replayed.
        const clicks = Math.max(0, Math.trunc(Number(pick(row, 'clicks', 'click_count') || '0')));
        if (clicks > 0) {
          await client.query('UPDATE links SET clicks = $2 WHERE id = $1', [link.id, clicks]);
        }
      });

      report.created += 1;
    } catch (err) {
      recordError(report, index + 2, err instanceof Error ? err.message : String(err));
    }
  }

  return report;
}

export interface FlagswagCommissionsInput {
  tenantId: string;
  /** Columns: order_ref, owner_email, amount_cents, [subtotal_cents], [status], [created_at] */
  csv: string;
}

/**
 * Import historical commission rows.
 *
 * Everything imported lands as `paid` unless the export says otherwise: a
 * migration must not re-open a payout that has already been settled, and
 * marking history `pending` would do exactly that.
 */
export async function importFlagswagCommissions(
  input: FlagswagCommissionsInput,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report = emptyReport('flagswag_commissions', options.dryRun === true);
  const table = parseCsvTable(input.csv);
  warnIfTruncated(report, table);

  if (!table.headers.includes('order_ref') && !table.headers.includes('order_id')) {
    report.warnings.push('No order reference column found.');
    return report;
  }

  const rows = options.limit ? table.rows.slice(0, options.limit) : table.rows;

  for (const [index, row] of rows.entries()) {
    report.read += 1;
    options.onProgress?.(report.read, rows.length);

    const orderRef = pick(row, 'order_ref', 'order_id');
    const ownerEmail = pick(row, 'owner_email', 'writer_email', 'email').toLowerCase();
    const amount = Math.trunc(Number(pick(row, 'amount_cents', 'amount') || '0'));

    if (orderRef === '' || ownerEmail === '' || amount <= 0) {
      report.skipped += 1;
      continue;
    }

    if (report.dryRun) {
      report.created += 1;
      continue;
    }

    try {
      await withTransaction(async (client) => {
        const owner = await upsertContact(input.tenantId, { email: ownerEmail }, client);
        await client.query('UPDATE contacts SET is_writer = true WHERE id = $1', [owner.id]);

        const status = normaliseStatus(pick(row, 'status'));
        const createdAt = parseDate(pick(row, 'created_at', 'date'));

        await client.query(
          `INSERT INTO commissions (
             tenant_id, owner_contact_id, order_ref, item_ref, subtotal_cents,
             rate_bps, amount_cents, currency, status, created_at, paid_at, approved_at
           ) VALUES ($1, $2, $3, 'imported', $4, $5, $6, $7, $8, COALESCE($9, now()),
                     CASE WHEN $8 = 'paid' THEN COALESCE($9, now()) END,
                     CASE WHEN $8 IN ('paid','approved') THEN COALESCE($9, now()) END)
           ON CONFLICT (tenant_id, order_ref, item_ref, owner_contact_id) DO NOTHING`,
          [
            input.tenantId,
            owner.id,
            orderRef,
            Math.trunc(Number(pick(row, 'subtotal_cents', 'subtotal') || '0')),
            Math.trunc(Number(pick(row, 'rate_bps') || '0')),
            amount,
            (pick(row, 'currency') || 'CAD').toUpperCase().slice(0, 3),
            status,
            createdAt,
          ],
        );
      });
      report.created += 1;
    } catch (err) {
      recordError(report, index + 2, err instanceof Error ? err.message : String(err));
    }
  }

  report.warnings.push(
    'Imported commissions default to "paid" so a migration never re-opens a settled payout. ' +
      'Set an explicit status column if some were genuinely still outstanding.',
  );

  return report;
}

function normaliseStatus(raw: string): 'pending' | 'approved' | 'paid' | 'void' {
  const value = raw.trim().toLowerCase();
  if (value === 'pending' || value === 'unpaid') return 'pending';
  if (value === 'approved') return 'approved';
  if (value === 'void' || value === 'cancelled' || value === 'canceled') return 'void';
  return 'paid';
}

function parseDate(value: string): Date | null {
  if (value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
