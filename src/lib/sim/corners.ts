import type { LapFile } from '@/lib/sim/lap-file';
import { MS_TO_KMH, boxSmooth, fillGaps, lapView, makeGrid, mean, median, valueAt } from '@/lib/sim/lap-series';

/**
 * Corners found in the speed trace of one lap, and what the driver did in each (brake point, trail braking, throttle
 * pickup, direction, gear). Speed is the only channel required; every other channel only adds the fields that need it.
 * Distances are meters along the lap, speeds are m/s (the unit of the channel). docs/platform/ANALYSIS.md explains it all.
 */

export interface CornerOptions {
  /** A corner is a speed minimum at least this far below the speeds before and after it, within `windowM`. Default 15. */
  minDropKmh?: number;
  /** How far before and after the minimum the higher speeds are looked for. Default 400. */
  windowM?: number;
  /** Minima closer than this are one corner. Default 60. */
  minSeparationM?: number;
  /** Two minima stay one corner (a chicane) while the speed between them recovers no more than this. Default 10. */
  chicaneRecoveryKmh?: number;
  /** Chicane minima further apart than this are separate corners. Default 200. */
  chicaneMaxM?: number;
  /** The speed trace is averaged over this length before minima are looked for. Default 20. */
  smoothingM?: number;
  /** Lighter averaging used for the speeds that are reported. Default 10. */
  measureSmoothM?: number;
  /** Wiggles smaller than this in the smoothed trace are noise, not a dip. Default 3. */
  noiseKmh?: number;
  /** The corner starts where the speed has fallen by this share of the drop (at least 1.5 km/h). Default 0.1. */
  startDropFraction?: number;
  /** The corner ends where the speed has recovered this share of the way back up. Default 0.6. */
  endRecoveryFraction?: number;
  /** Brake pedal (0..1) above which the car is braking. Default 0.1. */
  brakeOn?: number;
  /** |steer| (0..1) above which the car is turning. Default 0.04. */
  steerOn?: number;
  /** Throttle (0..1) that counts as picking the throttle up. Default 0.5. */
  throttlePickup?: number;
  /** Without a brake channel, a deceleration (g_long, in g) harder than this counts as braking. Default 0.3. */
  gLongBrake?: number;
  /** Grid step in meters (it grows on a very long lap). Default 2. */
  stepM?: number;
}

export const CORNER_DEFAULTS: Required<CornerOptions> = {
  minDropKmh: 15,
  windowM: 400,
  minSeparationM: 60,
  chicaneRecoveryKmh: 10,
  chicaneMaxM: 200,
  smoothingM: 20,
  measureSmoothM: 10,
  noiseKmh: 3,
  startDropFraction: 0.1,
  endRecoveryFraction: 0.6,
  brakeOn: 0.1,
  steerOn: 0.04,
  throttlePickup: 0.5,
  gLongBrake: 0.3,
  stepM: 2,
};

export type CornerDirection = 'left' | 'right';

export interface Corner {
  /** 1-based, in driving order. */
  index: number;
  startDist: number;
  apexDist: number;
  endDist: number;
  /** m/s at `startDist`. */
  entrySpeed: number;
  /** m/s, the slowest point of the corner. */
  minSpeed: number;
  /** m/s at `endDist`. */
  exitSpeed: number;
  /** Where braking began. Null when the lap has no brake channel (nor g_long) or the driver did not brake for this corner. */
  brakePointDist: number | null;
  /** Hardest brake (0..1) of that braking; null without a brake channel. */
  brakePeak: number | null;
  /** Which channel said where braking began: the pedal (`brake`) or the deceleration (`g_long`). Null: neither exists. */
  brakeSource: 'brake' | 'g_long' | null;
  /** Meters with the brake and the steering both on; null when either channel is missing. */
  trailBrakeLength: number | null;
  /** Where the throttle passes 0.5 after the apex (the apex itself if it is already above); null if missing or never. */
  throttlePickupDist: number | null;
  direction: CornerDirection | null;
  /** The gear at the apex. */
  gear: number | null;
  /** Seconds from `startDist` to `endDist`. */
  timeInCorner: number;
  /** Two speed minima were merged into this corner (a chicane or a double apex). */
  chicane: boolean;
  /** The length of the lap this was found on, and where the apex is as a share of it: what laps are matched on. */
  lapLengthM: number;
  apexFraction: number;
  /** Which channels there were to work with. */
  available: { brake: boolean; throttle: boolean; steer: boolean; position: boolean };
}

