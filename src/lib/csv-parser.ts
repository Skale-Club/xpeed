import { matchCanonicalKey } from './canonical-params';
import { extractDtcs } from './dtc-codes';

export interface ParsedCSV {
  headers: string[];
  rows: Record<string, number | string | null>[];
  headerMapping: Record<string, { canonical_key: string; label: string; unit: string } | null>;
  timeColumn: { type: 'timestamp' | 'seconds' | 'index'; key: string } | null;
  // All unique DTC codes seen anywhere in the file (from common columns like
  // "DTC", "Trouble Codes", "P-Code"). Empty array when no such column exists.
  activeDtcs: string[];
}

const DTC_COLUMN_HINTS = [
  'dtc', 'troublecode', 'troublecodes', 'pcode', 'p-code', 'fault', 'faultcode',
  'diagnostictroublecode', 'diagnosticcode',
];

/**
 * Walk the parsed rows looking for any column whose name suggests it contains
 * DTC strings, and aggregate all unique codes encountered.
 */
export function extractSessionDtcs(headers: string[], rows: Record<string, number | string | null>[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const dtcCols = headers.filter(h => DTC_COLUMN_HINTS.includes(norm(h)));
  if (dtcCols.length === 0) return [];

  const seen = new Set<string>();
  for (const row of rows) {
    for (const col of dtcCols) {
      const val = row[col];
      if (val == null) continue;
      for (const code of extractDtcs(val)) seen.add(code);
    }
  }
  return Array.from(seen).sort();
}

function detectDelimiter(firstLine: string): string {
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function isNumeric(val: string): boolean {
  if (!val || val.trim() === '') return false;
  return !isNaN(Number(val.replace(',', '.')));
}

function toNumber(val: string): number | null {
  if (!val || val.trim() === '') return null;
  const cleaned = val.replace(',', '.');
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

function detectTimeColumn(headers: string[], sampleRows: Record<string, string>[]): ParsedCSV['timeColumn'] {
  // Priority 1: timestamp/date/time column with ISO-like values
  const tsKeywords = ['timestamp', 'date', 'datetime'];
  for (const h of headers) {
    const lower = h.toLowerCase();
    if (tsKeywords.some(kw => lower.includes(kw))) {
      const sample = sampleRows[0]?.[h];
      if (sample && !isNumeric(sample)) {
        return { type: 'timestamp', key: h };
      }
    }
  }

  // Priority 2: numeric time column. Match short/ambiguous tokens like "t"
  // only exactly — otherwise any header containing the letter "t" (e.g.
  // "Coolant Temp", "Throttle Pos") would be misread as the time column.
  // Longer keywords may still match as substrings (e.g. "Trip Time", "Elapsed (s)").
  const exactTimeKeys = ['t', 'time', 'seconds', 'elapsed'];
  const substringTimeKeys = ['time', 'seconds', 'elapsed'];
  for (const h of headers) {
    const lower = h.toLowerCase().trim();
    if (exactTimeKeys.includes(lower) || substringTimeKeys.some(kw => lower.includes(kw))) {
      const sample = sampleRows[0]?.[h];
      if (sample && isNumeric(sample)) {
        return { type: 'seconds', key: h };
      }
    }
  }

  return null;
}

export function parseCSV(text: string): ParsedCSV {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (lines.length < 2) {
    return { headers: [], rows: [], headerMapping: {}, timeColumn: null, activeDtcs: [] };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCSVLine(lines[0], delimiter);

  // Build raw string rows first for time detection
  const rawRows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i], delimiter);
    if (values.length === 0 || (values.length === 1 && values[0] === '')) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rawRows.push(row);
  }

  const timeColumn = detectTimeColumn(headers, rawRows);

  // Check for Long Format (PID/VALUE) to Pivot
  const pidHeader = headers.find(h => h.trim().toUpperCase() === 'PID');
  const valueHeader = headers.find(h => h.trim().toUpperCase() === 'VALUE');

  if (pidHeader && valueHeader && timeColumn) {
    const grouped = new Map<string, Record<string, unknown>>();
    const newHeadersSet = new Set<string>();
    newHeadersSet.add(timeColumn.key);

    // Other static columns (like LATITUDE, LONGTITUDE) that are not PID/VALUE/UNITS
    const staticHeaders = headers.filter(h => 
      h !== pidHeader && h !== valueHeader && h.toUpperCase() !== 'UNITS' && h !== timeColumn.key
    );
    staticHeaders.forEach(h => newHeadersSet.add(h));

    rawRows.forEach(row => {
      const timeVal = row[timeColumn.key];
      if (!timeVal) return; // Skip if no time

      if (!grouped.has(timeVal)) {
        grouped.set(timeVal, { 
          [timeColumn.key]: timeColumn.type === 'seconds' ? toNumber(timeVal) : timeVal 
        });
      }
      const entry = grouped.get(timeVal)!;

      // Add static columns (take from first occurrence or overwrite)
      staticHeaders.forEach(h => {
        const val = row[h];
        entry[h] = isNumeric(val) ? toNumber(val) : val;
      });

      // Pivot the PID/VALUE
      const pid = row[pidHeader];
      const val = row[valueHeader];
      if (pid) {
        // Clean PID to be a valid key if needed, but keeping it raw is usually fine
        newHeadersSet.add(pid);
        entry[pid] = isNumeric(val) ? toNumber(val) : val;
      }
    });

    const newHeaders = Array.from(newHeadersSet);
    const newRows = Array.from(grouped.values());
    
    // Re-generate mapping for new headers
    const newHeaderMapping: Record<string, ReturnType<typeof matchCanonicalKey>> = {};
    newHeaders.forEach(h => {
      newHeaderMapping[h] = matchCanonicalKey(h);
    });

    return {
      headers: newHeaders,
      rows: newRows,
      headerMapping: newHeaderMapping,
      timeColumn: timeColumn,
      activeDtcs: extractSessionDtcs(newHeaders, newRows),
    };
  }

  const headerMapping: Record<string, ReturnType<typeof matchCanonicalKey>> = {};
  headers.forEach(h => {
    headerMapping[h] = matchCanonicalKey(h);
  });

  // Convert to typed rows
  const rows: Record<string, number | string | null>[] = rawRows.map(raw => {
    const row: Record<string, number | string | null> = {};
    headers.forEach(h => {
      const val = raw[h];
      if (timeColumn?.key === h && timeColumn.type === 'timestamp') {
        row[h] = val || null;
      } else if (isNumeric(val)) {
        row[h] = toNumber(val);
      } else {
        row[h] = val || null;
      }
    });
    return row;
  });

  return { headers, rows, headerMapping, timeColumn, activeDtcs: extractSessionDtcs(headers, rows) };
}
