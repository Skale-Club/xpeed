// The numbers and sentences of the Overview dashboard, as pure functions: no React, no `t`, nothing that reads the clock or the screen, so every
// one of them (the change against the previous period, a sparkline, the heatmap grid, the streak text, the consistency sentence) is tested alone.
// Days are UTC dates (`2026-11-10`), exactly as GET /api/sim/v1/stats gives them.
import type { DistanceUnit } from '@/lib/sim/analysis';
import type { StatsRange, V1Stats, V1StatsDay, V1StatsTotals } from '@/lib/sim/v1-client';
import { STATS_RANGES } from '@/lib/sim/v1-client';

export const DEFAULT_RANGE: StatsRange = '30d';
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------- the range, remembered

/** The key under which a person's range is kept in this browser (per sign-in, so a shared computer does not mix people). */
export const rangeStorageKey = (userId: string | null) => `xpeed.sim.overview.range.${userId ?? 'anon'}`;

export const isStatsRange = (value: unknown): value is StatsRange => typeof value === 'string' && (STATS_RANGES as readonly string[]).includes(value);

/** The range kept for this person, or 30 days. Storage can be missing or throw (private windows, blocked site data): that is just the default. */
export function loadRange(userId: string | null): StatsRange {
  try {
    const value = window.localStorage.getItem(rangeStorageKey(userId));
    return isStatsRange(value) ? value : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

export function saveRange(userId: string | null, range: StatsRange): void {
  try {
    window.localStorage.setItem(rangeStorageKey(userId), range);
  } catch {
    /* not kept: the range still works for this visit */
  }
}

// ---------------------------------------------------------------------------------------------------------------- change against the period before

export type Trend = 'up' | 'down' | 'same' | 'none';
export interface Change { trend: Trend; /** The size of the change in whole percent (always >= 0); null when there is nothing to compare with. */ percent: number | null }

/** The change from `previous` to `current` in percent, rounded; null when the previous period is empty (a percent of nothing is not a number). */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Up, down or the same (to the whole percent), or none when the previous period is empty. More driving is not good or bad: this says only which way. */
export function changeOf(current: number, previous: number): Change {
  const percent = percentChange(current, previous);
  if (percent === null) return { trend: 'none', percent: null };
  if (percent === 0) return { trend: 'same', percent: 0 };
  return { trend: percent > 0 ? 'up' : 'down', percent: Math.abs(percent) };
}

// ---------------------------------------------------------------------------------------------------------------- days

const dayMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every UTC day from `from` to `to`, both included, oldest first (empty when the range is wrong). Never more than 20,000 days. */
export function daysBetween(from: string, to: string): string[] {
  const start = dayMs(from);
  const end = dayMs(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const count = Math.min(Math.round((end - start) / DAY_MS) + 1, 20_000);
  return Array.from({ length: count }, (_, i) => dayOf(start + i * DAY_MS));
}

/** One value per day of the range (days without laps are 0), for a sparkline or a bar chart. */
export function dailySeries(perDay: readonly V1StatsDay[], from: string, to: string, pick: (day: V1StatsDay) => number): number[] {
  const byDay = new Map(perDay.map((entry) => [entry.day, entry]));
  return daysBetween(from, to).map((day) => {
    const entry = byDay.get(day);
    const value = entry ? pick(entry) : 0;
    return Number.isFinite(value) ? value : 0;
  });
}

/** Adds neighbours together until there are at most `max` values (a year of days becomes a sparkline of a few dozen points). */
export function bucketSeries(values: readonly number[], max: number): number[] {
  if (max < 1) return [];
  if (values.length <= max) return [...values];
  const size = Math.ceil(values.length / max);
  const out: number[] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size).reduce((total, value) => total + value, 0));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- sparkline

export interface SparkPath {
  /** An SVG path (`M x y L x y ...`); empty for none or one point. */
  d: string;
  /** Where the last point is (for a dot); null when there are no points. */
  last: { x: number; y: number } | null;
  points: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The line of a sparkline in a `width` x `height` box with `pad` around it. The scale starts at zero (these are counts and sums), so a
 * quiet week looks quiet; a series of zeros is a flat line along the bottom. No points: nothing. One point: a dot in the middle, no line.
 * Values that are not finite count as zero, so the path never holds NaN or Infinity.
 */
export function sparklinePath(values: readonly number[], width: number, height: number, pad = 2): SparkPath {
  const clean = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  if (clean.length === 0) return { d: '', last: null, points: 0 };
  const top = Math.max(...clean);
  const inner = Math.max(0, height - 2 * pad);
  const y = (value: number) => round1(top <= 0 ? height - pad : height - pad - (value / top) * inner);
  if (clean.length === 1) return { d: '', last: { x: round1(width / 2), y: y(clean[0]) }, points: 1 };
  const step = (width - 2 * pad) / (clean.length - 1);
  const points = clean.map((value, i) => ({ x: round1(pad + i * step), y: y(value) }));
  return { d: points.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' '), last: points[points.length - 1], points: points.length };
}

// ---------------------------------------------------------------------------------------------------------------- the tiles

export type KpiId = 'laps' | 'time' | 'distance' | 'sessions' | 'personalBests' | 'tracksCars';

export interface Kpi {
  id: KpiId;
  current: number;
  previous: number;
  change: Change;
  /** One value per day of the range (at most 40 points), for the sparkline. */
  series: number[];
}

const SPARK_POINTS = 40;
const KPI_SOURCES: Record<KpiId, { total: (totals: V1StatsTotals) => number; day: (day: V1StatsDay) => number }> = {
  laps: { total: (t) => t.laps, day: (d) => d.laps },
  time: { total: (t) => t.timeMs, day: (d) => d.timeMs },
  distance: { total: (t) => t.distanceM, day: (d) => d.distanceM },
  sessions: { total: (t) => t.sessions, day: (d) => d.sessions },
  personalBests: { total: (t) => t.personalBests, day: (d) => d.personalBests },
  tracksCars: { total: (t) => t.tracks + t.cars, day: (d) => d.tracks + d.cars },
};
export const KPI_ORDER: readonly KpiId[] = ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars'];

/** The six tiles of the dashboard: the value for the range, the one before it, the change, and a value per day for the sparkline. */
export function buildKpis(stats: V1Stats): Kpi[] {
  return KPI_ORDER.map((id) => {
    const source = KPI_SOURCES[id];
    const current = source.total(stats.totals);
    const previous = source.total(stats.previous);
    return { id, current, previous, change: changeOf(current, previous), series: bucketSeries(dailySeries(stats.perDay, stats.range.from, stats.range.to, source.day), SPARK_POINTS) };
  });
}

/** The share of laps that are valid, in whole percent; null when there are no laps (a share of nothing). */
export function validShare(totals: Pick<V1StatsTotals, 'laps' | 'validLaps'>): number | null {
  return totals.laps > 0 ? Math.round((totals.validLaps / totals.laps) * 100) : null;
}

// ---------------------------------------------------------------------------------------------------------------- units

/** `4h 12m` (in the person's language): hours and minutes, minutes under an hour, seconds under a minute. */
export function formatDuration(ms: number, locale: string): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const unit = (value: number, name: 'hour' | 'minute' | 'second') => {
    try {
      return new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0 }).format(value);
    } catch {
      return `${value}${name[0]}`;
    }
  };
  if (total < 60_000) return unit(Math.round(total / 1000), 'second');
  const minutes = Math.round(total / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return unit(minutes, 'minute');
  return minutes % 60 === 0 || hours >= 100 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(minutes % 60, 'minute')}`;
}

/** A distance driven in the person's unit (km or mi), one decimal under 100. */
export function formatDistance(meters: number, unit: DistanceUnit, locale: string): string {
  const value = Number.isFinite(meters) && meters > 0 ? (unit === 'mi' ? meters / 1609.344 : meters / 1000) : 0;
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit: unit === 'mi' ? 'mile' : 'kilometer', unitDisplay: 'short', maximumFractionDigits: value < 100 ? 1 : 0 }).format(value);
  } catch {
    return `${Math.round(value)} ${unit}`;
  }
}

/** Seconds of a lap-time gain, three decimals: `-0.412 s` is written by the screen from this `0.412`. */
export const savedSeconds = (savedMs: number): string => (Math.abs(savedMs) / 1000).toFixed(3);

// ---------------------------------------------------------------------------------------------------------------- activity

export interface ActivityPoint { /** First day of the bar (UTC). */ start: string; /** Last day of the bar. */ end: string; laps: number }
export interface Activity { unit: 'day' | 'week'; points: ActivityPoint[]; total: number; busiest: ActivityPoint | null }

/** Laps per day for the range; a range of more than 120 days is read in weeks, so a year is a few dozen bars and not hundreds of slivers. */
export function activityOf(stats: Pick<V1Stats, 'perDay' | 'range'>): Activity {
  const days = daysBetween(stats.range.from, stats.range.to);
  const laps = dailySeries(stats.perDay, stats.range.from, stats.range.to, (d) => d.laps);
  const unit = days.length > 120 ? 'week' : 'day';
  const size = unit === 'week' ? 7 : 1;
  const points: ActivityPoint[] = [];
  for (let i = 0; i < days.length; i += size) {
    const chunk = laps.slice(i, i + size);
    points.push({ start: days[i], end: days[Math.min(i + size, days.length) - 1], laps: chunk.reduce((total, value) => total + value, 0) });
  }
  const total = points.reduce((sum, point) => sum + point.laps, 0);
  const busiest = points.reduce<ActivityPoint | null>((best, point) => (point.laps > 0 && (!best || point.laps > best.laps) ? point : best), null);
  return { unit, points, total, busiest };
}

// ---------------------------------------------------------------------------------------------------------------- heatmap

export interface HeatCell { day: string; laps: number; /** 0 (no laps) to 4 (the busiest days). */ level: 0 | 1 | 2 | 3 | 4 }
export interface HeatGrid {
  /** Columns are weeks (Monday first, oldest first), each with 7 rows Monday to Sunday; a day after today has no cell. */
  weeks: Array<Array<HeatCell | null>>;
  /** The columns where a new month starts (its first week), with the month 0-11 and its year. */
  months: Array<{ col: number; month: number; year: number }>;
  max: number;
  /** Days with laps. */
  active: number;
  total: number;
}

const WEEKDAY = (ms: number) => (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0

/** The calendar of the last 12 months, weeks as columns, ending with the week of `today` (a UTC day); intensity is by laps. */
export function heatmapGrid(days: ReadonlyArray<{ day: string; laps: number }>, today: string): HeatGrid {
  const end = dayMs(today);
  if (!Number.isFinite(end)) return { weeks: [], months: [], max: 0, active: 0, total: 0 };
  const lapsByDay = new Map(days.map((entry) => [entry.day, Math.max(0, Number.isFinite(entry.laps) ? entry.laps : 0)]));
  const first = end - 364 * DAY_MS;
  const gridStart = first - WEEKDAY(first) * DAY_MS;
  const columns = Math.floor((end - gridStart) / (7 * DAY_MS)) + 1;
  let max = 0;
  let active = 0;
  let total = 0;
  for (const [day, laps] of lapsByDay) if (dayMs(day) >= first && dayMs(day) <= end && laps > 0) { max = Math.max(max, laps); active++; total += laps; }
  const weeks: Array<Array<HeatCell | null>> = [];
  const months: HeatGrid['months'] = [];
  for (let col = 0; col < columns; col++) {
    const week: Array<HeatCell | null> = [];
    for (let row = 0; row < 7; row++) {
      const at = gridStart + (col * 7 + row) * DAY_MS;
      if (at > end || at < first) { week.push(null); continue; }
      const day = dayOf(at);
      const laps = lapsByDay.get(day) ?? 0;
      week.push({ day, laps, level: laps <= 0 || max <= 0 ? 0 : (Math.min(4, Math.max(1, Math.ceil((laps / max) * 4))) as HeatCell['level']) });
    }
    weeks.push(week);
    const monday = new Date(gridStart + col * 7 * DAY_MS);
    const previous = months[months.length - 1];
    if (monday.getUTCDate() <= 7 && (!previous || previous.month !== monday.getUTCMonth())) months.push({ col, month: monday.getUTCMonth(), year: monday.getUTCFullYear() });
  }
  return { weeks, months, max, active, total };
}

// ---------------------------------------------------------------------------------------------------------------- sentences, as keys and values

export interface Sentence { /** A key in the locale files (`modes.overview.dash...`). */ key: string; values: Record<string, string | number> }
const K = (name: string) => `modes.overview.dash.${name}`;

/** The streak line: the current run (the key takes a count, for the plural) or "no streak", and the longest one when it is longer than the current. */
export function streakText(streak: { current: number; best: number }): { current: Sentence; best: Sentence | null } {
  const current: Sentence = streak.current > 0 ? { key: K('streakCurrent'), values: { count: streak.current } } : { key: K('streakNone'), values: {} };
  const best: Sentence | null = streak.best > Math.max(streak.current, 1) ? { key: K('streakBest'), values: { count: streak.best } } : null;
  return { current, best };
}

/** The spread of a session in seconds with two decimals (`0.31`). */
export const spreadSeconds = (ms: number): string => (ms / 1000).toFixed(2);

const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;

/**
 * The one sentence under Consistency. The sessions come oldest first; those with a spread (3 or more clean laps) are split into the recent half
 * (at least one) and the ones before. "Your spread is 0.31 s, 12% tighter than before." is `spreadTighter` with `spread` and `percent`; a spread that is
 * about the same (under 1%), looser, or the only one so far each have their own key. Null when no session has a spread. Built from numbers and a key only.
 */
export function spreadSentence(sessions: ReadonlyArray<{ spreadMs: number | null }>): Sentence | null {
  const spreads = sessions.flatMap((session) => (session.spreadMs !== null && Number.isFinite(session.spreadMs) && session.spreadMs >= 0 ? [session.spreadMs] : []));
  if (spreads.length === 0) return null;
  if (spreads.length === 1) return { key: K('spreadOnly'), values: { spread: spreadSeconds(spreads[0]) } };
  const recent = spreads.slice(-Math.max(1, Math.floor(spreads.length / 2)));
  const before = spreads.slice(0, spreads.length - recent.length);
  const now = mean(recent);
  const then = mean(before);
  const spread = spreadSeconds(now);
  if (then <= 0) return { key: K('spreadSame'), values: { spread } };
  const percent = Math.round(((then - now) / then) * 100);
  if (percent === 0) return { key: K('spreadSame'), values: { spread } };
  return percent > 0 ? { key: K('spreadTighter'), values: { spread, percent } } : { key: K('spreadLooser'), values: { spread, percent: -percent } };
}

/** The average share of clean laps (valid and not an in or out lap) over the sessions, in whole percent; null when there are none. */
export function cleanShare(sessions: ReadonlyArray<{ cleanShare: number }>): number | null {
  const shares = sessions.map((session) => session.cleanShare).filter((share) => Number.isFinite(share));
  return shares.length === 0 ? null : Math.round(mean(shares) * 100);
}

// ---------------------------------------------------------------------------------------------------------------- the small multiples

/** The y axis of a best-lap line, in seconds: a little below the fastest day and above the slowest, so small gains show; null under 2 days. */
export function pairRange(bestMs: readonly number[]): { low: number; high: number } | null {
  const seconds = bestMs.filter((value) => Number.isFinite(value) && value > 0).map((value) => value / 1000);
  if (seconds.length < 2) return null;
  const fastest = Math.min(...seconds);
  const slowest = Math.max(...seconds);
  const pad = Math.max(0.3, (slowest - fastest) * 0.15);
  return { low: Math.floor((fastest - pad) * 10) / 10, high: Math.ceil((slowest + pad) * 10) / 10 };
}