interface Pivot { i: number; kind: 'min' | 'max' }

/** The turning points of a series, ignoring every swing smaller than `swing`. */
function zigzag(v: Float64Array, swing: number): Pivot[] {
  const pivots: Pivot[] = [];
  let dir = 0;
  let lo = 0;
  let hi = 0;
  let cand = 0;
  for (let i = 1; i < v.length; i++) {
    const x = v[i];
    if (dir === 0) {
      if (x > v[hi]) hi = i;
      if (x < v[lo]) lo = i;
      if (x - v[lo] >= swing) { pivots.push({ i: lo, kind: 'min' }); dir = 1; cand = i; }
      else if (v[hi] - x >= swing) { pivots.push({ i: hi, kind: 'max' }); dir = -1; cand = i; }
    } else if (dir === 1) {
      if (x > v[cand]) cand = i;
      else if (v[cand] - x >= swing) { pivots.push({ i: cand, kind: 'max' }); dir = -1; cand = i; }
    } else {
      if (x < v[cand]) cand = i;
      else if (x - v[cand] >= swing) { pivots.push({ i: cand, kind: 'min' }); dir = 1; cand = i; }
    }
  }
  if (dir !== 0) pivots.push({ i: cand, kind: dir === 1 ? 'max' : 'min' });
  return pivots;
}

/** The first index of the highest value in `from..to`. */
function argmax(values: Float64Array, from: number, to: number): number {
  let best = from;
  for (let i = from + 1; i <= to; i++) if (values[i] > values[best]) best = i;
  return best;
}

const odd = (points: number) => Math.max(1, Math.round(points) | 1);
const nanToZero = (series: Float64Array) => series.map((x) => (Number.isFinite(x) ? x : 0));

interface Span { first: number; last: number; apex: number; apexPos: number; start: number; end: number }

/** The run of braking in `series` (values at or above `threshold`) that ends closest to `hi`, no earlier than `lo`; gaps up to `gapPts` stay inside a run. */
function brakeRun(series: Float64Array, grid: Float64Array, threshold: number, lo: number, hi: number, gapPts: number) {
  let last = -1;
  for (let j = Math.min(hi, series.length - 1); j >= lo; j--) if (series[j] >= threshold) { last = j; break; }
  if (last < 0) return null;
  let onset = last;
  for (let k = last - 1; k >= lo; k--) {
    if (series[k] >= threshold) onset = k;
    else if (onset - k > gapPts) break;
  }
  let dist = grid[onset];
  if (onset > lo && series[onset - 1] < threshold) {
    const before = series[onset - 1];
    const span = series[onset] - before;
    if (span > 0) dist = grid[onset - 1] + ((threshold - before) / span) * (grid[onset] - grid[onset - 1]);
  }
  let peak = 0;
  for (let k = onset; k <= last; k++) if (series[k] > peak) peak = series[k];
  return { onset, last, dist, peak };
}

/** Where a series rises through `level` between grid points `j` and `j + 1` (v[j] < level <= v[j + 1]). */
function crossingUp(grid: Float64Array, v: Float64Array, j: number, level: number): number {
  const span = v[j + 1] - v[j];
  return span > 0 ? grid[j] + ((level - v[j]) / span) * (grid[j + 1] - grid[j]) : grid[j + 1];
}

/** Where a series falls through `level` between grid points `j` and `j + 1` (v[j] >= level > v[j + 1]). */
function crossingDown(grid: Float64Array, v: Float64Array, j: number, level: number): number {
  const span = v[j] - v[j + 1];
  return span > 0 ? grid[j] + ((v[j] - level) / span) * (grid[j + 1] - grid[j]) : grid[j];
}

