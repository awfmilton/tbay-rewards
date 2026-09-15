/**
 * A small RFC 4180 CSV reader.
 *
 * Hand-rolled rather than pulled from npm because the import path has to cope
 * with exactly one awkward thing — quoted fields containing commas, quotes and
 * newlines — and a dependency is not worth it for that.
 */

export function parseCsv(input: string): string[][] {
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

    if (char === ',') {
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
}

/** Parse into objects keyed by lowercased, trimmed header. */
export function parseCsvTable(input: string): CsvTable {
  const raw = parseCsv(input);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = (raw[0] ?? []).map((header) => header.trim().toLowerCase());
  const rows = raw.slice(1).map((line) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (line[index] ?? '').trim();
    });
    return record;
  });

  return { headers, rows };
}

/** First non-empty value among several candidate column names. */
export function pick(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}
