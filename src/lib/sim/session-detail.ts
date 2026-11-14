// What the session dashboard works out from the laps of one session (the lap list of GET /sessions/<id>, no lap file), as pure functions: the tiles,
// the sort of the laps table, the heat of each sector time, the trend line of the lap chart and the labels a lap carries. Extends session-stats.ts,
// which holds the best lap, the best sectors, the theoretical best and the spread.
import { bestLapOf, bestSectors, consistency, isPitLap, isTimed, theoreticalBest, type ChartRow } from '@/lib/sim/session-stats';
import type { V1Lap } from '@/lib/sim/v1-client';

const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;

export interface SessionKpis {
  best: V1Lap | null;
  /** The mean of the valid laps that were not in or out laps, in ms. */
  averageMs: number | null;
  /** The standard deviation of those laps, in ms (needs 2). */
  spreadMs: number | null;
  /** How many laps there are, and how many the game counted as valid (with a time). */
  laps: number;
  validLaps: number;
  /** Valid laps over all laps, in whole percent; null with no laps. */
  validPercent: number | null;
  /** Valid laps that are not in or out laps over the laps that are not in or out laps, in whole percent. */
  cleanPercent: number | null;
  theoreticalMs: number | null;
  /** How much faster the theoretical best is than the best lap, in ms (>= 0); null when there is no theoretical best. */
  theoreticalGainMs: number | null;
  topSpeedKmh: number | null;
  /** The mean fuel used by a lap that was not an in or out lap, in litres; null when the laps carry no fuel. */
  fuelPerLapL: number | null;
}

/** The flying laps: valid, timed and not through the pits. */
export const flyingLaps = (laps: readonly V1Lap[]): V1Lap[] => laps.filter((lap) => isTimed(lap) && !isPitLap(lap));

