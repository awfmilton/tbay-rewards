import { withTransaction } from '../db/pool.js';
import { upsertContact } from '../services/contacts.js';
import { ensureList } from '../services/newsletter.js';
import { hashToken, randomToken } from '../lib/crypto.js';
import { parseCsvTable, pick } from './csv.js';
import {
  emptyReport,
  recordError,
  warnIfTruncated,
  type ImportOptions,
  type ImportReport,
} from './types.js';

/**
 * Import contacts out of Mautic.
 *
 * Takes a Mautic contact CSV export (Contacts → Export) and lands each row as a
 * platform contact plus, where the source says they opted in, a *confirmed*
 * subscription carrying the original consent date.
 *
 * Preserving that date is the point: re-consenting an existing list is the
 * fastest way to lose it, and under GDPR the original opt-in timestamp is the
 * evidence you need to keep mailing them. Anyone Mautic recorded as
 * unsubscribed or bounced stays that way.
 */

export interface MauticImportInput {
  tenantId: string;
  csv: string;
  listSlug?: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'subscribed', 'confirmed', 'active']);
const UNSUBSCRIBED = new Set(['unsubscribed', 'opted_out', 'optout', 'do_not_contact', 'dnc', '0', 'false', 'no']);
const BOUNCED = new Set(['bounced', 'bounce', 'invalid', 'spam', 'complained']);

export async function importMauticContacts(
  input: MauticImportInput,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const report = emptyReport('mautic', options.dryRun === true);
  const table = parseCsvTable(input.csv);
  warnIfTruncated(report, table);

  if (table.headers.length === 0) {
    report.warnings.push('The file appears to be empty.');
    return report;
  }
  if (!table.headers.some((header) => header.includes('email'))) {
    report.warnings.push('No email column found — is this a Mautic contact export?');
    return report;
  }

  const rows = options.limit ? table.rows.slice(0, options.limit) : table.rows;
  const list = report.dryRun ? null : await ensureList(input.tenantId, input.listSlug ?? 'newsletter');

  for (const [index, row] of rows.entries()) {
    report.read += 1;
    options.onProgress?.(report.read, rows.length);

    const email = pick(row, 'email', 'email_address', 'primary email').toLowerCase();
    if (email === '' || !email.includes('@')) {
      report.skipped += 1;
      continue;
    }

    const status = subscriptionStatus(row);

    if (report.dryRun) {
      report.created += 1;
      continue;
    }

    try {
      await withTransaction(async (client) => {
        // Has this person already opted out *here*?
        //
        // An import is a snapshot of somebody else's system, and re-running a
        // stale export is the documented way to resume an interrupted one. It
        // was also a way to resubscribe everybody who unsubscribed in the
        // meantime — a file written last month overriding a decision made last
        // week. An opt-out recorded on this platform outranks the file.
        const optedOut = await client.query(
          `SELECT 1 FROM subscriptions s
             JOIN contacts c ON c.id = s.contact_id
            WHERE c.tenant_id = $1 AND c.email_normalised = lower($2)
              AND s.status IN ('unsubscribed', 'complained')
            LIMIT 1`,
          [input.tenantId, email],
        );
        const mayGrantConsent = (optedOut.rowCount ?? 0) === 0;

        const contact = await upsertContact(
          input.tenantId,
          {
            email,
            name: displayName(row),
            phone: pick(row, 'phone', 'mobile') || null,
            country: pick(row, 'country').slice(0, 2) || null,
            externalRef: pick(row, 'id') ? `mautic:${pick(row, 'id')}` : null,
            // Only ever granted, never withdrawn, and never overwritten once
            // it is already true. An import is a snapshot: re-running a stale
            // export — the documented way to resume an interrupted one —
            // otherwise resubscribed everybody who unsubscribed since it was
            // taken. Somebody who opts out after the file was written has
            // opted out.
            marketingConsent: status === 'subscribed' && mayGrantConsent ? true : undefined,
            consentSource: status === 'subscribed' && mayGrantConsent ? 'mautic_import' : undefined,
            attributes: extraAttributes(row),
            tags: parseTags(row),
          },
          client,
        );

        // Carry the original opt-in date across rather than stamping today.
        // This overwrites rather than COALESCEs: upsertContact has just set
        // consent_at to now() for a newly consented contact, and the imported
        // date is the authoritative record of when they actually opted in.
        const consentedAt = parseDate(pick(row, 'date_added', 'date_identified', 'created'));
        if (consentedAt && status === 'subscribed') {
          await client.query(`UPDATE contacts SET consent_at = $2 WHERE id = $1`, [
            contact.id,
            consentedAt,
          ]);
        }

        await client.query(
          `INSERT INTO subscriptions (
             tenant_id, list_id, contact_id, status, unsub_token_hash, source,
             requested_at, confirmed_at, unsubscribed_at
           ) VALUES ($1, $2, $3, $4, $5, 'mautic_import', COALESCE($6, now()), $7, $8)
           ON CONFLICT (list_id, contact_id) DO UPDATE SET
             -- An unsubscribe here outranks whatever the file says: it
             -- happened on this platform, after the export was taken.
             status = CASE
                        WHEN subscriptions.status IN ('unsubscribed', 'complained')
                          THEN subscriptions.status
                        ELSE EXCLUDED.status
                      END,
             confirmed_at = COALESCE(subscriptions.confirmed_at, EXCLUDED.confirmed_at)`,
          [
            input.tenantId,
            list!.id,
            contact.id,
            status,
            hashToken(randomToken(24)),
            consentedAt,
            status === 'subscribed' ? (consentedAt ?? new Date()) : null,
            status === 'unsubscribed' ? new Date() : null,
          ],
        );
      });
      report.created += 1;
    } catch (err) {
      recordError(report, index + 2, err instanceof Error ? err.message : String(err));
    }
  }

  if (report.read > 0 && report.skipped > 0) {
    report.warnings.push(`${report.skipped} row(s) had no usable email address and were skipped.`);
  }

  return report;
}

