import { detectCorners, matchCorners, type Corner, type CornerOptions, type MatchOptions } from '@/lib/sim/corners';
import type { LapFile } from '@/lib/sim/lap-file';
import { MS_TO_KMH, boxSmooth, fillGaps, lapView, makeGrid, median, round, valueAt, type LapView } from '@/lib/sim/lap-series';

/**
 * Two laps of the same track compared corner by corner. The lap being studied (a) is held against a reference (b).
 * Time is taken from the gap along the distance (how far behind a is at each point), so what a corner cost is the
 * change of the gap across it, and the straights between corners take the rest: corners plus straights add up to the
 * whole-lap difference exactly. Each corner also carries the differences that explain its time, and a likely cause.
 */

export type CornerCause = 'brakesEarly' | 'brakesLate' | 'lowMinSpeed' | 'latePickup' | 'slowExit' | 'wrongGear' | 'line' | 'none';

/** How big a difference must be (relative to the reference) before it counts as a cause. */
export interface CauseThresholds {
  /** Brake point this many meters earlier: brakesEarly. Default 8. */
  brakeEarlyM: number;
  /** Brake point this many meters later, and it cost speed: brakesLate. Default 8. */
  brakeLateM: number;
  /** Minimum speed this much lower (km/h): lowMinSpeed. Default 3. */
  lowMinKmh: number;
  /** Throttle pickup this many meters later: latePickup. Default 10. */
  pickupM: number;
  /** Speed at the end of the corner this much lower (km/h): slowExit. Default 3. */
  exitKmh: number;
  /** The paths are this many meters apart sideways at the apex: line. Default 1.5. */
  lineM: number;
}

export const CAUSE_THRESHOLDS: CauseThresholds = { brakeEarlyM: 8, brakeLateM: 8, lowMinKmh: 3, pickupM: 10, exitKmh: 3, lineM: 1.5 };

export interface CornerCompareOptions {
  detect?: CornerOptions;
  match?: MatchOptions;
  thresholds?: Partial<CauseThresholds>;
  /** A corner whose time differs by less than this (seconds) has no cause to look for. Default 0.02. */
  minDeltaS?: number;
  /** Grid step in meters. Default 2. */
  stepM?: number;
}

export interface CornerDelta {
  /** The corner's number on the reference lap. */
  index: number;
  /** The same corner's number on the studied lap. */
  indexStudy: number;
  /** The stretch of the studied lap the time is measured over: both laps' corner, side by side (meters on the studied lap). */
  startDist: number;
  apexDist: number;
  endDist: number;
  /** Seconds the studied lap lost (+) or gained (-) over this stretch. */
  deltaTime: number;
  /** Everything below is studied minus reference. Speeds in km/h at the stretch's two ends, and the slowest point of each lap. */
  entrySpeedKmh: number;
  minSpeedKmh: number;
  exitSpeedKmh: number;
  /** Meters: + the studied lap brakes later, - earlier. Null when either lap has no braking data for this corner. */
  brakePointM: number | null;
  /** Hardest brake, 0..1. */
  brakePeak: number | null;
  /** Meters with brake and steering together. */
  trailBrakeM: number | null;
  /** Meters: + the throttle comes on later. */
  throttlePickupM: number | null;
  gear: { study: number | null; reference: number | null; differs: boolean | null };
  /** Meters sideways at the apex: + the studied lap is to the left of the reference. Null without positions on both laps. */
  lineOffsetM: number | null;
  /** Why the time was lost. 'none' when it was not lost, or when nothing measured explains it. */
  dominantCause: CornerCause;
  /** 0 to 1, how much to trust `dominantCause`; 0 for 'none'. */
  confidence: number;
  /** Every cause that was strong enough, strongest first, with its strength (1 is the threshold). */
  causes: Array<{ cause: CornerCause; score: number }>;
  /** Data that was missing and so limited the analysis: 'brake', 'throttle', 'position'. */
  missing: Array<'brake' | 'throttle' | 'position'>;
}

export interface StraightDelta {
  fromM: number;
  toM: number;
  /** Seconds lost (+) or gained (-) between the corners. */
  deltaTime: number;
  /** The highest speed on the stretch, km/h, for each lap. */
  topSpeedStudyKmh: number;
  topSpeedReferenceKmh: number;
}