export function sessionKpis(laps: readonly V1Lap[]): SessionKpis {
  const best = bestLapOf(laps);
  const flying = flyingLaps(laps);
  const steady = consistency(laps);
  const theoretical = theoreticalBest(bestSectors(laps));
  const speeds = laps.map((lap) => lap.topSpeedKmh).filter((value): value is number => typeof value === 'number' && value > 0);
  const fuel = laps.filter((lap) => !isPitLap(lap)).map((lap) => lap.fuelUsedL).filter((value): value is number => typeof value === 'number' && value > 0);
  const valid = laps.filter(isTimed).length;
  return {
    best,
    averageMs: flying.length > 0 ? mean(flying.map((lap) => lap.timeMs)) : null,
    spreadMs: steady.spreadS !== null ? steady.spreadS * 1000 : null,
    laps: laps.length,
    validLaps: valid,
    validPercent: laps.length > 0 ? Math.round((valid / laps.length) * 100) : null,
    cleanPercent: steady.cleanPercent !== null ? Math.round(steady.cleanPercent) : null,
    theoreticalMs: theoretical,
    theoreticalGainMs: theoretical !== null && best ? Math.max(0, best.timeMs - theoretical) : null,
    topSpeedKmh: speeds.length > 0 ? Math.max(...speeds) : null,
    fuelPerLapL: fuel.length > 0 ? mean(fuel) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------- the laps table

export type LapSortKey = 'lap' | 'time' | 'gap';
export type SortDirection = 'asc' | 'desc';

/**
 * The laps in the order the table asks. By lap number, or by time or gap to the best lap (the same order: the gap is the time minus the best). In the
 * time and gap orders the laps the game voided (and laps with no time) come after the valid ones in either direction, so a voided 1:38 never
 * sits at the top of "fastest first". Ties keep the driving order.
 */
export function sortLaps(laps: readonly V1Lap[], key: LapSortKey, direction: SortDirection): V1Lap[] {
  const sign = direction === 'asc' ? 1 : -1;
  const byNumber = (p: V1Lap, q: V1Lap) => p.lapNumber - q.lapNumber || Date.parse(p.startedAt) - Date.parse(q.startedAt);
  return [...laps].sort((p, q) => {
    if (key === 'lap') return sign * byNumber(p, q);
    const pOk = isTimed(p);
    const qOk = isTimed(q);
    if (pOk !== qOk) return pOk ? -1 : 1;
    if (!pOk) return byNumber(p, q);
    return sign * (p.timeMs - q.timeMs) || byNumber(p, q);
  });
}

export type LapTag = 'best' | 'pb' | 'out' | 'in' | 'void';

/** What a lap is, for the chips of the table: the best of the session, the personal best, an out or in lap, one the game voided. */
export function lapTags(lap: V1Lap, bestId: string | null, pbLapId: string | null): LapTag[] {
  const tags: LapTag[] = [];
  if (bestId === lap.id) tags.push('best');
  if (pbLapId === lap.id) tags.push('pb');
  if (lap.outLap) tags.push('out');
  if (lap.inLap) tags.push('in');
  if (!lap.valid) tags.push('void');
  return tags;
}

/** The gap of a valid lap to the best lap in seconds (0 for the best lap itself); null for a lap the game voided or with no best lap. */
export function gapToBest(lap: V1Lap, best: V1Lap | null): number | null {
  if (!best || !isTimed(lap)) return null;
  return (lap.timeMs - best.timeMs) / 1000;
}

// ---------------------------------------------------------------------------------------------------------------- the sector heat

/** 0 is the best of the session in that sector; 1 to 4 are further and further from it. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface SectorCell {
  /** `none`: no time, or a lap the game voided. `pit`: an in or out lap, whose sector times say little. */
  kind: 'none' | 'pit' | 'time';
  ms: number | null;
  /** The time over the session's best of the sector, in ms (0 for the best). */
  deltaMs: number | null;
  level: HeatLevel | null;
  /** The sector time is the best of the session. */
  best: boolean;
}

/**
 * How far a time is from the best, on the scale of that sector in this session: the slowest of the flying laps is `scaleMs` over the best. A quarter of that
 * is level 1, half level 2, three quarters level 3, more level 4. A session whose laps are all alike (a scale of 0) has no level above 0.
 */
export function heatLevel(deltaMs: number, scaleMs: number): HeatLevel {
  if (deltaMs <= 0) return 0;
  if (scaleMs <= 0) return 1;
  const share = deltaMs / scaleMs;
  return share <= 0.25 ? 1 : share <= 0.5 ? 2 : share <= 0.75 ? 3 : 4;
}

/**
 * The scale of each sector for `heatLevel`: how much slower than the best of the sector the slowest flying lap of the session is (the flying laps within 7 %
 * of the best lap, so a lap with a mistake or a pit lap does not stretch the scale until nothing else has a colour). 0 for a sector with no such lap.
 */
export function sectorScales(laps: readonly V1Lap[], bests: ReadonlyArray<number | null>): number[] {
  const best = bestLapOf(laps);
  const flying = flyingLaps(laps).filter((lap) => !best || lap.timeMs <= best.timeMs * 1.07);
  return bests.map((bestMs, i) => {
    if (bestMs === null) return 0;
    const deltas = flying.map((lap) => lap.sectorsMs?.[i]).filter((ms): ms is number => typeof ms === 'number' && ms > 0).map((ms) => ms - bestMs);
    return deltas.length > 0 ? Math.max(0, ...deltas) : 0;
  });
}

/** A sector time: `32.145` seconds. */
export const sectorText = (ms: number) => (ms / 1000).toFixed(3);

export function sectorCell(lap: V1Lap, index: number, bests: ReadonlyArray<number | null>, scales: readonly number[]): SectorCell {
  const ms = lap.sectorsMs?.[index];
  const best = bests[index];
  if (!lap.valid || typeof ms !== 'number' || ms <= 0) return { kind: 'none', ms: typeof ms === 'number' && ms > 0 ? ms : null, deltaMs: null, level: null, best: false };
  if (isPitLap(lap)) return { kind: 'pit', ms, deltaMs: typeof best === 'number' ? ms - best : null, level: null, best: false };
  if (typeof best !== 'number' || best <= 0) return { kind: 'time', ms, deltaMs: null, level: null, best: false };
  return { kind: 'time', ms, deltaMs: ms - best, level: heatLevel(ms - best, scales[index] ?? 0), best: ms <= best };
}

/** The number of the lap that holds the best of each sector (the earlier lap on a tie); null for a sector no valid lap has. */
export function sectorBestHolders(laps: readonly V1Lap[], bests: ReadonlyArray<number | null>): Array<number | null> {
  return bests.map((best, index) => {
    if (best === null) return null;
    const holder = laps.find((lap) => isTimed(lap) && lap.sectorsMs?.[index] === best);
    return holder ? holder.lapNumber : null;
  });
}

// ---------------------------------------------------------------------------------------------------------------- the chart

export interface Trend {
  /** The fitted time (seconds) at each chart row's lap, or null for a lap outside the span of the flying laps. */
  values: Array<number | null>;
  /** Seconds per lap: negative means the laps are getting faster. */
  slope: number;
}

/**
 * A straight line through the flying laps (valid, not in or out laps) of the chart, by least squares over the lap number: where the driving is heading.
 * Needs 3 such laps; it is drawn over the span of those laps only.
 */
export function lapTrend(rows: readonly ChartRow[]): Trend | null {
  const flying = rows.filter((row) => row.kind !== 'invalid' && row.pit === null);
  if (flying.length < 3) return null;
  const meanX = mean(flying.map((row) => row.lap));
  const meanY = mean(flying.map((row) => row.seconds));
  const denominator = flying.reduce((total, row) => total + (row.lap - meanX) ** 2, 0);
  if (denominator === 0) return null;
  const slope = flying.reduce((total, row) => total + (row.lap - meanX) * (row.seconds - meanY), 0) / denominator;
  const first = flying[0].lap;
  const last = flying[flying.length - 1].lap;
  return { slope, values: rows.map((row) => (row.lap >= first && row.lap <= last ? meanY + slope * (row.lap - meanX) : null)) };
}
