// The numbers and orderings of the track and car screens (the lists and the pages), as pure functions: no React, no `t`, nothing that reads the
// clock or the screen, so every one of them (search, sort, the trend against 30 days ago, the lap-time sparkline, the board of cars, the sector bests
// and the theoretical lap, consistency, the rows of a progress chart) is tested alone. Days are UTC dates (`2026-11-10`), as the API gives them.
import { daysBetween, formatDuration, type SparkPath } from '@/lib/sim/dashboard';
import type { ProgressRow } from '@/lib/sim/progress';
import type { V1CarDetail, V1Lap, V1Pb, V1Ref, V1TrackDetail } from '@/lib/sim/v1-client';

const DAY_MS = 86_400_000;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const dayMs = (day: string) => (Number.isFinite(dayStart(day)) ? dayStart(day) : 0);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today as a UTC day (`2026-11-13`). */
export const utcToday = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------- search and sort

/** A name without accents, case or punctuation, so "Nürburgring" is found by "nurburgring" and "Spa-Francorchamps" by "spa francorchamps". */
export const normalizeName = (text: string | null | undefined): string => (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Every word of the query is somewhere in the name (an empty query matches everything). */
export function matchesSearch(name: string, query: string): boolean {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeName(name);
  return words.every((word) => haystack.includes(word));
}

export type ListSort = 'recent' | 'most' | 'az';
export const LIST_SORTS: readonly ListSort[] = ['recent', 'most', 'az'];
export const isListSort = (value: unknown): value is ListSort => typeof value === 'string' && (LIST_SORTS as readonly string[]).includes(value);

interface Listed { name: string; lapCount: number; lastDrivenAt: string }
const byName = (p: Listed, q: Listed) => p.name.localeCompare(q.name, undefined, { numeric: true, sensitivity: 'base' });
const lastDriven = (item: Listed) => (Number.isFinite(Date.parse(item.lastDrivenAt)) ? Date.parse(item.lastDrivenAt) : 0);

/** The items in the order asked for: most recently driven first, most laps first (the more recent first among equals), or by name. A new array. */
export function sortListed<T extends Listed>(items: readonly T[], sort: ListSort): T[] {
  const copy = [...items];
  if (sort === 'az') return copy.sort(byName);
  if (sort === 'most') return copy.sort((p, q) => q.lapCount - p.lapCount || lastDriven(q) - lastDriven(p) || byName(p, q));
  return copy.sort((p, q) => lastDriven(q) - lastDriven(p) || byName(p, q));
}

// ---------------------------------------------------------------------------------------------------------------- the trend of a personal best

export interface PbTrend {
  /** `faster`: better than 30 days ago; `steady`: the same; `first`: the first valid lap came within the last 30 days; `none`: no valid lap. */
  kind: 'none' | 'first' | 'steady' | 'faster';
  bestMs: number | null;
  /** The best valid lap on the cutoff day or before it; null when there was none. */
  priorMs: number | null;
  /** How much faster than then (ms), for `faster`. */
  gainMs: number | null;
}

/**
 * The best valid lap now against the best valid lap `days` days ago (the fastest of the days up to the cutoff). The best can only get better, so
 * the trend is faster, steady, or "first" when nothing valid was driven yet back then. `today` is a UTC day.
 */
export function pbTrend(bestPerDay: ReadonlyArray<{ day: string; bestMs: number }>, today: string, days = 30): PbTrend {
  const valid = bestPerDay.filter((entry) => Number.isFinite(entry.bestMs) && entry.bestMs > 0);
  if (valid.length === 0) return { kind: 'none', bestMs: null, priorMs: null, gainMs: null };
  const cutoff = dayMs(today) - days * DAY_MS;
  const bestMs = Math.min(...valid.map((entry) => entry.bestMs));
  const before = valid.filter((entry) => dayStart(entry.day) <= cutoff);
  if (before.length === 0) return { kind: 'first', bestMs, priorMs: null, gainMs: null };
  const priorMs = Math.min(...before.map((entry) => entry.bestMs));
  return bestMs < priorMs ? { kind: 'faster', bestMs, priorMs, gainMs: priorMs - bestMs } : { kind: 'steady', bestMs, priorMs, gainMs: null };
}
/** The best valid lap so far at the end of each day (the running minimum), oldest day first: the line of a personal-best sparkline. */
export function runningBest(bestPerDay: ReadonlyArray<{ day: string; bestMs: number }>): number[] {
  const sorted = bestPerDay.filter((entry) => Number.isFinite(entry.bestMs) && entry.bestMs > 0).sort((p, q) => p.day.localeCompare(q.day));
  const out: number[] = [];
  let best = Infinity;
  for (const entry of sorted) {
    best = Math.min(best, entry.bestMs);
    out.push(best);
  }
  return out;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The line of a lap-time sparkline in a `width` x `height` box: the scale is the series' own (a few tenths between the best and the worst fill the
 * box), a faster lap is lower, as on the progress chart. A flat series is a line across the middle; none: nothing; one: a dot in the middle.
 * Values that are not finite or not above zero are left out, so the path never holds NaN or Infinity.
 */
export function timeSparkPath(values: readonly number[], width: number, height: number, pad = 2): SparkPath {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0);
  if (clean.length === 0) return { d: '', last: null, points: 0 };
  const low = Math.min(...clean);
  const high = Math.max(...clean);
  const inner = Math.max(0, height - 2 * pad);
  const y = (value: number) => round1(high === low ? height / 2 : pad + (1 - (value - low) / (high - low)) * inner);
  if (clean.length === 1) return { d: '', last: { x: round1(width / 2), y: round1(height / 2) }, points: 1 };
  const step = (width - 2 * pad) / (clean.length - 1);
  const points = clean.map((value, i) => ({ x: round1(pad + i * step), y: y(value) }));
  return { d: points.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' '), last: points[points.length - 1], points: points.length };
}

