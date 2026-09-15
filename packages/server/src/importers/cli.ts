/**
 * Import CLI.
 *
 *   npm run import -- mautic --tenant flagswag --file contacts.csv --dry-run
 *   npm run import -- mycred --tenant flagswag --file balances.csv
 *   npm run import -- flagswag-links --tenant flagswag --file links.csv
 *   npm run import -- flagswag-commissions --tenant flagswag --file commissions.csv
 *
 * Always rehearse with --dry-run first: it parses and validates the whole file
 * and reports what would happen without writing a single row.
 */
import { readFile } from 'node:fs/promises';
import { closeDb } from '../db/pool.js';
import { getTenantBySlug } from '../services/tenants.js';
import { importMauticContacts } from './mautic.js';
import { importMyCredBalances } from './mycred.js';
import { importFlagswagCommissions, importFlagswagLinks } from './flagswag.js';
import type { ImportReport } from './types.js';

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required flag --${name}`);
  }
  return process.argv[index + 1]!;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function print(report: ImportReport): void {
  console.log(`\n${report.dryRun ? 'DRY RUN — nothing was written' : 'Import complete'}`);
  console.log(`  source     ${report.source}`);
  console.log(`  read       ${report.read}`);
  console.log(`  imported   ${report.created}`);
  console.log(`  existing   ${report.updated}`);
  console.log(`  skipped    ${report.skipped}`);
  console.log(`  failed     ${report.failed}`);

  for (const warning of report.warnings) console.log(`\n  ! ${warning}`);

  if (report.errors.length > 0) {
    console.log('\n  Errors:');
    for (const error of report.errors.slice(0, 20)) {
      console.log(`    line ${error.row}: ${error.reason}`);
    }
  }
  console.log('');
}

const command = process.argv[2];

try {
  if (!command || command === 'help') {
    console.log(`Usage:
  mautic               --tenant <slug> --file <contacts.csv> [--list newsletter] [--dry-run] [--limit N]
  mycred               --tenant <slug> --file <balances.csv> [--dry-run] [--limit N]
  flagswag-links       --tenant <slug> --file <links.csv> [--dry-run] [--limit N]
  flagswag-commissions --tenant <slug> --file <commissions.csv> [--dry-run] [--limit N]

Always run with --dry-run first.`);
  } else {
    const tenant = await getTenantBySlug(flag('tenant'));
    if (!tenant) throw new Error(`No tenant with slug "${flag('tenant')}"`);

    const csv = await readFile(flag('file'), 'utf8');
    const options = {
      dryRun: has('dry-run'),
      limit: has('limit') ? Number(flag('limit')) : undefined,
      onProgress: (processed: number, total: number) => {
        if (processed % 250 === 0) process.stdout.write(`\r  ${processed}/${total}…`);
      },
    };

    let report: ImportReport;
    switch (command) {
      case 'mautic':
        report = await importMauticContacts(
          { tenantId: tenant.id, csv, listSlug: flag('list', 'newsletter') },
          options,
        );
        break;
      case 'mycred':
        report = await importMyCredBalances({ tenantId: tenant.id, csv }, options);
        break;
      case 'flagswag-links':
        report = await importFlagswagLinks({ tenantId: tenant.id, csv }, options);
        break;
      case 'flagswag-commissions':
        report = await importFlagswagCommissions({ tenantId: tenant.id, csv }, options);
        break;
      default:
        throw new Error(`Unknown importer "${command}"`);
    }

    print(report);
  }
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
