import { compareCorners, type CornerCause, type CornerCompareOptions } from '@/lib/sim/corner-compare';
import { detectCorners, matchCorners, trackCorners, type Corner, type CornerOptions, type TrackCorner } from '@/lib/sim/corners';
import type { LapFile } from '@/lib/sim/lap-file';
import { MS_TO_KMH, mean, median, round, stdDev } from '@/lib/sim/lap-series';

/**
 * What is worth telling a driver about a lap or a session, as data: a kind, where, how many seconds, how many meters
 * or km/h, how serious. No text and no translation here; a screen turns the codes into sentences. The same laps always
 * give the same findings in the same order, and a cause is only named when the data supports it.
 */

export type InsightKind = 'lostInCorner' | 'brakeEarlier' | 'slowerExit' | 'topSpeedLower' | 'inconsistent' | 'sectorGap';
export type InsightSeverity = 'high' | 'medium' | 'low';
/** The causes of the comparison, plus `unknownCause`: time was lost and a channel needed to say why is missing. */
export type InsightCause = CornerCause | 'unknownCause';

export interface Insight {
  kind: InsightKind;
  /** The corner's number on the reference lap; null for a straight or a sector. */
  corner: number | null;
  /** Seconds lost to the reference (+), or for `inconsistent` the spread of the corner's time across the set. */
  seconds: number;
  /** How far, where it is a distance: the brake point moved, the line, the spread of the brake point. */
  meters?: number;
  /** How much, where it is a speed: the minimum, exit or top speed, or the spread of the minimum speed. */
  kmh?: number;
  severity: InsightSeverity;
  /** For findings about a corner: why. */
  cause?: InsightCause;
  /** 0 to 1, for a cause that was named. */
  confidence?: number;
  /** 1-based, for `sectorGap`. */
  sector?: number;
}

export interface InsightOptions {
  /** At most this many findings, and never more than 5. Default 5. */
  max?: number;
  /** A corner or straight must have cost at least this many seconds to be reported. Default 0.05. */
  minSeconds?: number;
  /** A straight counts for `topSpeedLower` when the top speed is this much lower (km/h). Default 4. */
  topSpeedKmh?: number;
  /** ...and the straight is at least this long (meters). Default 150. */
  minStraightM?: number;
  /** A sector gap must be at least this many seconds. Default 0.1. */
  minSectorS?: number;
  /** Other laps of the same track, to look for `inconsistent` corners. At least 3 usable laps are needed. */
  set?: readonly LapFile[];
  /** A corner is inconsistent when its time varies by at least this many seconds (standard deviation). Default 0.08. */
  inconsistentS?: number;
  /** Seconds from which a finding is `high` and `medium`. Defaults 0.3 and 0.12. */
  severity?: { high: number; medium: number };
  compare?: CornerCompareOptions;
}

const KIND_ORDER: InsightKind[] = ['lostInCorner', 'brakeEarlier', 'slowerExit', 'topSpeedLower', 'sectorGap', 'inconsistent'];

const severityOf = (seconds: number, limits: { high: number; medium: number }): InsightSeverity => (seconds >= limits.high ? 'high' : seconds >= limits.medium ? 'medium' : 'low');

const usable = (lap: LapFile) => lap.header.lap.valid && !lap.header.lap.inLap && !lap.header.lap.outLap && lap.header.lap.timeMs > 0;

/** How much one corner varies across laps. */
export interface CornerSpread {
  /** The corner's number in the list the spread was measured against. */
  corner: number;
  /** Laps in which the corner was found. */
  laps: number;
  /** Standard deviation of the time spent in the corner, seconds. */
  timeStdS: number;
  /** Standard deviation of the slowest speed, km/h. */
  minSpeedStdKmh: number;
  /** Standard deviation of the brake point, meters; null when fewer than 2 laps have one. */
  brakePointStdM: number | null;
  /** The corner's time on each lap that has it, in the order of the laps given. */
  times: number[];
}

/** Matches the corners of each lap to `reference` and measures how much each reference corner varies. Corners seen on fewer than 3 laps are left out. */
export function cornerSpreads(perLap: readonly Corner[][], reference: readonly Corner[]): CornerSpread[] {
  const rows = reference.map(() => ({ times: [] as number[], mins: [] as number[], brakes: [] as number[] }));
  const slot = new Map(reference.map((corner, i) => [corner, i]));
  for (const corners of perLap) {
    for (const pair of matchCorners(reference, corners).pairs) {
      const row = rows[slot.get(pair.reference) as number];
      row.times.push(pair.other.timeInCorner);
      row.mins.push(pair.other.minSpeed * MS_TO_KMH);
      if (pair.other.brakePointDist !== null) row.brakes.push(pair.other.brakePointDist);
    }
  }
  const spreads: CornerSpread[] = [];
  reference.forEach((corner, i) => {
    const row = rows[i];
    if (row.times.length < 3) return;
    spreads.push({
      corner: corner.index,
      laps: row.times.length,
      timeStdS: stdDev(row.times),
      minSpeedStdKmh: stdDev(row.mins),
      brakePointStdM: row.brakes.length >= 2 ? stdDev(row.brakes) : null,
      times: row.times,
    });
  });
  return spreads;
}