export interface CornerComparison {
  comparable: boolean;
  /** Why not: the laps differ in length by more than 3%, or lack a channel. */
  reason: 'ok' | 'length' | 'channels';
  /** Whole lap, seconds: + the studied lap is slower. */
  lapDelta: number;
  /** The same from the lap times written in the headers. */
  headerDelta: number;
  corners: CornerDelta[];
  straights: StraightDelta[];
  totals: { cornersS: number; straightsS: number; lapS: number; residualS: number };
  unmatchedStudy: Corner[];
  unmatchedReference: Corner[];
  detected: { study: Corner[]; reference: Corner[] };
}

const odd = (points: number) => Math.max(1, Math.round(points) | 1);

/** Order the causes are looked at in: the driving order of a corner. */
const ROOT_ORDER: CornerCause[] = ['brakesEarly', 'brakesLate', 'lowMinSpeed', 'line', 'latePickup', 'wrongGear'];

interface Differences {
  brakePointM: number | null;
  minSpeedKmh: number;
  exitSpeedKmh: number;
  throttlePickupM: number | null;
  gearDiffers: boolean | null;
  lineOffsetM: number | null;
}

function explain(delta: number, d: Differences, th: CauseThresholds, minDeltaS: number, missing: CornerDelta['missing']) {
  const none = { cause: 'none' as CornerCause, confidence: 0, causes: [] as CornerDelta['causes'] };
  if (!(delta >= minDeltaS)) return none;
  const bp = d.brakePointM;
  const pu = d.throttlePickupM;
  const scores: Record<string, number> = {
    brakesEarly: bp !== null && bp < 0 ? -bp / th.brakeEarlyM : 0,
    // Braking later is only a cause when it was paid for: slower in the corner, on the way out, or late on the throttle.
    brakesLate: bp !== null && bp > 0 && (d.minSpeedKmh <= -1 || d.exitSpeedKmh <= -1.5 || (pu !== null && pu >= 5)) ? bp / th.brakeLateM : 0,
    lowMinSpeed: d.minSpeedKmh < 0 ? -d.minSpeedKmh / th.lowMinKmh : 0,
    line: d.lineOffsetM !== null ? Math.abs(d.lineOffsetM) / th.lineM : 0,
    latePickup: pu !== null && pu > 0 ? pu / th.pickupM : 0,
    wrongGear: d.gearDiffers ? 1.2 : 0,
  };
  // A late brake that cost speed is why the minimum is low: it is one cause, not two.
  if (scores.brakesLate >= 1) scores.lowMinSpeed = 0;
  const fired = ROOT_ORDER.filter((c) => scores[c] >= 1);
  const slowExit = d.exitSpeedKmh < 0 ? -d.exitSpeedKmh / th.exitKmh : 0;
  let chosen: CornerCause = 'none';
  let top = 0;
  if (fired.length > 0) {
    const max = Math.max(...fired.map((c) => scores[c]));
    // The strongest cause wins; causes within 0.15 of it are a tie, which the one earlier in the corner takes.
    chosen = fired.find((c) => scores[c] >= max - 0.15) as CornerCause;
    top = scores[chosen];
  } else if (slowExit >= 1) {
    // A slow exit is a symptom: it is the answer only when nothing earlier in the corner explains it.
    chosen = 'slowExit';
    top = slowExit;
  }
  const causes = [...fired.map((cause) => ({ cause, score: scores[cause] })), ...(slowExit >= 1 ? [{ cause: 'slowExit' as CornerCause, score: slowExit }] : [])]
    .sort((p, q) => q.score - p.score || ROOT_ORDER.indexOf(p.cause) - ROOT_ORDER.indexOf(q.cause))
    .map((c) => ({ cause: c.cause, score: round(c.score, 2) }));
  if (chosen === 'none') return { ...none, causes };
  const rival = Math.max(0, ...causes.filter((c) => c.cause !== chosen).map((c) => c.score));
  let confidence = Math.min(1, 0.35 + 0.25 * top) * (1 - (0.5 * Math.min(rival, top)) / top);
  if (missing.length > 0) confidence *= 0.85;
  return { cause: chosen, confidence: round(Math.min(0.95, Math.max(0.2, confidence)), 2), causes };
}

