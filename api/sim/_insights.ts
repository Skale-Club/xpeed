// A session's insights from what is stored about its laps (times, validity, in and out laps, sector times), with no lap file read.
// GET /api/sim/v1/sessions/<id>/insights (docs/platform/API-V1.md). It is the cheap summary: the corner analysis needs the files, and
// the site does that itself when this says nothing. Pure: the handler passes the laps of `sim_v1_session` in.

/** The fields of a lap (API Lap object) this reads. */
export interface InsightLap {
  id: string;
  lapNumber: number;
  timeMs: number;
  valid: boolean;
  inLap: boolean | null;
  outLap: boolean | null;
  sectorsMs: number[] | null;
}

/** A session needs this many usable laps before consistency and the sector spread are said. */
export const MIN_LAPS = 3;
/** Laps slower than this multiple of the best are left out of the averages (traffic, a mistake): the same rule as the site's analysis. */
export const CLEAN_THRESHOLD = 1.07;
/** What is not worth a finding (milliseconds): below these the numbers are noise. */
export const MIN_SECTOR_GAIN_MS = 50;
export const MIN_SECTOR_SPREAD_MS = 100;
export const MIN_CONSISTENCY_MS = 150;

export type InsightFinding =
  | { kind: 'sectorGain'; sector: number; gainMs: number; lapId: string }
  | { kind: 'sectorSpread'; sector: number; stdDevMs: number; laps: number }
  | { kind: 'consistency'; stdDevMs: number; laps: number };

export interface SessionInsightsAnswer {
  sessionId: string;
  source: 'metadata';
  /** Valid, timed laps that were not in or out laps. */
  lapsUsed: number;
  /** Of those, the ones within 7 % of the best: what the averages are taken over. */
  lapsConsidered: number;
  summary: {
    bestLapMs: number | null;
    bestLapId: string | null;
    averageMs: number | null;
    /** Sample standard deviation of the considered laps; null with fewer than 3. */
    consistencyMs: number | null;
    /** Null when no usable lap has sectors. */
    sectors: null | {
      count: number;
      /** The fastest time of each sector over the usable laps that have `count` sectors, and the lap that holds it. */
      bestMs: number[];
      bestLapIds: string[];
      /** How much the best lap's sector is slower than the best of that sector, per sector. */
      gainMs: number[];
      /** The best lap with each sector at its best, and how much faster that is than the best lap. */
      theoreticalBestMs: number;
      theoreticalGainMs: number;
      /** Standard deviation of each sector over the considered laps; null with fewer than 3 such laps. */
      spreadMs: number[] | null;
      /** The sector that varies most (1-based) and by how much; null when `spreadMs` is. */
      widest: { sector: number; stdDevMs: number } | null;
    };
  };
  /** The two most useful things to work on, in this order of priority: sector gain, sector spread, consistency. Empty when nothing is worth saying. */
  findings: InsightFinding[];
}

const timed = (lap: InsightLap) => lap.valid && lap.timeMs > 0;
const pit = (lap: InsightLap) => lap.inLap === true || lap.outLap === true;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const stdDev = (values: number[]): number | null => {
  if (values.length < MIN_LAPS) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};
const hasSectors = (lap: InsightLap): lap is InsightLap & { sectorsMs: number[] } =>
  Array.isArray(lap.sectorsMs) && lap.sectorsMs.length > 0 && lap.sectorsMs.every((ms) => Number.isFinite(ms) && ms > 0);

/** The sector count most laps have (the larger one wins a tie), or 0. */
function majorityCount(laps: Array<InsightLap & { sectorsMs: number[] }>): number {
  const tally = new Map<number, number>();
  for (const lap of laps) tally.set(lap.sectorsMs.length, (tally.get(lap.sectorsMs.length) ?? 0) + 1);
  let best = 0, seen = 0;
  for (const [count, laps] of tally) if (laps > seen || (laps === seen && count > best)) { best = count; seen = laps; }
  return best;
}

