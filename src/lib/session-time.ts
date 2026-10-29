import type { ParsedCSV } from './csv-parser';

/** Invalid/missing times are gaps, never invented one-second readings. */
export function sessionTimes(parsed: ParsedCSV): (number | null)[] {
  let previous: number | null = null;
  return parsed.rows.map((row, index) => {
    if (!parsed.timeColumn || parsed.timeColumn.type === 'index') return index;
    const value = row[parsed.timeColumn.key];
    const time = parsed.timeColumn.type === 'timestamp'
      ? (typeof value === 'string' ? Date.parse(value) / 1000 : NaN)
      : (typeof value === 'number' ? value : NaN);
    if (!Number.isFinite(time)) return null;
    if (previous !== null && time < previous) throw new Error('CSV times must be in chronological order.');
    previous = time;
    return time;
  });
}

export function sessionDuration(parsed: ParsedCSV): number | undefined {
  if (!parsed.timeColumn) return undefined;
  const times = sessionTimes(parsed).filter((t): t is number => t !== null);
  return times.length > 1 ? Math.round(times[times.length - 1] - times[0]) : undefined;
}