function subscriptionStatus(row: Record<string, string>): 'subscribed' | 'unsubscribed' | 'bounced' {
  const raw = pick(row, 'dnc_status', 'do_not_contact', 'unsubscribed', 'status', 'subscribed').toLowerCase();

  if (BOUNCED.has(raw)) return 'bounced';
  if (UNSUBSCRIBED.has(raw)) return 'unsubscribed';
  if (TRUTHY.has(raw)) return 'subscribed';

  // Mautic exports a "do not contact" reason only for people who are excluded,
  // so an empty value means the contact is mailable.
  return raw === '' ? 'subscribed' : 'unsubscribed';
}

function displayName(row: Record<string, string>): string | null {
  const full = pick(row, 'name', 'full_name');
  if (full !== '') return full;
  const joined = [pick(row, 'firstname', 'first_name'), pick(row, 'lastname', 'last_name')]
    .filter((part) => part !== '')
    .join(' ');
  return joined === '' ? null : joined;
}

function parseTags(row: Record<string, string>): string[] {
  const raw = pick(row, 'tags');
  if (raw === '') return [];
  return raw
    .split(/[|,]/)
    .map((tag) => tag.trim().slice(0, 64))
    .filter((tag) => tag !== '')
    .slice(0, 50);
}

/** Keep Mautic's custom fields rather than dropping them on the floor. */
function extraAttributes(row: Record<string, string>): Record<string, string> {
  const known = new Set([
    'id', 'email', 'email_address', 'name', 'full_name', 'firstname', 'first_name',
    'lastname', 'last_name', 'phone', 'mobile', 'country', 'tags', 'status',
    'subscribed', 'unsubscribed', 'dnc_status', 'do_not_contact', 'date_added',
    'date_identified', 'created', 'points',
  ]);

  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (known.has(key) || value === '') continue;
    if (Object.keys(extras).length >= 40) break;
    extras[key.slice(0, 64)] = value.slice(0, 500);
  }
  return extras;
}

function parseDate(value: string): Date | null {
  if (value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