export function insightsFromLaps(sessionId: string, laps: readonly InsightLap[]): SessionInsightsAnswer {
  const usable = laps.filter((lap) => timed(lap) && !pit(lap));
  // The fastest lap; the earlier one when two are equal.
  const best = usable.reduce<InsightLap | null>((found, lap) => (found === null || lap.timeMs < found.timeMs || (lap.timeMs === found.timeMs && lap.lapNumber < found.lapNumber) ? lap : found), null);
  const considered = best ? usable.filter((lap) => lap.timeMs <= best.timeMs * CLEAN_THRESHOLD) : [];
  const answer: SessionInsightsAnswer = {
    sessionId, source: 'metadata', lapsUsed: usable.length, lapsConsidered: considered.length,
    summary: {
      bestLapMs: best?.timeMs ?? null, bestLapId: best?.id ?? null,
      averageMs: considered.length > 0 ? Math.round(mean(considered.map((lap) => lap.timeMs))) : null,
      consistencyMs: null, sectors: null,
    },
    findings: [],
  };
  if (!best) return answer;
  const std = stdDev(considered.map((lap) => lap.timeMs));
  answer.summary.consistencyMs = std === null ? null : Math.round(std);

  const withSectors = usable.filter(hasSectors);
  const count = majorityCount(withSectors);
  const sectorLaps = withSectors.filter((lap) => lap.sectorsMs.length === count);
  if (count > 0 && sectorLaps.length > 0) {
    const bestMs: number[] = [], bestLapIds: string[] = [];
    for (let i = 0; i < count; i++) {
      // The fastest sector; the earlier lap holds it on a tie.
      const holder = sectorLaps.reduce((found, lap) => (lap.sectorsMs[i] < found.sectorsMs[i] || (lap.sectorsMs[i] === found.sectorsMs[i] && lap.lapNumber < found.lapNumber) ? lap : found));
      bestMs.push(holder.sectorsMs[i]);
      bestLapIds.push(holder.id);
    }
    const fastest = sectorLaps.reduce((found, lap) => (lap.timeMs < found.timeMs || (lap.timeMs === found.timeMs && lap.lapNumber < found.lapNumber) ? lap : found));
    const gainMs = bestMs.map((ms, i) => fastest.sectorsMs[i] - ms);
    const theoreticalGainMs = gainMs.reduce((sum, ms) => sum + ms, 0);
    const spreads = Array.from({ length: count }, (_, i) => stdDev(considered.filter((lap) => hasSectors(lap) && lap.sectorsMs.length === count).map((lap) => lap.sectorsMs![i])));
    const spreadMs = spreads.every((value) => value !== null) ? spreads.map((value) => Math.round(value as number)) : null;
    let widest: { sector: number; stdDevMs: number } | null = null;
    if (spreadMs) for (let i = 0; i < spreadMs.length; i++) if (widest === null || spreadMs[i] > (widest as { stdDevMs: number }).stdDevMs) widest = { sector: i + 1, stdDevMs: spreadMs[i] };
    answer.summary.sectors = { count, bestMs, bestLapIds, gainMs, theoreticalBestMs: fastest.timeMs - theoreticalGainMs, theoreticalGainMs, spreadMs, widest };
  }

  // The findings are only made when the session is long enough to say anything.
  if (usable.length < MIN_LAPS) return answer;
  const found: InsightFinding[] = [];
  const sectors = answer.summary.sectors;
  let gainSector = 0;
  if (sectors) {
    const biggest = sectors.gainMs.reduce((at, ms, i) => (ms > sectors.gainMs[at] ? i : at), 0);
    if (sectors.gainMs[biggest] >= MIN_SECTOR_GAIN_MS) {
      gainSector = biggest + 1;
      found.push({ kind: 'sectorGain', sector: gainSector, gainMs: sectors.gainMs[biggest], lapId: sectors.bestLapIds[biggest] });
    }
    if (sectors.widest && sectors.widest.stdDevMs >= MIN_SECTOR_SPREAD_MS && sectors.widest.sector !== gainSector) {
      found.push({ kind: 'sectorSpread', sector: sectors.widest.sector, stdDevMs: sectors.widest.stdDevMs, laps: considered.length });
    }
  }
  if (answer.summary.consistencyMs !== null && answer.summary.consistencyMs >= MIN_CONSISTENCY_MS) {
    found.push({ kind: 'consistency', stdDevMs: answer.summary.consistencyMs, laps: considered.length });
  }
  answer.findings = found.slice(0, 2);
  return answer;
}
