import type { V1Lap, V1Pb } from '@/lib/sim/v1-client';

/**
 * What a session page works out from the laps of one session (no lap file is read): the best lap, the best of each sector, the
 * theoretical best lap, the colour of each sector time and how steady the driving was.
 */

/** A lap that counts as a timed lap of the session: the game did not void it and it has a time. */
export const isTimed = (lap: V1Lap): boolean => lap.valid && lap.timeMs > 0;
/** An out or in lap goes through the pits, so its time says little about the driving. */
export const isPitLap = (lap: V1Lap): boolean => lap.inLap === true || lap.outLap === true;

/** The fastest valid lap (the earlier one when two are equal), or null. */
export function bestLapOf(laps: readonly V1Lap[]): V1Lap | null {
  return laps.filter(isTimed).reduce<V1Lap | null>((best, lap) => (best === null || lap.timeMs < best.timeMs ? lap : best), null);
}

/** The fastest time of each sector over the valid laps; `null` for a sector no valid lap has. Empty when no lap has sectors. */
export function bestSectors(laps: readonly V1Lap[]): Array<number | null> {
  const timed = laps.filter((lap) => isTimed(lap) && lap.sectorsMs && lap.sectorsMs.length > 0);
  const count = timed.reduce((most, lap) => Math.max(most, lap.sectorsMs?.length ?? 0), 0);
  return Array.from({ length: count }, (_, i) => {
    const times = timed.map((lap) => lap.sectorsMs?.[i]).filter((ms): ms is number => typeof ms === 'number' && ms > 0);
    return times.length > 0 ? Math.min(...times) : null;
  });
}

/** The sum of the best sectors: the lap that would have been driven by putting them together. Null unless every sector has a best. */
export function theoreticalBest(sectors: ReadonlyArray<number | null>): number | null {
  if (sectors.length === 0 || sectors.some((ms) => ms === null)) return null;
  return (sectors as number[]).reduce((sum, ms) => sum + ms, 0);
}

export type SectorTone = 'purple' | 'green' | 'yellow' | 'none';

/**
 * The colour of one sector time, the usual way:
 *  - purple: the best of the session in that sector;
 *  - green: not that, on the lap that is the person's personal best for this track and car (`/v1/pbs` says which lap it is);
 *  - yellow: slower than that.
 * A sector of a lap the game voided, or one with no time, has no colour.
 */
export function sectorTone(lap: V1Lap, index: number, session: ReadonlyArray<number | null>, pb: Pick<V1Pb, 'lapId'> | null): SectorTone {
  const ms = lap.sectorsMs?.[index];
  if (!lap.valid || typeof ms !== 'number' || ms <= 0) return 'none';
  if (session[index] !== null && session[index] !== undefined && ms <= session[index]) return 'purple';
  if (pb && pb.lapId === lap.id) return 'green';
  return 'yellow';
}

export interface Consistency {
  /** Standard deviation of the valid laps, in seconds (pit laps left out); null with fewer than two such laps. */
  spreadS: number | null;
  /** Share of the laps (pit laps left out) the game did not void, 0 to 100; null with no such laps. */
  cleanPercent: number | null;
  /** The mean of the three fastest valid laps, in ms; null with fewer than three. */
  bestThreeMs: number | null;
}

export function consistency(laps: readonly V1Lap[]): Consistency {
  const driven = laps.filter((lap) => !isPitLap(lap));
  const times = driven.filter(isTimed).map((lap) => lap.timeMs / 1000);
  let spreadS: number | null = null;
  if (times.length >= 2) {
    const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
    spreadS = Math.sqrt(times.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (times.length - 1));
  }
  const fastest = laps.filter(isTimed).map((lap) => lap.timeMs).sort((p, q) => p - q).slice(0, 3);
  return {
    spreadS,
    cleanPercent: driven.length > 0 ? (driven.filter((lap) => lap.valid).length / driven.length) * 100 : null,
    bestThreeMs: fastest.length === 3 ? fastest.reduce((sum, ms) => sum + ms, 0) / 3 : null,
  };
}

/** The laps in the order they were driven. */
export const inDrivingOrder = (laps: readonly V1Lap[]): V1Lap[] =>
  [...laps].sort((p, q) => p.lapNumber - q.lapNumber || Date.parse(p.startedAt) - Date.parse(q.startedAt));

export type LapKind = 'best' | 'valid' | 'invalid';
/** One point of the lap chart. */
export interface ChartRow {
  lap: number;
  seconds: number;
  kind: LapKind;
  /** `out` and `in` laps are marked on the chart. */
  pit: 'out' | 'in' | null;
}

/** One point per timed lap: its number, its time, and what kind of lap it was (the best, valid, or voided by the game). */
export function chartRows(laps: readonly V1Lap[], bestId: string | null): ChartRow[] {
  return laps
    .filter((lap) => lap.timeMs > 0)
    .map((lap) => ({
      lap: lap.lapNumber,
      seconds: lap.timeMs / 1000,
      kind: lap.id === bestId ? 'best' : lap.valid ? 'valid' : 'invalid',
      pit: lap.outLap ? 'out' : lap.inLap ? 'in' : null,
    }));
}

/**
 * The y range: the flying laps decide it, so that their small differences can be read. A slower lap (an out or in lap, a lap
 * with a mistake) that would flatten the chart is drawn at the top edge instead, and says its time.
 */
export function plotRange(rows: readonly ChartRow[]): { low: number; high: number } {
  const flying = rows.filter((row) => row.pit === null);
  const basis = flying.length > 0 ? flying : rows;
  const fastest = Math.min(...basis.map((row) => row.seconds));
  const slowest = Math.max(...basis.map((row) => row.seconds));
  const pad = Math.max(0.3, (slowest - fastest) * 0.15);
  return { low: Math.floor((fastest - pad) * 10) / 10, high: Math.ceil((slowest + pad) * 10) / 10 };
}
