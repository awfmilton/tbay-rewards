/**
 * Migration importers.
 *
 * Every importer is idempotent and supports a dry run, because a migration that
 * cannot be rehearsed is a migration nobody runs on a live store. Re-running an
 * import must never double a balance or duplicate a contact — all writes go
 * through the same idempotency keys the live system uses.
 */

export interface ImportOptions {
  /** Parse, validate and report without writing anything. */
  dryRun?: boolean;
  /** Stop after this many source rows. Useful for a smoke test. */
  limit?: number;
  /** Called with progress so a CLI can show a counter. */
  onProgress?: (processed: number, total: number) => void;
}

export interface ImportReport {
  source: string;
  dryRun: boolean;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  warnings: string[];
  errors: Array<{ row: number; reason: string }>;
}

export function emptyReport(source: string, dryRun: boolean): ImportReport {
  return {
    source,
    dryRun,
    read: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
    errors: [],
  };
}

/**
 * Say when a file was cut short by a quote that was never closed.
 *
 * Everything after it collapses into one value, so most of the rows simply are
 * not there. Importing 40 of 4,000 contacts and reporting success is the worst
 * possible outcome -- the retailer moves on believing the list came across.
 */
export function warnIfTruncated(report: ImportReport, table: { unterminatedQuote: boolean }): void {
  if (!table.unterminatedQuote) return;
  report.warnings.push(
    'The file ends inside a quoted value, so rows after that point were not read. ' +
      'Check for a stray " and export again.',
  );
}

/** Keep the error list bounded so one broken export cannot exhaust memory. */
export function recordError(report: ImportReport, row: number, reason: string): void {
  report.failed += 1;
  if (report.errors.length < 100) {
    report.errors.push({ row, reason: reason.slice(0, 300) });
  } else if (report.errors.length === 100) {
    report.errors.push({ row, reason: '… further errors suppressed' });
  }
}
