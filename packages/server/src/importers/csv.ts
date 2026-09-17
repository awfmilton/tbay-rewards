/**
 * A small RFC 4180 CSV reader.
 *
 * Hand-rolled rather than pulled from npm because the import path has to cope
 * with exactly one awkward thing — quoted fields containing commas, quotes and
 * newlines — and a dependency is not worth it for that.
 */

/**
 * Which character separates the fields.
 *
 * Excel writes the list separator of the machine it ran on, which is a
 * semicolon across most of Europe and in French Canada -- and this product
 * ships to a bilingual Canadian store. A semicolon file parsed as commas is
 * one column wide, so the importer answered "No email column found -- is this
 * a Mautic contact export?" about a file that was exactly that, and the
 * retailer had no way to tell what it wanted instead.
 *
 * Decided from the header line only, and only from text outside quotes, so a
 * comma inside a quoted product name cannot outvote the real delimiter.
 */
function sniffDelimiter(input: string): string {
  let inQuotes = false;
  const counts = new Map<string, number>([[',', 0], [';', 0], ['\t', 0]]);

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === '\n') break;
    const seen = counts.get(char);
    if (seen !== undefined) counts.set(char, seen + 1);
  }

  let best = ',';
  let most = 0;
  for (const [candidate, count] of counts) {
    if (count > most) {
      best = candidate;
      most = count;
    }
  }
  return best;
}

export function parseCsv(input: string, delimiter = sniffDelimiter(input)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM, which Excel exports love to include.
  if (input.charCodeAt(0) === 0xfeff) i = 1;

  while (i < input.length) {
    const char = input[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (char === '\r') {
      i += 1;
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }

    field += char;
    i += 1;
  }

  // A file that does not end in a newline still has a final row.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? '').trim() !== '');
}

export interface CsvTable {
  headers: string[];
  rows: Array<Record<string, string>>;
  /**
   * The file ended inside a quoted field.
   *
   * Everything after the stray quote was swallowed into one value, so rows
   * are missing. The parse still returns what it has -- half an import beats
   * none -- but the caller has to be able to say so, because silently
   * importing 40 of 4,000 contacts and reporting success is worse than
   * failing outright.
   */
  unterminatedQuote: boolean;
}

/** Parse into objects keyed by lowercased, trimmed header. */
export function parseCsvTable(input: string): CsvTable {
  const raw = parseCsv(input);
  const unterminatedQuote = hasUnterminatedQuote(input);
  if (raw.length === 0) return { headers: [], rows: [], unterminatedQuote };

  const headers = (raw[0] ?? []).map((header) => header.trim().toLowerCase());
  const rows = raw.slice(1).map((line) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (line[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rows, unterminatedQuote };
}

/** An odd number of quote characters means one was never closed. */
function hasUnterminatedQuote(input: string): boolean {
  let quotes = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === '"') quotes += 1;
  }
  return quotes % 2 === 1;
}

/** First non-empty value among several candidate column names. */
export function pick(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}
