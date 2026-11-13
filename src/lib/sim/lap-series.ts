import { lapLength, sampleAlong } from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';

/**
 * Shared plumbing for the lap analysis modules (corners, comparison, insights): a lap's channels laid on an even
 * grid of distances, gaps filled, smoothed. Pure arithmetic on a lap file; nothing is stored or sent.
 */

export const MS_TO_KMH = 3.6;
export const toKmh = (ms: number): number => ms * MS_TO_KMH;

/** Distances every `stepM` meters from 0 to exactly `lengthM`, at most `maxPoints` of them (the step grows on a very long lap). */
export function makeGrid(lengthM: number, stepM = 2, maxPoints = 12_000): Float64Array {
  if (!(lengthM > 0)) return new Float64Array([0]);
  const count = Math.max(2, Math.min(maxPoints, Math.ceil(lengthM / stepM) + 1));
  const step = lengthM / (count - 1);
  const grid = new Float64Array(count);
  for (let i = 0; i < count; i++) grid[i] = i * step;
  grid[count - 1] = lengthM;
  return grid;
}

/** A lap with its distance column made non-decreasing once, so many channels can be sampled from it cheaply. */
export interface LapView {
  lap: LapFile;
  length: number;
  distance: Float64Array;
  has(id: string): boolean;
  /** The channel at each distance of `grid` (scaled by `scale` first: the grid is in another lap's meters). NaN where the lap has no value. */
  sample(id: string, grid: Float64Array, scale?: number): Float64Array;
  /** The raw sample nearest to `meters` along the lap, or NaN. */
  nearest(id: string, meters: number): number;
}

export function lapView(lap: LapFile): LapView {
  const dist = lap.data.dist;
  const distance = new Float64Array(dist ? dist.length : 0);
  let max = 0;
  for (let i = 0; i < distance.length; i++) {
    const value = dist[i];
    if (Number.isFinite(value) && value > max) max = value;
    distance[i] = max;
  }
  const length = lapLength(lap);
  return {
    lap,
    length,
    distance,
    has: (id) => Boolean(lap.data[id]) && lap.data[id].length > 0,
    sample(id, grid, scale = 1) {
      const column = lap.data[id];
      if (!column || column.length === 0) return new Float64Array(grid.length).fill(Number.NaN);
      const targets = scale === 1 ? Array.from(grid) : Array.from(grid, (g) => g * scale);
      return Float64Array.from(sampleAlong(distance, column, targets));
    },
    nearest(id, meters) {
      const column = lap.data[id];
      const n = distance.length;
      if (!column || n === 0) return Number.NaN;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (distance[mid] < meters) lo = mid + 1;
        else hi = mid;
      }
      const pick = lo > 0 && Math.abs(distance[lo - 1] - meters) <= Math.abs(distance[lo] - meters) ? lo - 1 : lo;
      return column[pick];
    },
  };
}

/** Replaces missing values (NaN) by a straight line between the neighbors that exist, holding the ends. Null when nothing is finite. */
export function fillGaps(values: Float64Array): Float64Array | null {
  const n = values.length;
  let first = -1;
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) { first = i; break; }
  if (first < 0) return null;
  const out = Float64Array.from(values);
  for (let i = 0; i < first; i++) out[i] = out[first];
  let prev = first;
  for (let i = first + 1; i < n; i++) {
    if (Number.isFinite(out[i])) { prev = i; continue; }
    let next = i;
    while (next < n && !Number.isFinite(out[next])) next++;
    if (next >= n) {
      for (let k = i; k < n; k++) out[k] = out[prev];
      break;
    }
    for (let k = i; k < next; k++) out[k] = out[prev] + ((out[next] - out[prev]) * (k - prev)) / (next - prev);
    prev = next;
    i = next;
  }
  return out;
}

/** A moving average of `points` samples (made odd), shrinking at the ends instead of inventing values. */
export function boxSmooth(values: Float64Array, points: number): Float64Array {
  const n = values.length;
  const half = Math.max(0, Math.floor(points / 2));
  if (half === 0 || n === 0) return Float64Array.from(values);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/** The value of a series laid on `grid` at any distance, by a straight line between grid points (clamped at the ends). */
export function valueAt(grid: Float64Array, series: ArrayLike<number>, meters: number): number {
  const n = grid.length;
  if (n === 0) return Number.NaN;
  if (meters <= grid[0]) return series[0];
  if (meters >= grid[n - 1]) return series[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (grid[mid] <= meters) lo = mid;
    else hi = mid;
  }
  const span = grid[hi] - grid[lo];
  if (!(span > 0)) return series[lo];
  const f = (meters - grid[lo]) / span;
  return series[lo] + (series[hi] - series[lo]) * f;
}

export function median(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : Number.NaN;
}

/** Population standard deviation (the spread of the laps that were driven, not an estimate of more laps). */
export function stdDev(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return 0;
  const m = mean(finite);
  return Math.sqrt(finite.reduce((sum, v) => sum + (v - m) * (v - m), 0) / finite.length);
}

/** `value` rounded to `places` decimals, for results that are shown or compared in tests. */
export function round(value: number, places = 3): number {
  const k = 10 ** places;
  return Math.round(value * k) / k;
}