/**
 * The short list of what to look at when a lap (`study`) is held against a reference: time lost in corners (with the
 * cause), brake points that are too early, slow exits, a lower top speed on a straight, the sector that lost the most,
 * and, given a `set` of laps, the corner the driver is least consistent in. Most important first, at most 5.
 * Without the channel a cause needs (no brake data, say) the finding says `unknownCause` instead of guessing.
 */
export function lapInsights(study: LapFile, reference: LapFile, options: InsightOptions = {}): Insight[] {
  const { minSeconds = 0.05, topSpeedKmh = 4, minStraightM = 150, minSectorS = 0.1, inconsistentS = 0.08 } = options;
  const limits = options.severity ?? { high: 0.3, medium: 0.12 };
  const max = Math.max(0, Math.min(5, options.max ?? 5));
  const cmp = compareCorners(study, reference, options.compare);
  if (!cmp.comparable) return [];
  const found: Insight[] = [];

  for (const c of cmp.corners) {
    if (!(c.deltaTime >= minSeconds)) continue;
    const cause: InsightCause = c.dominantCause !== 'none' ? c.dominantCause : c.missing.length > 0 ? 'unknownCause' : 'none';
    const base = { corner: c.index, seconds: round(c.deltaTime), severity: severityOf(c.deltaTime, limits), cause, ...(c.dominantCause !== 'none' ? { confidence: c.confidence } : {}) };
    if (c.dominantCause === 'brakesEarly' && c.brakePointM !== null) found.push({ kind: 'brakeEarlier', ...base, meters: round(-c.brakePointM, 1) });
    else if (c.dominantCause === 'slowExit') found.push({ kind: 'slowerExit', ...base, kmh: round(-c.exitSpeedKmh, 1) });
    else if (c.dominantCause === 'brakesLate' && c.brakePointM !== null) found.push({ kind: 'lostInCorner', ...base, meters: round(c.brakePointM, 1), kmh: round(-c.minSpeedKmh, 1) });
    else if (c.dominantCause === 'lowMinSpeed') found.push({ kind: 'lostInCorner', ...base, kmh: round(-c.minSpeedKmh, 1) });
    else if (c.dominantCause === 'latePickup' && c.throttlePickupM !== null) found.push({ kind: 'lostInCorner', ...base, meters: round(c.throttlePickupM, 1) });
    else if (c.dominantCause === 'line' && c.lineOffsetM !== null) found.push({ kind: 'lostInCorner', ...base, meters: round(Math.abs(c.lineOffsetM), 1) });
    else found.push({ kind: 'lostInCorner', ...base });
  }

  for (const s of cmp.straights) {
    const deficit = s.topSpeedReferenceKmh - s.topSpeedStudyKmh;
    if (s.toM - s.fromM >= minStraightM && deficit >= topSpeedKmh && s.deltaTime >= minSeconds) {
      found.push({ kind: 'topSpeedLower', corner: null, seconds: round(s.deltaTime), kmh: round(deficit, 1), severity: severityOf(s.deltaTime, limits) });
    }
  }

  const sa = study.header.lap.sectorsMs;
  const sb = reference.header.lap.sectorsMs;
  if (sa && sb && sa.length === sb.length && sa.length >= 2 && study.header.lap.valid && reference.header.lap.valid) {
    let worst = 0;
    for (let i = 1; i < sa.length; i++) if (sa[i] - sb[i] > sa[worst] - sb[worst]) worst = i;
    if ((sa[worst] - sb[worst]) / 1000 >= minSectorS) {
      const seconds = (sa[worst] - sb[worst]) / 1000;
      found.push({ kind: 'sectorGap', corner: null, sector: worst + 1, seconds: round(seconds), severity: severityOf(seconds, limits) });
    }
  }

  const set = (options.set ?? []).filter(usable);
  if (set.length >= 3) {
    const perLap = set.map((lap) => detectCorners(lap, options.compare?.detect));
    const spreads = cornerSpreads(perLap, cmp.detected.reference);
    let worst: CornerSpread | null = null;
    for (const spread of spreads) if (!worst || spread.timeStdS > worst.timeStdS) worst = spread;
    if (worst && worst.timeStdS >= inconsistentS) {
      found.push({
        kind: 'inconsistent', corner: worst.corner, seconds: round(worst.timeStdS), severity: severityOf(worst.timeStdS, limits), kmh: round(worst.minSpeedStdKmh, 1),
        ...(worst.brakePointStdM !== null ? { meters: round(worst.brakePointStdM, 1) } : {}),
      });
    }
  }

  found.sort((p, q) =>
    q.seconds - p.seconds
    || KIND_ORDER.indexOf(p.kind) - KIND_ORDER.indexOf(q.kind)
    || (p.corner ?? Infinity) - (q.corner ?? Infinity)
    || (p.sector ?? 0) - (q.sector ?? 0));
  return found.slice(0, max);
}

