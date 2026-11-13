import type { LapFile } from '@/lib/sim/lap-file';

/**
 * Sector times of a set of laps of one track and car: the best of each sector, the theoretical best lap (the best
 * sectors joined), how each lap stands in each sector, and the time left on the table. Only valid laps are ever the
 * source of a best. Laps without sectors, with a broken list, or with a different number of sectors than most of the
 * set are left out, and the summary says which and why. Pure arithmetic on numbers; nothing is stored or sent.
 */

/** The part of a lap this needs, so it works on a lap file, a database row or a list of times alike. */
export interface SectorLap {
  id: string;
  timeMs: number;
  valid: boolean;
  /** Version 2 files: the lap began or ended in the pit lane, so its first or last sector is not a whole one. */
  inLap?: boolean;
  outLap?: boolean;
  sectorsMs?: readonly number[] | null;
}

export function sectorLapFrom(lap: LapFile, id: string = String(lap.header.lap.number)): SectorLap {
  const { timeMs, valid, sectorsMs, inLap, outLap } = lap.header.lap;
  return { id, timeMs, valid, sectorsMs: sectorsMs ?? null, ...(inLap !== undefined ? { inLap } : {}), ...(outLap !== undefined ? { outLap } : {}) };
}

export const MIN_SECTORS = 2;
export const MAX_SECTORS = 9;

export type IgnoredReason = 'invalid' | 'pit_lap' | 'no_sectors' | 'bad_sectors' | 'sum_mismatch' | 'count_mismatch';

export interface SectorBest {
  /** 1-based. */
  sector: number;
  ms: number;
  lapId: string;
}

export interface SectorSetStats {
  sector: number;
  bestMs: number;
  /** Average over the laps used. */
  averageMs: number;
  /** Average time lost to the best, over the laps used. */
  averageLossMs: number;
  /** What the best lap of the set lost to the best of this sector. */
  bestLapLossMs: number;
}

export interface SectorSummary {
  /** How many sectors the laps used have; null when no lap could be used. */
  sectorCount: number | null;
  bests: SectorBest[];
  /** The best sectors added up; null when there are none. */
  theoreticalBestMs: number | null;
  /** The fastest of the laps used, and its id. */
  bestLapMs: number | null;
  bestLapId: string | null;
  /** Best lap minus theoretical best: what perfect sectors would take off. */
  potentialGainMs: number | null;
  usedLapIds: string[];
  ignored: Array<{ id: string; reason: IgnoredReason }>;
  perSector: SectorSetStats[];
}

export interface SectorOptions {
  /** A lap whose sectors add up to more than this far from its lap time is left out. Default 250. Not checked when the lap time is 0. */
  toleranceMs?: number;
}

const isWhole = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0;