/** The sideways offset (+ left) of lap A from lap B's path around `apex`, meters; the median over ±15 m. */
function lineOffset(grid: Float64Array, a: { x: Float64Array; z: Float64Array }, b: { x: Float64Array; z: Float64Array }, apex: number): number {
  const n = grid.length;
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(grid[i] - apex) > 15) continue;
    const i0 = Math.max(0, i - 1);
    const i1 = Math.min(n - 1, i + 1);
    const tx = b.x[i1] - b.x[i0];
    const tz = b.z[i1] - b.z[i0];
    const length = Math.hypot(tx, tz);
    if (length < 1e-6) continue;
    // The left of the direction of travel is (-tz, tx) with x east and z north.
    offsets.push(((a.x[i] - b.x[i]) * -tz + (a.z[i] - b.z[i]) * tx) / length);
  }
  return median(offsets);
}

function positions(view: LapView, grid: Float64Array, scale: number) {
  if (!view.has('x') || !view.has('z')) return null;
  const x = fillGaps(view.sample('x', grid, scale));
  const z = fillGaps(view.sample('z', grid, scale));
  return x && z ? { x, z } : null;
}

function emptyComparison(reason: 'length' | 'channels'): CornerComparison {
  return {
    comparable: false, reason, lapDelta: 0, headerDelta: 0, corners: [], straights: [],
    totals: { cornersS: 0, straightsS: 0, lapS: 0, residualS: 0 }, unmatchedStudy: [], unmatchedReference: [], detected: { study: [], reference: [] },
  };
}

/**
 * Compares the studied lap `a` with the reference `b`, corner by corner. The laps must be the same track and within 3%
 * in length (the reference is stretched to the studied lap's length so the finish lines meet). Differences are
 * "a minus b"; time is + where a was slower.
 */