export interface SessionConsistency {
  /** Valid laps that were not pit laps and within `cleanThreshold` of the best. */
  lapsConsidered: number;
  /** Valid laps left out for being much slower than the best (traffic, a mistake, a slow lap). */
  lapsExcluded: number;
  bestMs: number;
  averageMs: number;
  medianMs: number;
  stdDevMs: number;
  /** Slowest considered lap minus the best. */
  spreadMs: number;
  /** How many considered laps were within 1% of the best. */
  withinOnePercent: number;
}

export interface BestVsAverage {
  /** The corner's number in `corners`. */
  corner: number;
  /** Average time of the other laps in the corner minus the best lap's: seconds the best lap gained there. */
  seconds: number;
  /** The best lap's brake point minus the others' average (meters, + later); null when either is missing. */
  brakePointM: number | null;
  /** The best lap's slowest speed minus the others' average, km/h. */
  minSpeedKmh: number;
}

export interface SessionInsights {
  consistency: SessionConsistency | null;
  /** The corners the laps were measured on, numbered in driving order. */
  corners: TrackCorner[];
  /** Every corner's spread across the laps, the most variable first. */
  cornerSpreads: CornerSpread[];
  /** The corner the driver varies most in (by the standard deviation of the time spent in it). */
  mostVariableCorner: CornerSpread | null;
  /** Where the best lap beat the average of the others, the largest gain first. Needs 3 or more laps. */
  bestVsAverage: BestVsAverage[];
  biggestGain: BestVsAverage | null;
  bestLapIndex: number | null;
}

export interface SessionInsightOptions {
  /** Valid laps slower than this multiple of the best are left out. Default 1.07. */
  cleanThreshold?: number;
  detect?: CornerOptions;
}

/**
 * What a session of laps (one track and car) says: how consistent the valid laps are, the corner the driver varies
 * most in, and where the best lap beat the average. Invalid laps and in- and out-laps are never counted.
 * `bestLapIndex` is the position of the best lap in the array given.
 */
export function sessionInsights(laps: readonly LapFile[], options: SessionInsightOptions = {}): SessionInsights {
  const { cleanThreshold = 1.07 } = options;
  const empty: SessionInsights = { consistency: null, corners: [], cornerSpreads: [], mostVariableCorner: null, bestVsAverage: [], biggestGain: null, bestLapIndex: null };
  const candidates = laps.map((lap, index) => ({ lap, index })).filter(({ lap }) => usable(lap));
  if (candidates.length === 0) return empty;
  const bestMs = Math.min(...candidates.map(({ lap }) => lap.header.lap.timeMs));
  const clean = candidates.filter(({ lap }) => lap.header.lap.timeMs <= bestMs * cleanThreshold);
  const times = clean.map(({ lap }) => lap.header.lap.timeMs);
  const consistency: SessionConsistency = {
    lapsConsidered: clean.length,
    lapsExcluded: candidates.length - clean.length,
    bestMs,
    averageMs: mean(times),
    medianMs: median(times),
    stdDevMs: stdDev(times),
    spreadMs: Math.max(...times) - bestMs,
    withinOnePercent: times.filter((ms) => ms <= bestMs * 1.01).length,
  };
  const bestEntry = clean.reduce((best, entry) => (entry.lap.header.lap.timeMs < best.lap.header.lap.timeMs ? entry : best), clean[0]);

  const corners = trackCorners(clean.map(({ lap }) => lap), options.detect);
  if (corners.length === 0 || clean.length < 3) return { ...empty, consistency, corners, bestLapIndex: bestEntry.index };
  const perLap = clean.map(({ lap }) => detectCorners(lap, options.detect));
  const spreads = cornerSpreads(perLap, corners).sort((p, q) => q.timeStdS - p.timeStdS || p.corner - q.corner);

  // The best lap against the average of the others, corner by corner.
  const bestCorners = perLap[clean.indexOf(bestEntry)];
  const others = perLap.filter((_, i) => clean[i] !== bestEntry);
  const best = matchCorners(corners, bestCorners).pairs;
  const gains: BestVsAverage[] = [];
  const otherPairs = others.map((corners_) => matchCorners(corners, corners_).pairs);
  for (const pair of best) {
    const mates = otherPairs.map((pairs) => pairs.find((p) => p.reference === pair.reference)?.other).filter((c): c is Corner => Boolean(c));
    if (mates.length < 2) continue;
    const brakes = mates.map((c) => c.brakePointDist).filter((v): v is number => v !== null);
    gains.push({
      corner: pair.reference.index,
      seconds: mean(mates.map((c) => c.timeInCorner)) - pair.other.timeInCorner,
      brakePointM: pair.other.brakePointDist !== null && brakes.length > 0 ? pair.other.brakePointDist - mean(brakes) : null,
      minSpeedKmh: (pair.other.minSpeed - mean(mates.map((c) => c.minSpeed))) * MS_TO_KMH,
    });
  }
  gains.sort((p, q) => q.seconds - p.seconds || p.corner - q.corner);
  return {
    consistency,
    corners,
    cornerSpreads: spreads,
    mostVariableCorner: spreads[0] ?? null,
    bestVsAverage: gains,
    biggestGain: gains[0] ?? null,
    bestLapIndex: bestEntry.index,
  };
}
