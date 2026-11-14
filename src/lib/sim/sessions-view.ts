// What the Sessions list works out from the sessions the server gave it, as pure functions: the filters kept in the address, the ones the server
// cannot apply (kind, period, "valid laps only": GET /sessions takes game, track and car only), the summary of the filtered set, the days the
// sessions are grouped by, how a session stands against the personal best of its track and car, and the sparkline of a session's lap times.
// No React and no clock: `now` and the time zone are arguments, so each of these is tested alone.
import { isPitLap, isTimed } from '@/lib/sim/session-stats';
import type { V1Lap, V1Pb, V1Session } from '@/lib/sim/v1-client';

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------------------------- the filters

export const SESSION_PERIODS = ['7d', '30d', '90d', '1y'] as const;
export type SessionPeriod = (typeof SESSION_PERIODS)[number];
export const SESSION_KINDS = ['practice', 'qualifying', 'race'] as const;
export type KindFilter = (typeof SESSION_KINDS)[number];
const PERIOD_DAYS: Record<SessionPeriod, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 };

export interface SessionFilters {
  game: string;
  track: string;
  car: string;
  kind: KindFilter | '';
  period: SessionPeriod | '';
  /** Only the sessions with at least one valid lap. */
  validOnly: boolean;
}

export const NO_FILTERS: SessionFilters = { game: '', track: '', car: '', kind: '', period: '', validOnly: false };

export type FilterKey = keyof SessionFilters;

/** The filters an address holds (`?game=&track=&car=&kind=&period=&valid=1`); a value that is not one of ours is no filter. */
export function readFilters(params: URLSearchParams): SessionFilters {
  const kind = params.get('kind');
  const period = params.get('period');
  return {
    game: params.get('game') ?? '',
    track: params.get('track') ?? '',
    car: params.get('car') ?? '',
    kind: (SESSION_KINDS as readonly string[]).includes(kind ?? '') ? (kind as KindFilter) : '',
    period: (SESSION_PERIODS as readonly string[]).includes(period ?? '') ? (period as SessionPeriod) : '',
    validOnly: params.get('valid') === '1',
  };
}

/** The address with one filter changed. A track or a car belongs to one game, so another game starts those over. Everything else in the address is kept. */
export function withFilter(params: URLSearchParams, key: FilterKey, value: string | boolean): URLSearchParams {
  const next = new URLSearchParams(params);
  const name = key === 'validOnly' ? 'valid' : key;
  if (value === '' || value === false) next.delete(name);
  else next.set(name, value === true ? '1' : value);
  if (key === 'game') {
    next.delete('track');
    next.delete('car');
  }
  return next;
}

/** How many filters are on. */
export const activeFilterCount = (filters: SessionFilters): number =>
  [filters.game, filters.track, filters.car, filters.kind, filters.period].filter(Boolean).length + (filters.validOnly ? 1 : 0);

/** The filters the server cannot apply: they are applied to the sessions read so far. */
export const hasClientFilters = (filters: SessionFilters): boolean => !!(filters.kind || filters.period || filters.validOnly);

/** The first moment (epoch ms) a period reaches back to, from `now`. */
export const periodStart = (period: SessionPeriod, now: number): number => now - PERIOD_DAYS[period] * DAY_MS;

/** The sessions that pass the filters the server does not apply. */
export function applyClientFilters(sessions: readonly V1Session[], filters: SessionFilters, now: number): V1Session[] {
  const since = filters.period ? periodStart(filters.period, now) : null;
  return sessions.filter((session) => {
    if (filters.kind && session.kind !== filters.kind) return false;
    if (since !== null && Date.parse(session.startedAt) < since) return false;
    if (filters.validOnly && session.bestLapMs === null) return false;
    return true;
  });
}

/**
 * Whether more pages must be read for the filtered list to be whole. Sessions come newest first, so a period is complete once the oldest session
 * read is older than it; kind and "valid only" cannot be known from a page, so every page is read (the caller caps how many).
 */
