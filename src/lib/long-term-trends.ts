import type { Session, SessionSummaryItem } from '@/types/session';
import { tripDate } from './trips';

function metricUnit(item: SessionSummaryItem): string { return item.unit || item.parameter_key?.match(/\(([^)]+)\)/)?.[1] || ''; }
export function metricKey(item: SessionSummaryItem): string | null {
  const key = item.canonical_key || item.parameter_key || item.label || null;
  if (key === 'mpg_or_fuel_rate') {
    const unit = metricUnit(item).toLowerCase().replace(/\s/g,'');
    if (unit === 'mpg') return 'fuel_economy_mpg';
    if (unit === 'l/100km') return 'fuel_consumption_per_distance';
    if (unit === 'km/l') return 'fuel_economy_kml';
    return unit === 'l/h' ? key : key + ':' + (unit || 'unknown');
  }
  return key;
}
export function trendMetrics(sessions: Session[]) {
  const metrics = new Map<string, { key: string; label: string; unit: string }>();
  for (const session of sessions) for (const item of session.summary?.summaries ?? []) {
    const key = metricKey(item);
    if (key && [item.avg, item.min, item.max].some((v) => typeof v === 'number' && Number.isFinite(v))) {
      metrics.set(key, { key, label: item.label || item.parameter_key || key, unit: metricUnit(item) });
    }
  }
  return [...metrics.values()].sort((a, b) => a.label.localeCompare(b.label));
}
export interface TrendBucket {
  period: string; trips: number; covered: number; avg: number | null; min: number | null; max: number | null;
}
/** Averages weighted by each trip's duration; absent measurements stay null. */
export function aggregateTrends(sessions: Session[], metric: string, group: 'month' | 'year', timezone: string): TrendBucket[] {
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' });
  const buckets = new Map<string, TrendBucket & { weighted: number; weight: number }>();
  for (const session of sessions) {
    const date = tripDate(session);
    if (!Number.isFinite(date.getTime())) continue;
    const parts = formatter.formatToParts(date);
    const year = parts.find((p) => p.type === 'year')!.value;
    const period = group === 'year' ? year : `${year}-${parts.find((p) => p.type === 'month')!.value}`;
    const bucket = buckets.get(period) ?? { period, trips: 0, covered: 0, avg: null, min: null, max: null, weighted: 0, weight: 0 };
    bucket.trips++;
    const item = session.summary?.summaries?.find((value) => metricKey(value) === metric);
    if (item && [item.min, item.max, item.avg].some((v) => typeof v === 'number' && Number.isFinite(v))) {
      bucket.covered++;
      if (typeof item.avg === 'number' && Number.isFinite(item.avg)) {
        const duration = item.duration_seconds ?? session.duration_seconds;
        const weight = duration != null && duration > 0 && Number.isFinite(duration) ? duration : 1;
        bucket.weighted += item.avg * weight;
        bucket.weight += weight;
      }
      if (typeof item.min === 'number' && Number.isFinite(item.min)) bucket.min = bucket.min == null ? item.min : Math.min(bucket.min, item.min);
      if (typeof item.max === 'number' && Number.isFinite(item.max)) bucket.max = bucket.max == null ? item.max : Math.max(bucket.max, item.max);
    }
    buckets.set(period, bucket);
  }
  const sorted = [...buckets.keys()].sort();
  if (!sorted.length) return [];
  // Include empty intervening periods so the chart never invents continuity.
  const first = sorted[0].split('-').map(Number);
  const last = sorted[sorted.length - 1];
  const result: TrendBucket[] = [];
  let year = first[0], month = first[1] || 1;
  for (let i = 0; i < 1200; i++) {
    const period = group === 'year' ? String(year) : `${year}-${String(month).padStart(2, '0')}`;
    if (period > last) break;
    const bucket = buckets.get(period);
    result.push(bucket ? { period, trips: bucket.trips, covered: bucket.covered, min: bucket.min, max: bucket.max, avg: bucket.weight ? bucket.weighted / bucket.weight : null }
      : { period, trips: 0, covered: 0, avg: null, min: null, max: null });
    if (group === 'year') year++;
    else { month++; if (month > 12) { month = 1; year++; } }
  }
  return result;
}
