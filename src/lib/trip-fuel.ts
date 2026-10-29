import type { SessionRow, SessionSummaryItem } from '@/types/session';

/** Integrates actual L/h readings. Never bridges missing values or long recording gaps. */
export function tripFuel(rows: Pick<SessionRow, 't_seconds' | 'data'>[], summaries: SessionSummaryItem[], duration: number | null) {
  const mapped = summaries.find((item) => item.unit === 'L/h' && item.parameter_key && item.canonical_key === 'mpg_or_fuel_rate')?.parameter_key;
  const key = mapped ?? Object.keys(rows[0]?.data ?? {}).find((name) => /fuel rate.*\(L\/h\)/i.test(name));
  if (!key) return null;
  const points = rows.filter((row) => row.t_seconds != null && Number.isFinite(row.t_seconds)).slice().sort((a, b) => a.t_seconds! - b.t_seconds!);
  let litres = 0;
  let seconds = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1], current = points[index];
    const gap = current.t_seconds! - previous.t_seconds!;
    const a = previous.data[key], b = current.data[key];
    if (gap <= 0 || gap > 30 || typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) continue;
    litres += (a + b) / 2 * gap / 3600;
    seconds += gap;
  }
  if (!seconds) return null;
  return { litres, seconds, coverage: duration != null && duration > 0 ? Math.min(1, seconds / duration) : null };
}