export function needsMorePages(filters: SessionFilters, loaded: readonly V1Session[], hasNextPage: boolean, now: number): boolean {
  if (!hasNextPage || !hasClientFilters(filters)) return false;
  if (!filters.kind && !filters.validOnly && filters.period) {
    const oldest = loaded[loaded.length - 1];
    return !oldest || Date.parse(oldest.startedAt) >= periodStart(filters.period, now);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- the summary

export interface SessionsSummary {
  sessions: number;
  laps: number;
  /** The sum of the sessions' lengths (end minus start), in ms. */
  timeMs: number;
  tracks: number;
  cars: number;
  /** The fastest valid lap of the set; null when no session has one. */
  bestLapMs: number | null;
}

export function summarizeSessions(sessions: readonly V1Session[]): SessionsSummary {
  const bests = sessions.flatMap((session) => (session.bestLapMs !== null && session.bestLapMs > 0 ? [session.bestLapMs] : []));
  return {
    sessions: sessions.length,
    laps: sessions.reduce((total, session) => total + Math.max(0, session.lapCount), 0),
    timeMs: sessions.reduce((total, session) => {
      const length = Date.parse(session.endedAt) - Date.parse(session.startedAt);
      return total + (Number.isFinite(length) && length > 0 ? length : 0);
    }, 0),
    tracks: new Set(sessions.map((session) => session.track.id)).size,
    cars: new Set(sessions.map((session) => session.car.id)).size,
    bestLapMs: bests.length > 0 ? Math.min(...bests) : null,
  };
}

/** The one track and car the filters name, when they name both (the summary then shows the best lap there). */
export const singlePair = (filters: Pick<SessionFilters, 'track' | 'car'>): boolean => !!filters.track && !!filters.car;

// ---------------------------------------------------------------------------------------------------------------- days

/** The calendar day (`2026-11-10`) of a moment in a time zone; the UTC day when the zone is not one. */
export function dayKey(ms: number, timeZone?: string): string {
  try {
    // The Swedish locale writes dates as year-month-day, which is what a sortable day key is.
    return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export interface DayGroup { day: string; sessions: V1Session[]; laps: number }

/** The sessions in the order they came (newest first), grouped by the day they started on; each day is one group, newest day first. */
export function groupByDay(sessions: readonly V1Session[], timeZone?: string): DayGroup[] {
  const groups: DayGroup[] = [];
  const byDay = new Map<string, DayGroup>();
  for (const session of sessions) {
    const day = dayKey(Date.parse(session.startedAt), timeZone);
    let group = byDay.get(day);
    if (!group) {
      group = { day, sessions: [], laps: 0 };
      byDay.set(day, group);
      groups.push(group);
    }
    group.sessions.push(session);
    group.laps += Math.max(0, session.lapCount);
  }
  return groups.sort((p, q) => q.day.localeCompare(p.day));
}

/** Whether a day is today, yesterday or another day, given today's key. */
export function dayRelation(day: string, today: string): 'today' | 'yesterday' | 'other' {
  if (day === today) return 'today';
  const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
  return day === yesterday ? 'yesterday' : 'other';
}

// ---------------------------------------------------------------------------------------------------------------- against the personal best

export const pbKey = (trackId: string, carId: string) => `${trackId}|${carId}`;

/** The personal bests by track and car. */
export function pbIndex(pbs: readonly V1Pb[]): Map<string, V1Pb> {
  return new Map(pbs.map((pb) => [pbKey(pb.track.id, pb.car.id), pb]));
}

export type PbStanding =
  /** The session's best lap is the personal best of its track and car. */
  | { kind: 'pb' }
  /** The session's best lap is this much slower than the personal best, in ms. */
  | { kind: 'behind'; deltaMs: number }
  /** No best lap in the session, or no personal best to compare with yet. */
  | { kind: 'none' };

/**
 * How a session's best lap stands against the person's personal best on its track and car: it is "the PB" when it is that time (the personal
 * best is the fastest valid lap of the account, so no session is faster), otherwise how much slower it is.
 */
export function pbStanding(session: Pick<V1Session, 'bestLapMs'>, pb: Pick<V1Pb, 'bestMs' | 'achievedAt'> | null | undefined): PbStanding {
  if (session.bestLapMs === null || session.bestLapMs <= 0 || !pb) return { kind: 'none' };
  const delta = session.bestLapMs - pb.bestMs;
  if (delta <= 0) return { kind: 'pb' };
  return { kind: 'behind', deltaMs: delta };
}

// ---------------------------------------------------------------------------------------------------------------- sparkline of lap times

export interface LapSpark {
  /** An SVG path through the flying laps (valid, not in or out laps); empty under two laps. */
  d: string;
  /** Where the fastest lap is, for a dot; null when there is no lap to draw. */
  best: { x: number; y: number } | null;
  points: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The lap times of a session as a line in a `width` x `height` box. Only flying laps are drawn (a voided lap or a lap through the pits would flatten
 * the rest). The scale is the session's own fastest to slowest (at least half a second), faster at the bottom as on the lap chart, so a session
 * that got quicker slopes down. One lap is a dot; none is nothing.
 */
export function lapSparkPath(laps: readonly V1Lap[], width: number, height: number, pad = 3): LapSpark {
  const flying = laps.filter((lap) => isTimed(lap) && !isPitLap(lap));
  if (flying.length === 0) return { d: '', best: null, points: 0 };
  const times = flying.map((lap) => lap.timeMs);
  const fastest = Math.min(...times);
  const slowest = Math.max(...times);
  const span = Math.max(500, slowest - fastest);
  const middle = (fastest + slowest) / 2;
  const low = middle - span / 2;
  const inner = Math.max(0, height - 2 * pad);
  const y = (ms: number) => round1(pad + (1 - (ms - low) / span) * inner);
  const bestIndex = times.indexOf(fastest);
  if (flying.length === 1) return { d: '', best: { x: round1(width / 2), y: y(times[0]) }, points: 1 };
  const step = (width - 2 * pad) / (flying.length - 1);
  const points = times.map((ms, i) => ({ x: round1(pad + i * step), y: y(ms) }));
  return { d: points.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' '), best: points[bestIndex], points: points.length };
}

/** A session's laps as the list needs them: how many are valid and how many are not, from the lap list. */
export function lapTally(laps: readonly V1Lap[]): { total: number; valid: number } {
  return { total: laps.length, valid: laps.filter((lap) => lap.valid && lap.timeMs > 0).length };
}