export function compareCorners(a: LapFile, b: LapFile, options: CornerCompareOptions = {}): CornerComparison {
  const th: CauseThresholds = { ...CAUSE_THRESHOLDS, ...options.thresholds };
  const minDeltaS = options.minDeltaS ?? 0.02;
  const stepM = options.stepM ?? 2;
  const viewA = lapView(a);
  const viewB = lapView(b);
  const lenA = viewA.length;
  const lenB = viewB.length;
  if (!(lenA > 0) || !(lenB > 0) || !viewA.has('t') || !viewB.has('t') || !viewA.has('speed') || !viewB.has('speed')) return emptyComparison('channels');
  if (Math.abs(lenA - lenB) / Math.max(lenA, lenB) > 0.03) return emptyComparison('length');

  const grid = makeGrid(lenA, stepM);
  const n = grid.length;
  const step = lenA / (n - 1);
  const stretch = lenB / lenA; // meters of the reference per meter of the studied lap
  const toStudy = lenA / lenB; // the other way: a reference distance as a studied one
  const tA = fillGaps(viewA.sample('t', grid));
  const tB = fillGaps(viewB.sample('t', grid, stretch));
  const sA = fillGaps(viewA.sample('speed', grid));
  const sB = fillGaps(viewB.sample('speed', grid, stretch));
  if (!tA || !tB || !sA || !sB) return emptyComparison('channels');
  const speedA = boxSmooth(sA, odd(10 / step));
  const speedB = boxSmooth(sB, odd(10 / step));
  const gap = new Float64Array(n);
  for (let i = 0; i < n; i++) gap[i] = tA[i] - tA[0] - (tB[i] - tB[0]);
  const gapAt = (meters: number) => valueAt(grid, gap, meters);

  const cornersA = detectCorners(a, options.detect);
  const cornersB = detectCorners(b, options.detect);
  const match = matchCorners(cornersB, cornersA, options.match);

  // The stretch of each corner: both laps' corner side by side, trimmed so neighbors never overlap.
  const segs = match.pairs.map((pair) => ({
    pair,
    start: Math.max(0, Math.min(pair.other.startDist, pair.reference.startDist * toStudy)),
    end: Math.min(lenA, Math.max(pair.other.endDist, pair.reference.endDist * toStudy)),
  }));
  for (let s = 1; s < segs.length; s++) {
    if (segs[s].start < segs[s - 1].end) {
      const mid = (segs[s].start + segs[s - 1].end) / 2;
      segs[s].start = mid;
      segs[s - 1].end = mid;
    }
  }

  const posA = positions(viewA, grid, 1);
  const posB = positions(viewB, grid, stretch);
  const corners: CornerDelta[] = segs.map(({ pair, start, end }) => {
    const ca = pair.other;
    const cb = pair.reference;
    const both = <T>(x: T | null, y: T | null, f: (p: T, q: T) => number) => (x !== null && y !== null ? f(x, y) : null);
    const brakePointM = both(ca.brakePointDist, cb.brakePointDist, (p, q) => p - q * toStudy);
    const throttlePickupM = both(ca.throttlePickupDist, cb.throttlePickupDist, (p, q) => p - q * toStudy);
    const missing: CornerDelta['missing'] = [];
    if (ca.brakeSource === null || cb.brakeSource === null) missing.push('brake');
    if (!ca.available.throttle || !cb.available.throttle) missing.push('throttle');
    if (!posA || !posB) missing.push('position');
    const lineOffsetM = posA && posB ? lineOffset(grid, posA, posB, ca.apexDist) : null;
    const gearDiffers = ca.gear !== null && cb.gear !== null ? ca.gear !== cb.gear : null;
    const deltaTime = gapAt(end) - gapAt(start);
    const minSpeedKmh = (ca.minSpeed - cb.minSpeed) * MS_TO_KMH;
    const exitSpeedKmh = (valueAt(grid, speedA, end) - valueAt(grid, speedB, end)) * MS_TO_KMH;
    const verdict = explain(deltaTime, { brakePointM, minSpeedKmh, exitSpeedKmh, throttlePickupM, gearDiffers, lineOffsetM }, th, minDeltaS, missing);
    return {
      index: cb.index,
      indexStudy: ca.index,
      startDist: start,
      apexDist: ca.apexDist,
      endDist: end,
      deltaTime,
      entrySpeedKmh: (valueAt(grid, speedA, start) - valueAt(grid, speedB, start)) * MS_TO_KMH,
      minSpeedKmh,
      exitSpeedKmh,
      brakePointM,
      brakePeak: both(ca.brakePeak, cb.brakePeak, (p, q) => p - q),
      trailBrakeM: both(ca.trailBrakeLength, cb.trailBrakeLength, (p, q) => p - q * toStudy),
      throttlePickupM,
      gear: { study: ca.gear, reference: cb.gear, differs: gearDiffers },
      lineOffsetM,
      dominantCause: verdict.cause,
      confidence: verdict.confidence,
      causes: verdict.causes,
      missing,
    };
  });

  // Everything outside the corners is a straight, so the two kinds of stretch cover the lap exactly.
  const cuts: Array<[number, number]> = [];
  let cursor = 0;
  for (const seg of segs) {
    cuts.push([cursor, seg.start]);
    cursor = seg.end;
  }
  cuts.push([cursor, lenA]);
  const topOver = (view: Float64Array, from: number, to: number) => {
    let top = Math.max(valueAt(grid, view, from), valueAt(grid, view, to));
    for (let i = 0; i < n; i++) if (grid[i] >= from && grid[i] <= to && view[i] > top) top = view[i];
    return top * MS_TO_KMH;
  };
  const straights: StraightDelta[] = cuts
    .filter(([from, to]) => to > from)
    .map(([from, to]) => ({
      fromM: from, toM: to, deltaTime: gapAt(to) - gapAt(from), topSpeedStudyKmh: topOver(speedA, from, to), topSpeedReferenceKmh: topOver(speedB, from, to),
    }));

  const cornersS = corners.reduce((sum, c) => sum + c.deltaTime, 0);
  const straightsS = straights.reduce((sum, s) => sum + s.deltaTime, 0);
  const lapDelta = gap[n - 1] - gap[0];
  return {
    comparable: true,
    reason: 'ok',
    lapDelta,
    headerDelta: (a.header.lap.timeMs - b.header.lap.timeMs) / 1000,
    corners,
    straights,
    totals: { cornersS, straightsS, lapS: lapDelta, residualS: lapDelta - cornersS - straightsS },
    unmatchedStudy: match.unmatchedOther,
    unmatchedReference: match.unmatchedReference,
    detected: { study: cornersA, reference: cornersB },
  };
}