/** Best sectors, theoretical best and set statistics. The order of `laps` only breaks ties between equal sector times (the first wins). */
export function summarizeSectors(laps: readonly SectorLap[], options: SectorOptions = {}): SectorSummary {
  const { toleranceMs = 250 } = options;
  const ignored: SectorSummary['ignored'] = [];
  const candidates: Array<SectorLap & { sectorsMs: readonly number[] }> = [];
  for (const lap of laps) {
    if (!lap.valid) ignored.push({ id: lap.id, reason: 'invalid' });
    else if (lap.inLap || lap.outLap) ignored.push({ id: lap.id, reason: 'pit_lap' });
    else if (!lap.sectorsMs || lap.sectorsMs.length === 0) ignored.push({ id: lap.id, reason: 'no_sectors' });
    else if (lap.sectorsMs.length < MIN_SECTORS || lap.sectorsMs.length > MAX_SECTORS || !lap.sectorsMs.every(isWhole)) ignored.push({ id: lap.id, reason: 'bad_sectors' });
    else if (lap.timeMs > 0 && Math.abs(lap.sectorsMs.reduce((sum, ms) => sum + ms, 0) - lap.timeMs) > toleranceMs) ignored.push({ id: lap.id, reason: 'sum_mismatch' });
    else candidates.push(lap as SectorLap & { sectorsMs: readonly number[] });
  }

  // The majority sector count wins; on a tie the larger count (more detail).
  const counts = new Map<number, number>();
  for (const lap of candidates) counts.set(lap.sectorsMs.length, (counts.get(lap.sectorsMs.length) ?? 0) + 1);
  let sectorCount: number | null = null;
  for (const [count, howMany] of counts) {
    if (sectorCount === null || howMany > (counts.get(sectorCount) ?? 0) || (howMany === counts.get(sectorCount) && count > sectorCount)) sectorCount = count;
  }
  const used = candidates.filter((lap) => lap.sectorsMs.length === sectorCount);
  for (const lap of candidates) if (lap.sectorsMs.length !== sectorCount) ignored.push({ id: lap.id, reason: 'count_mismatch' });

  if (sectorCount === null || used.length === 0) {
    return { sectorCount: null, bests: [], theoreticalBestMs: null, bestLapMs: null, bestLapId: null, potentialGainMs: null, usedLapIds: [], ignored, perSector: [] };
  }
  const bests: SectorBest[] = [];
  for (let s = 0; s < sectorCount; s++) {
    let best: SectorBest | null = null;
    for (const lap of used) if (!best || lap.sectorsMs[s] < best.ms) best = { sector: s + 1, ms: lap.sectorsMs[s], lapId: lap.id };
    bests.push(best as SectorBest);
  }
  const lapTime = (lap: SectorLap & { sectorsMs: readonly number[] }) => (lap.timeMs > 0 ? lap.timeMs : lap.sectorsMs.reduce((sum, ms) => sum + ms, 0));
  let bestLap = used[0];
  for (const lap of used) if (lapTime(lap) < lapTime(bestLap)) bestLap = lap;
  const theoreticalBestMs = bests.reduce((sum, b) => sum + b.ms, 0);
  const perSector: SectorSetStats[] = bests.map((best, s) => {
    const average = used.reduce((sum, lap) => sum + lap.sectorsMs[s], 0) / used.length;
    return { sector: s + 1, bestMs: best.ms, averageMs: average, averageLossMs: average - best.ms, bestLapLossMs: bestLap.sectorsMs[s] - best.ms };
  });
  return {
    sectorCount,
    bests,
    theoreticalBestMs,
    bestLapMs: lapTime(bestLap),
    bestLapId: bestLap.id,
    potentialGainMs: lapTime(bestLap) - theoreticalBestMs,
    usedLapIds: used.map((lap) => lap.id),
    ignored,
    perSector,
  };
}

export type SectorStatus = 'best-of-set' | 'personal-best' | 'slower';

export interface SectorStanding {
  /** 1-based. */
  sector: number;
  ms: number;
  status: SectorStatus;
  /** This lap's sector minus the best of the set (negative if the lap is not in the set and beat it). */
  deltaToBestMs: number;
  /** Time left on the table in this sector: the loss to the best of the set, never below 0. */
  leftOnTableMs: number;
}

/**
 * How each sector of a lap stands. `best-of-set`: it equals the best sector of the set. `personal-best`: not that,
 * but it equals or beats the driver's own best of that sector (`personalBestSectorsMs`, from any laps, same number of
 * sectors). `slower`: neither. Null when the lap cannot be judged: invalid, a pit lap, no sectors, or not the
 * number of sectors of the set.
 */
export function sectorStandings(lap: SectorLap, summary: SectorSummary, personalBestSectorsMs?: readonly number[] | null): SectorStanding[] | null {
  const sectors = lap.sectorsMs;
  if (!lap.valid || lap.inLap || lap.outLap || !sectors || summary.sectorCount === null || sectors.length !== summary.sectorCount || !sectors.every(isWhole)) return null;
  const personal = personalBestSectorsMs && personalBestSectorsMs.length === sectors.length && personalBestSectorsMs.every(isWhole) ? personalBestSectorsMs : null;
  return sectors.map((ms, s) => {
    const best = summary.bests[s].ms;
    const status: SectorStatus = ms <= best ? 'best-of-set' : personal && ms <= personal[s] ? 'personal-best' : 'slower';
    return { sector: s + 1, ms, status, deltaToBestMs: ms - best, leftOnTableMs: Math.max(0, ms - best) };
  });
}

/** The time a lap left on the table in each sector, and in all: its sectors minus the best of each. Null as for `sectorStandings`. */
export function timeLeftOnTable(lap: SectorLap, summary: SectorSummary): { perSectorMs: number[]; totalMs: number } | null {
  const standings = sectorStandings(lap, summary);
  if (!standings) return null;
  const perSectorMs = standings.map((s) => s.leftOnTableMs);
  return { perSectorMs, totalMs: perSectorMs.reduce((sum, ms) => sum + ms, 0) };
}
