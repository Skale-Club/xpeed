// Turn a live-scanner recording into a CSV that the regular upload pipeline
// (useCSVUpload → parseCSV → insights/flags/report/AI) ingests unchanged.

export interface ScannerSample {
  /** Seconds since recording started. */
  t: number;
  /** Values keyed by column header (see pidHeader()). */
  values: Record<string, number | null>;
}

/** Column names come from custom PIDs too, so they may contain commas or quotes. */
function quote(name: string): string {
  return /[",\r\n]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
}

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '';
  return String(Math.round(v * 1000) / 1000);
}

/**
 * "Time (s)" must stay the first column: parseCSV's time detection picks the
 * first numeric header containing "t". DTCs go in a "DTC" column on the first
 * row so extractSessionDtcs() records them as the session's active codes.
 */
export function buildScannerCsv(columns: string[], samples: ScannerSample[], dtcs: string[] = []): string {
  const header = ['Time (s)', ...columns, ...(dtcs.length ? ['DTC'] : [])];
  const lines = [header.map(quote).join(',')];
  samples.forEach((s, i) => {
    const row = [fmt(s.t), ...columns.map((c) => fmt(s.values[c]))];
    if (dtcs.length) row.push(i === 0 ? dtcs.join(' ') : '');
    lines.push(row.join(','));
  });
  return lines.join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "xpeed-scan_2026-10-28 15-30-00.csv" — the upload hook parses the start time from it. */
export function scannerFilename(start: Date): string {
  const d = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
  const t = `${pad(start.getHours())}-${pad(start.getMinutes())}-${pad(start.getSeconds())}`;
  return `xpeed-scan_${d} ${t}.csv`;
}