/** The corners of one lap. Empty when the lap has no speed to work from. Deterministic. */
export function detectCorners(lap: LapFile, options: CornerOptions = {}): Corner[] {
  const o: Required<CornerOptions> = { ...CORNER_DEFAULTS };
  for (const key of Object.keys(options) as Array<keyof CornerOptions>) if (options[key] !== undefined) o[key] = options[key] as number;

  const view = lapView(lap);
  const length = view.length;
  if (!(length > 0) || !view.has('speed')) return [];
  const grid = makeGrid(length, o.stepM);
  const n = grid.length;
  if (n < 10) return [];
  const step = length / (n - 1);
  const pts = (meters: number) => Math.max(1, Math.round(meters / step));
  const gridDist = (pos: number) => {
    const lo = Math.max(0, Math.min(n - 2, Math.floor(pos)));
    return grid[lo] + (grid[lo + 1] - grid[lo]) * (pos - lo);
  };

  const raw = fillGaps(view.sample('speed', grid));
  if (!raw) return [];
  const heavy = boxSmooth(raw, odd(o.smoothingM / step));
  const light = boxSmooth(raw, odd(o.measureSmoothM / step));
  const drop = o.minDropKmh / MS_TO_KMH;
  const wN = pts(o.windowM);

  // 1. Valleys of the smoothed trace that are deep enough on both sides.
  const pivots = zigzag(heavy, o.noiseKmh / MS_TO_KMH);
  const valleys: number[] = [];
  for (let k = 1; k < pivots.length - 1; k++) {
    if (pivots[k].kind !== 'min') continue;
    const v = pivots[k].i;
    const left = heavy[argmax(heavy, Math.max(0, v - wN), v)];
    const right = heavy[argmax(heavy, v, Math.min(n - 1, v + wN))];
    if (left - heavy[v] >= drop && right - heavy[v] >= drop) valleys.push(v);
  }
  if (valleys.length === 0) return [];

  // 2. Valleys that are too close, or that the speed hardly recovers between, are one corner.
  const groups: number[][] = [];
  for (const v of valleys) {
    const group = groups[groups.length - 1];
    if (group) {
      const prev = group[group.length - 1];
      const separation = (v - prev) * step;
      const recovery = heavy[argmax(heavy, prev, v)] - Math.max(heavy[prev], heavy[v]);
      if (separation < o.minSeparationM || (separation <= o.chicaneMaxM && recovery <= o.chicaneRecoveryKmh / MS_TO_KMH)) {
        group.push(v);
        continue;
      }
    }
    groups.push([v]);
  }

  // 3. Where each corner starts and ends: from the speed level before it falls to the level it has recovered to.
  const spans: Span[] = groups.map((group, gi) => {
    const first = group[0];
    const last = group[group.length - 1];
    let deepest = first;
    for (const v of group) if (heavy[v] < heavy[deepest]) deepest = v;
    let l = deepest;
    let r = deepest;
    const plateau = heavy[deepest] + 0.7 / MS_TO_KMH;
    while (l > 0 && heavy[l - 1] <= plateau) l--;
    while (r < n - 1 && heavy[r + 1] <= plateau) r++;
    const prevLast = gi > 0 ? groups[gi - 1][groups[gi - 1].length - 1] : 0;
    const nextFirst = gi < groups.length - 1 ? groups[gi + 1][0] : n - 1;
    const leftLimit = Math.max(prevLast, first - wN);
    const rightLimit = Math.min(nextFirst, last + wN);
    const peakIn = argmax(heavy, leftLimit, first);
    const peakOut = argmax(heavy, last, rightLimit);
    const apexSpeed = heavy[deepest];

    const startLevel = heavy[peakIn] - Math.max(o.startDropFraction * (heavy[peakIn] - apexSpeed), 1.5 / MS_TO_KMH);
    let j = first;
    while (j > leftLimit && heavy[j] < startLevel) j--;
    const start = j < first && heavy[j] >= startLevel ? crossingDown(grid, heavy, j, startLevel) : grid[j];

    const endLevel = apexSpeed + o.endRecoveryFraction * (Math.min(heavy[peakIn], heavy[peakOut]) - apexSpeed);
    let k = last;
    while (k < peakOut && heavy[k] < endLevel) k++;
    const end = k > last ? crossingUp(grid, heavy, k - 1, endLevel) : grid[k];
    return { first, last, apex: deepest, apexPos: (l + r) / 2, start, end };
  });
  // Neighbors never overlap: where two would, they meet halfway.
  for (let s = 1; s < spans.length; s++) {
    if (spans[s].start < spans[s - 1].end) {
      const mid = (spans[s].start + spans[s - 1].end) / 2;
      spans[s].start = mid;
      spans[s - 1].end = mid;
    }
  }

  // 4. What the driver did, from the channels there are.
  const brakeColumn = view.has('brake') ? nanToZero(view.sample('brake', grid)) : null;
  const gLong = !brakeColumn && view.has('g_long') ? view.sample('g_long', grid).map((g) => (Number.isFinite(g) ? Math.max(0, -g) : 0)) : null;
  const steer = view.has('steer') ? nanToZero(view.sample('steer', grid)) : null;
  const throttle = view.has('throttle') ? nanToZero(view.sample('throttle', grid)) : null;
  const px = view.has('x') && view.has('z') ? fillGaps(view.sample('x', grid)) : null;
  const pz = px ? fillGaps(view.sample('z', grid)) : null;
  const position = px && pz ? { x: px, z: pz } : null;
  let clock = view.has('t') ? fillGaps(view.sample('t', grid)) : null;
  if (!clock) {
    clock = new Float64Array(n);
    for (let i = 1; i < n; i++) clock[i] = clock[i - 1] + (grid[i] - grid[i - 1]) / Math.max(1, raw[i]);
  }
  const available = { brake: Boolean(brakeColumn || gLong), throttle: Boolean(throttle), steer: Boolean(steer), position: Boolean(position) };
  const gapPts = pts(10);

  return spans.map((span, ci): Corner => {
    const apexDist = gridDist(span.apexPos);
    const apexIdx = Math.max(0, Math.min(n - 1, Math.round(span.apexPos)));
    const from = Math.max(0, Math.min(span.first, apexIdx) - pts(12));
    const to = Math.min(n - 1, Math.max(span.last, apexIdx) + pts(12));
    let minSpeed = Infinity;
    for (let i = from; i <= to; i++) if (light[i] < minSpeed) minSpeed = light[i];

    const prevLast = ci > 0 ? spans[ci - 1].last : 0;
    const leftLimit = Math.max(prevLast, span.first - wN);
    const brakeSeries = brakeColumn ?? gLong;
    const run = brakeSeries ? brakeRun(brakeSeries, grid, brakeColumn ? o.brakeOn : o.gLongBrake, leftLimit, span.first + pts(6), gapPts) : null;
    let trail: number | null = null;
    if (brakeColumn && steer) {
      trail = 0;
      if (run) for (let i = run.onset; i <= run.last; i++) if (brakeColumn[i] >= o.brakeOn && Math.abs(steer[i]) >= o.steerOn) trail += step;
    }

    const anchor = span.first === span.last ? apexIdx : span.last;
    let pickup: number | null = null;
    if (throttle) {
      if (throttle[anchor] >= o.throttlePickup) pickup = grid[anchor];
      else {
        const limit = ci < spans.length - 1 ? spans[ci + 1].first : n - 1;
        const hold = pts(10);
        for (let j = anchor + 1; j <= limit; j++) {
          if (throttle[j] < o.throttlePickup) continue;
          let stays = true;
          for (let k = j; k < Math.min(n, j + hold); k++) if (throttle[k] < o.throttlePickup) { stays = false; break; }
          if (!stays) continue;
          const before = throttle[j - 1];
          const rise = throttle[j] - before;
          pickup = rise > 0 ? grid[j - 1] + ((o.throttlePickup - before) / rise) * (grid[j] - grid[j - 1]) : grid[j];
          break;
        }
      }
    }

    let direction: CornerDirection | null = null;
    if (steer) {
      const avg = mean(Array.from(steer.subarray(Math.max(0, apexIdx - 5), Math.min(n - 1, apexIdx + 5) + 1)));
      if (Math.abs(avg) >= 0.03) direction = avg > 0 ? 'right' : 'left';
    }
    if (!direction && position) {
      const at = (meters: number) => [valueAt(grid, position.x, meters), valueAt(grid, position.z, meters)] as const;
      const [x0, z0] = at(apexDist - 45);
      const [x1, z1] = at(apexDist);
      const [x2, z2] = at(apexDist + 45);
      const ax = x1 - x0;
      const az = z1 - z0;
      const bx = x2 - x1;
      const bz = z2 - z1;
      const sine = (ax * bz - az * bx) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
      // x east and z north: a positive cross product is a turn to the left.
      if (Math.abs(sine) >= 0.02) direction = sine > 0 ? 'left' : 'right';
    }

    const gearRaw = view.nearest('gear', apexDist);
    return {
      index: ci + 1,
      startDist: span.start,
      apexDist,
      endDist: span.end,
      entrySpeed: valueAt(grid, light, span.start),
      minSpeed,
      exitSpeed: valueAt(grid, light, span.end),
      brakePointDist: run ? run.dist : null,
      brakePeak: brakeColumn ? (run ? run.peak : 0) : null,
      brakeSource: brakeColumn ? 'brake' : gLong ? 'g_long' : null,
      trailBrakeLength: trail,
      throttlePickupDist: pickup,
      direction,
      gear: Number.isFinite(gearRaw) ? Math.round(gearRaw) : null,
      timeInCorner: valueAt(grid, clock, span.end) - valueAt(grid, clock, span.start),
      chicane: span.first !== span.last,
      lapLengthM: length,
      apexFraction: apexDist / length,
      available,
    };
  });
}