/** Laps per day for the last `days` days ending `today` (days without laps are 0), for a sparkline. */
export function lapsPerDaySeries(lapsPerDay: ReadonlyArray<{ day: string; laps: number }>, today: string, days = 30): number[] {
  const end = dayMs(today);
  const byDay = new Map(lapsPerDay.map((entry) => [entry.day, entry.laps]));
  return daysBetween(dayOf(end - (days - 1) * DAY_MS), today).map((day) => {
    const laps = byDay.get(day) ?? 0;
    return Number.isFinite(laps) && laps > 0 ? laps : 0;
  });
}

// ---------------------------------------------------------------------------------------------------------------- lap times as text

/** The gap to a reference as `+0.412` or `-0.412` (seconds, three decimals); `0.000` when there is none. */
export function signedSeconds(ms: number): string {
  if (!Number.isFinite(ms) || Math.round(ms) === 0) return '0.000';
  return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(3)}`;
}

/** A sector time: `31.412` under a minute, `1:05.412` from one. */
export function formatSector(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '–';
  const total = ms / 1000;
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  return minutes > 0 ? `${minutes}:${rest.toFixed(3).padStart(6, '0')}` : rest.toFixed(3);
}

/** Time at the wheel: `2m 34s` under an hour (a handful of laps is minutes, not "3m"), `4h 12m` from one hour on, in the person's language. */
export function formatTimeDriven(ms: number, locale: string): string {
  const total = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (total < 60_000 || total >= 3_600_000) return formatDuration(total, locale);
  const seconds = Math.round(total / 1000);
  const unit = (value: number, name: 'minute' | 'second') => {
    try {
      return new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0 }).format(value);
    } catch {
      return `${value}${name[0]}`;
    }
  };
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? unit(minutes, 'minute') : `${unit(minutes, 'minute')} ${unit(rest, 'second')}`;
}

// ---------------------------------------------------------------------------------------------------------------- laps: what the lap list adds to a page

const isClean = (lap: V1Lap) => lap.valid && lap.timeMs > 0 && lap.inLap !== true && lap.outLap !== true;

const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;
const sampleDeviation = (values: readonly number[]) => {
  const average = mean(values);
  return Math.sqrt(values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1));
};

export interface LapSummary {
  /** The sum of the lap times (a lap with no time counts nothing), ms. */
  timeMs: number;
  /** The mean of the valid laps that are not in or out laps, ms; null when there are none. */
  averageValidMs: number | null;
}

export function summarizeLaps(laps: readonly V1Lap[]): LapSummary {
  const clean = laps.filter(isClean);
  return {
    timeMs: laps.reduce((total, lap) => total + (Number.isFinite(lap.timeMs) && lap.timeMs > 0 ? lap.timeMs : 0), 0),
    averageValidMs: clean.length > 0 ? Math.round(mean(clean.map((lap) => lap.timeMs))) : null,
  };
}

export interface TrackConsistency {
  track: V1Ref;
  /** The valid laps that are not in or out laps. */
  laps: number;
  /** The sample standard deviation of their times, ms; null under 3 laps (a spread of two laps says nothing). */
  spreadMs: number | null;
  bestMs: number;
  averageMs: number;
}

/** How consistent the person is on each track with the laps given (a car's laps): the most laps first. Tracks with no clean lap are left out. */
export function consistencyByTrack(laps: readonly V1Lap[]): TrackConsistency[] {
  const groups = new Map<string, { track: V1Ref; times: number[] }>();
  for (const lap of laps) {
    if (!lap.track || !isClean(lap)) continue;
    const group = groups.get(lap.track.id) ?? { track: lap.track, times: [] };
    group.times.push(lap.timeMs);
    groups.set(lap.track.id, group);
  }
  return [...groups.values()]
    .map(({ track, times }) => ({ track, laps: times.length, spreadMs: times.length >= 3 ? Math.round(sampleDeviation(times)) : null, bestMs: Math.min(...times), averageMs: Math.round(mean(times)) }))
    .sort((p, q) => q.laps - p.laps || p.track.name.localeCompare(q.track.name));
}

/** The rows of a progress chart from a list of laps (the best valid lap of each UTC day and the laps driven), optionally of one car only. */
export function progressFromLaps(laps: readonly V1Lap[], carId: string | null = null): ProgressRow[] {
  const rows = new Map<string, ProgressRow>();
  for (const lap of laps) {
    if (carId !== null && lap.car?.id !== carId) continue;
    const day = lap.startedAt.slice(0, 10);
    if (!Number.isFinite(dayStart(day))) continue;
    const row = rows.get(day) ?? { day, at: dayStart(day), bestS: null, lapId: null, car: null, laps: 0, validLaps: 0 };
    row.laps++;
    if (lap.valid && lap.timeMs > 0) {
      row.validLaps++;
      if (row.bestS === null || lap.timeMs / 1000 < row.bestS) Object.assign(row, { bestS: lap.timeMs / 1000, lapId: lap.id, car: lap.car?.name ?? null });
    }
    rows.set(day, row);
  }
  return [...rows.values()].sort((p, q) => p.at - q.at);
}

/** How many days a progress chart covers and whether it has a line: the chart needs two days to draw anything (one day is a number, not a chart). */
export function progressShape(rows: readonly ProgressRow[]): { days: number; bestPoints: number; best: ProgressRow | null; first: ProgressRow | null; last: ProgressRow | null } {
  const withBest = rows.filter((row) => row.bestS !== null);
  const best = withBest.reduce<ProgressRow | null>((top, row) => (top === null || (row.bestS as number) < (top.bestS as number) ? row : top), null);
  return { days: rows.length, bestPoints: withBest.length, best, first: withBest[0] ?? null, last: withBest[withBest.length - 1] ?? null };
}

// ---------------------------------------------------------------------------------------------------------------- the track page

/** What `GET /tracks/<id>` says about each car (and, for the sectors, `bestSectorsMs` and `sectorLapIds`, as in a personal best). */
export type TrackBestCar = V1TrackDetail['bestPerCar'][number] & { bestSectorsMs?: number[] | null; sectorLapIds?: string[] | null };

export interface BoardRow {
  car: TrackBestCar['car'];
  bestMs: number | null;
  /** Behind the fastest car, ms; 0 for the fastest; null without a valid lap. */
  deltaMs: number | null;
  /** 1 for the fastest; cars with the same time share a rank (1, 2, 2, 4); null without a valid lap. */
  rank: number | null;
  lapCount: number;
  validLapCount: number;
  lapId: string | null;
  achievedAt: string | null;
  sectorsMs: number[] | null;
}

/** The best lap of each car, fastest first, with the gap to the fastest; the cars with no valid lap come last, in the order they were given. */
export function carBoard(cars: readonly TrackBestCar[]): BoardRow[] {
  const timed = cars.filter((car) => car.bestMs !== null && Number.isFinite(car.bestMs) && car.bestMs > 0);
  const untimed = cars.filter((car) => !timed.includes(car));
  const sorted = [...timed].sort((p, q) => (p.bestMs as number) - (q.bestMs as number));
  const fastest = sorted[0]?.bestMs ?? null;
  const row = (car: TrackBestCar, rank: number | null): BoardRow => ({
    car: car.car, bestMs: rank === null ? null : car.bestMs, deltaMs: rank === null || fastest === null ? null : (car.bestMs as number) - fastest, rank,
    lapCount: car.lapCount, validLapCount: car.validLapCount, lapId: car.lapId, achievedAt: car.achievedAt, sectorsMs: car.bestSectorsMs ?? null,
  });
  let previous: { ms: number; rank: number } | null = null;
  const ranked = sorted.map((car, index) => {
    const ms = car.bestMs as number;
    const rank: number = previous !== null && previous.ms === ms ? previous.rank : index + 1;
    previous = { ms, rank };
    return row(car, rank);
  });
  return [...ranked, ...untimed.map((car) => row(car, null))];
}

export interface SectorBest { index: number; ms: number; carId: string; carName: string; lapId: string | null }
export interface SectorBests {
  sectors: SectorBest[];
  /** The sum of the best sectors, ms. */
  theoreticalMs: number;
  /** The best valid lap of the track, ms. */
  bestLapMs: number | null;
  /** How much faster the theoretical lap is than the best lap, ms; null without a best lap (never negative). */
  gainMs: number | null;
}

/**
 * The fastest time in each sector over every lap of every car, and the lap they would add up to. Cars whose sector count differs from the most common
 * one (a layout the game changed) are left out, so sectors of different splits are never mixed. Null when no car has sector times.
 */
export function sectorBests(cars: readonly TrackBestCar[], bestLapMs: number | null): SectorBests | null {
  const usable = cars.filter((car) => Array.isArray(car.bestSectorsMs) && car.bestSectorsMs.length > 0 && car.bestSectorsMs.every((ms) => Number.isFinite(ms) && ms > 0));
  if (usable.length === 0) return null;
  const counts = new Map<number, number>();
  for (const car of usable) counts.set((car.bestSectorsMs as number[]).length, (counts.get((car.bestSectorsMs as number[]).length) ?? 0) + 1);
  const [count] = [...counts.entries()].sort((p, q) => q[1] - p[1] || q[0] - p[0])[0];
  const same = usable.filter((car) => (car.bestSectorsMs as number[]).length === count);
  const sectors: SectorBest[] = Array.from({ length: count }, (_, index) => {
    const winner = same.reduce((top, car) => ((car.bestSectorsMs as number[])[index] < (top.bestSectorsMs as number[])[index] ? car : top));
    return { index, ms: (winner.bestSectorsMs as number[])[index], carId: winner.car.id, carName: winner.car.name, lapId: winner.sectorLapIds?.[index] ?? null };
  });
  const theoreticalMs = sectors.reduce((total, sector) => total + sector.ms, 0);
  const valid = bestLapMs !== null && Number.isFinite(bestLapMs) && bestLapMs > 0;
  return { sectors, theoreticalMs, bestLapMs: valid ? bestLapMs : null, gainMs: valid ? Math.max(0, (bestLapMs as number) - theoreticalMs) : null };
}

/** The car that holds the fastest lap (the one a board and a map are opened for): the first of the board with a valid lap. */
export const fastestCar = (board: readonly BoardRow[]): BoardRow | null => board.find((row) => row.bestMs !== null) ?? null;

// ---------------------------------------------------------------------------------------------------------------- the car page

export interface TrackRow {
  track: V1Ref;
  bestMs: number | null;
  lapCount: number;
  validLapCount: number;
  lapId: string | null;
  achievedAt: string | null;
  /** Behind the best valid lap of the person on the track with any car, ms: 0 when this car holds it; null when either is unknown. */
  deltaToPbMs: number | null;
}

/** The fastest valid lap per track over the personal bests (every car), by track id. */
export function pbByTrack(pbs: readonly Pick<V1Pb, 'track' | 'bestMs'>[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const pb of pbs) if (Number.isFinite(pb.bestMs) && pb.bestMs > 0) best.set(pb.track.id, Math.min(best.get(pb.track.id) ?? Infinity, pb.bestMs));
  return best;
}

/** A car's best lap on each track with the gap to the person's best there; the most driven track first. */
export function trackRows(bestPerTrack: V1CarDetail['bestPerTrack'], pbs: ReadonlyMap<string, number> | null): TrackRow[] {
  return [...bestPerTrack]
    .sort((p, q) => q.lapCount - p.lapCount || p.track.name.localeCompare(q.track.name))
    .map((entry) => {
      const pb = pbs?.get(entry.track.id);
      return {
        track: entry.track, bestMs: entry.bestMs, lapCount: entry.lapCount, validLapCount: entry.validLapCount, lapId: entry.lapId, achievedAt: entry.achievedAt,
        deltaToPbMs: entry.bestMs !== null && pb !== undefined ? Math.max(0, entry.bestMs - pb) : null,
      };
    });
}

/** The track the car was driven on the most (its best lap there is the tile of the page); null without laps. */
export const mostDrivenTrack = (rows: readonly TrackRow[]): TrackRow | null => rows[0] ?? null;

/** The share of laps that are valid, in whole percent; null with no laps. */
export const validPercent = (laps: number, valid: number): number | null => (laps > 0 ? Math.round((Math.min(valid, laps) / laps) * 100) : null);