export interface MatchOptions {
  /** How far apart (meters, on the reference lap) two corners may be and still be the same one. Default 40, or 1% of the lap if more. */
  toleranceM?: number;
  /** Laps whose lengths differ by more than this share are not matched at all. Default 0.03. */
  lengthTolerance?: number;
}

export interface CornerPair {
  reference: Corner;
  other: Corner;
  /** Meters apart, on the reference lap's length. */
  offsetM: number;
}

export interface CornerMatch {
  pairs: CornerPair[];
  unmatchedReference: Corner[];
  unmatchedOther: Corner[];
}

/**
 * Pairs the corners of two laps of the same track by where they are along the lap (as a share of the lap, so laps
 * a little different in length still line up). Pairs keep the driving order, and a corner that has no partner within
 * the tolerance (a lap that found an extra corner, or missed one) is left unmatched rather than paired with a wrong one.
 */
export function matchCorners(reference: readonly Corner[], other: readonly Corner[], options: MatchOptions = {}): CornerMatch {
  const { toleranceM = 40, lengthTolerance = 0.03 } = options;
  const none: CornerMatch = { pairs: [], unmatchedReference: [...reference], unmatchedOther: [...other] };
  if (reference.length === 0 || other.length === 0) return none;
  const lengthA = reference[0].lapLengthM;
  const lengthB = other[0].lapLengthM;
  if (!(lengthA > 0) || !(lengthB > 0) || Math.abs(lengthA - lengthB) / Math.max(lengthA, lengthB) > lengthTolerance) return none;

  const tolerance = Math.max(toleranceM, 0.01 * lengthA);
  const a = [...reference].sort((x, y) => x.apexFraction - y.apexFraction);
  const b = [...other].sort((x, y) => x.apexFraction - y.apexFraction);
  const offset = (i: number, j: number) => Math.abs(a[i].apexFraction - b[j].apexFraction) * lengthA;
  const pairValue = (i: number, j: number) => {
    const d = offset(i, j);
    return d <= tolerance ? 2 - d / tolerance : Number.NEGATIVE_INFINITY;
  };

  // The best order-preserving pairing: the most pairs, then the smallest total offset.
  const score: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      score[i][j] = Math.max(pairValue(i, j) + score[i + 1][j + 1], score[i + 1][j], score[i][j + 1]);
    }
  }
  const pairs: CornerPair[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const take = pairValue(i, j) + score[i + 1][j + 1];
    if (take === score[i][j] && take > score[i + 1][j] && take > score[i][j + 1]) {
      pairs.push({ reference: a[i], other: b[j], offsetM: offset(i, j) });
      usedA.add(i);
      usedB.add(j);
      i++;
      j++;
    } else if (score[i + 1][j] >= score[i][j + 1]) i++;
    else j++;
  }
  return { pairs, unmatchedReference: a.filter((_, k) => !usedA.has(k)), unmatchedOther: b.filter((_, k) => !usedB.has(k)) };
}

export interface TrackCornersOptions extends CornerOptions {
  /** Corners of different laps closer than this (meters) are the same corner. Default 40, or 1% of the lap if more. */
  toleranceM?: number;
  /** A corner must be found on at least this share of the laps to count. Default 0.5. */
  minSupport?: number;
}

/** A corner of the track as a set of laps saw it: positions and numbers are medians. */
export interface TrackCorner extends Corner {
  /** On how many laps it was found, out of `lapsUsed`. */
  support: number;
  lapsUsed: number;
}

const medianOrNull = (values: Array<number | null>): number | null => {
  const m = median(values.filter((v): v is number => v !== null));
  return Number.isFinite(m) ? m : null;
};

/**
 * One stable list of corners for a set of laps of the same track: corners are found on every lap, the ones at the
 * same place are grouped, and each group is reported at the median position. Laps whose length is not within 3% of
 * the median length are ignored, and so are corners found on fewer than `minSupport` of the laps. Numbered 1.. in driving order.
 */
export function trackCorners(laps: readonly LapFile[], options: TrackCornersOptions = {}): TrackCorner[] {
  const { toleranceM = 40, minSupport = 0.5, ...detect } = options;
  const lengths = laps.map((lap) => lapView(lap).length).filter((l) => l > 0);
  if (lengths.length === 0) return [];
  const medianLength = median(lengths);
  const perLap = laps
    .filter((lap) => Math.abs(lapView(lap).length - medianLength) / medianLength <= 0.03)
    .map((lap) => detectCorners(lap, detect));
  const used = perLap.length;
  if (used === 0) return [];

  const flat = perLap.flatMap((corners, lapIndex) => corners.map((corner) => ({ lapIndex, corner })));
  flat.sort((x, y) => x.corner.apexFraction - y.corner.apexFraction || x.lapIndex - y.lapIndex);
  const tolerance = Math.max(toleranceM, 0.01 * medianLength) / medianLength;
  const clusters: Array<typeof flat> = [];
  for (const item of flat) {
    const cluster = clusters[clusters.length - 1];
    if (cluster && item.corner.apexFraction - cluster[cluster.length - 1].corner.apexFraction <= tolerance) cluster.push(item);
    else clusters.push([item]);
  }

  const result: TrackCorner[] = [];
  for (const cluster of clusters) {
    // One corner per lap: the one nearest the middle of the group.
    const mid = median(cluster.map((c) => c.corner.apexFraction));
    const byLap = new Map<number, Corner>();
    for (const { lapIndex, corner } of cluster) {
      const held = byLap.get(lapIndex);
      if (!held || Math.abs(corner.apexFraction - mid) < Math.abs(held.apexFraction - mid)) byLap.set(lapIndex, corner);
    }
    const members = [...byLap.values()];
    if (members.length < Math.max(1, Math.ceil(minSupport * used))) continue;
    const pos = (pick: (c: Corner) => number) => median(members.map((c) => pick(c) / c.lapLengthM)) * medianLength;
    const num = (pick: (c: Corner) => number) => median(members.map(pick));
    const nullable = (pick: (c: Corner) => number | null) => medianOrNull(members.map(pick));
    const along = (pick: (c: Corner) => number | null) => {
      const m = medianOrNull(members.map((c) => { const v = pick(c); return v === null ? null : v / c.lapLengthM; }));
      return m === null ? null : m * medianLength;
    };
    const lefts = members.filter((c) => c.direction === 'left').length;
    const rights = members.filter((c) => c.direction === 'right').length;
    const gear = nullable((c) => c.gear);
    const first = members[0];
    result.push({
      index: 0,
      startDist: pos((c) => c.startDist),
      apexDist: pos((c) => c.apexDist),
      endDist: pos((c) => c.endDist),
      entrySpeed: num((c) => c.entrySpeed),
      minSpeed: num((c) => c.minSpeed),
      exitSpeed: num((c) => c.exitSpeed),
      brakePointDist: along((c) => c.brakePointDist),
      brakePeak: nullable((c) => c.brakePeak),
      brakeSource: first.brakeSource,
      trailBrakeLength: nullable((c) => c.trailBrakeLength),
      throttlePickupDist: along((c) => c.throttlePickupDist),
      direction: lefts === rights ? null : lefts > rights ? 'left' : 'right',
      gear: gear === null ? null : Math.round(gear),
      timeInCorner: num((c) => c.timeInCorner),
      chicane: members.filter((c) => c.chicane).length * 2 > members.length,
      lapLengthM: medianLength,
      apexFraction: median(members.map((c) => c.apexFraction)),
      available: first.available,
      support: members.length,
      lapsUsed: used,
    });
  }
  result.sort((x, y) => x.apexFraction - y.apexFraction);
  result.forEach((corner, k) => { corner.index = k + 1; });
  return result;
}
