import type { LapFile } from '@/lib/sim/lap-file';

/**
 * Looking at laps. Two laps are compared by where the car is on the track, not by the clock: both
 * are resampled onto the same grid of distances, and the gap is the difference in the time each one
 * took to get there. Everything here is plain arithmetic on a lap file; nothing is stored or sent.
 */

/** Evenly spaced distances in meters, from 0 to exactly `lengthM`: a point every 2 m, at most `maxPoints`. */
export function distanceGrid(lengthM: number, maxPoints = 1200): number[] {
  if (!(lengthM > 0)) return [0];
  const count = Math.max(2, Math.min(maxPoints, Math.ceil(lengthM / 2) + 1));
  const step = lengthM / (count - 1);
  const grid = Array.from({ length: count }, (_, i) => i * step);
  grid[count - 1] = lengthM;
  return grid;
}

/** The distance column as a non-decreasing series: a sample that goes back (or is missing) repeats the last good one. */
function nondecreasing(values: ArrayLike<number>): Float64Array {
  const out = new Float64Array(values.length);
  let max = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (Number.isFinite(value) && value > max) max = value;
    out[i] = max;
  }
  return out;
}

/**
 * The value of a channel at each distance of `grid`, by linear interpolation. `distance` must be non-decreasing.
 * Before the first sample the first value holds; past the last sample there is no value (NaN). A sample the game
 * did not give (NaN) stays NaN, and so does anything interpolated against it.
 */
export function sampleAlong(distance: Float64Array, values: ArrayLike<number>, grid: number[]): number[] {
  const n = distance.length;
  const out = new Array<number>(grid.length).fill(Number.NaN);
  if (n === 0) return out;
  let j = 0;
  for (let g = 0; g < grid.length; g++) {
    const d = grid[g];
    if (d > distance[n - 1] + 1e-6) continue;
    // j becomes the last sample at or before d; flat stretches (a stopped car) collapse onto it.
    while (j + 1 < n && distance[j + 1] <= d) j++;
    if (j === n - 1 || distance[j + 1] === distance[j]) {
      out[g] = values[j];
      continue;
    }
    const fraction = (d - distance[j]) / (distance[j + 1] - distance[j]);
    const a = values[j];
    const b = values[j + 1];
    out[g] = fraction <= 0 ? a : fraction >= 1 ? b : a + (b - a) * fraction;
  }
  return out;
}

/** How far around the track the lap goes, in meters (the largest distance it recorded). */
export function lapLength(lap: LapFile): number {
  const dist = lap.data.dist;
  let max = 0;
  for (let i = 0; i < dist.length; i++) if (Number.isFinite(dist[i]) && dist[i] > max) max = dist[i];
  return max;
}

/** Channels of a lap on a common grid; a channel the lap does not have is all NaN. */
export function resampleLap(lap: LapFile, ids: readonly string[], grid: number[]): Record<string, number[]> {
  const distance = nondecreasing(lap.data.dist);
  const out: Record<string, number[]> = {};
  for (const id of ids) {
    const column = lap.data[id];
    out[id] = column ? sampleAlong(distance, column, grid) : new Array<number>(grid.length).fill(Number.NaN);
  }
  return out;
}

/** Whether two laps can be compared: the same game and track, and the same length within 3%. */
export function comparable(a: LapFile, b: LapFile): boolean {
  if (a.header.game !== b.header.game) return false;
  if (a.header.track.name.trim().toLowerCase() !== b.header.track.name.trim().toLowerCase()) return false;
  const [la, lb] = [lapLength(a), lapLength(b)];
  return la > 0 && lb > 0 && Math.abs(la - lb) / Math.max(la, lb) <= 0.03;
}

/** The gap at each point: positive means lap A took longer to get there than the reference B (A is behind). */
export function gapSeries(timeA: number[], timeB: number[]): number[] {
  return timeA.map((value, i) => value - timeB[i]);
}

export interface Stretch {
  fromM: number;
  toM: number;
  /** How much the gap grew (positive: A lost time) or shrank (negative: A gained) over the stretch. */
  seconds: number;
}

/**
 * Where the gap changes most. The lap is cut into stretches of `windowM` meters; the ones where A lost the
 * most time and the ones where it gained the most are returned, largest first. Changes under `minSeconds` are noise.
 */
export function timeChanges(grid: number[], gap: number[], options: { windowM?: number; minSeconds?: number; count?: number } = {}) {
  const { windowM = 150, minSeconds = 0.01, count = 3 } = options;
  const length = grid[grid.length - 1] ?? 0;
  const step = grid.length > 1 ? grid[1] - grid[0] : 0;
  const stretches: Stretch[] = [];
  if (step > 0) {
    const at = (meters: number) => Math.min(grid.length - 1, Math.max(0, Math.round(meters / step)));
    for (let from = 0; from < length; from += windowM) {
      const to = Math.min(from + windowM, length);
      if (to - from < windowM / 2) break;
      const [before, after] = [gap[at(from)], gap[at(to)]];
      if (Number.isFinite(before) && Number.isFinite(after)) stretches.push({ fromM: from, toM: to, seconds: after - before });
    }
  }
  return {
    losses: stretches.filter((s) => s.seconds >= minSeconds).sort((x, y) => y.seconds - x.seconds).slice(0, count),
    gains: stretches.filter((s) => s.seconds <= -minSeconds).sort((x, y) => x.seconds - y.seconds).slice(0, count),
  };
}

export interface LapStats {
  distanceM: number;
  durationS: number;
  topSpeedMs: number;
  averageSpeedMs: number;
  /** Share of the samples with the throttle (almost) fully open, 0 to 1. */
  fullThrottleShare: number;
  /** Share of the samples with the brake pressed, 0 to 1. */
  brakingShare: number;
}

function finite(values: ArrayLike<number> | undefined): number[] {
  return values ? Array.from(values).filter(Number.isFinite) : [];
}

export function lapStats(lap: LapFile): LapStats {
  const t = finite(lap.data.t);
  const speed = finite(lap.data.speed);
  const throttle = finite(lap.data.throttle);
  const brake = finite(lap.data.brake);
  const distanceM = lapLength(lap);
  const durationS = t.length ? t[t.length - 1] - t[0] : 0;
  return {
    distanceM,
    durationS,
    topSpeedMs: speed.length ? speed.reduce((max, v) => (v > max ? v : max), 0) : 0,
    averageSpeedMs: durationS > 0 ? distanceM / durationS : 0,
    fullThrottleShare: throttle.length ? throttle.filter((v) => v > 0.98).length / throttle.length : 0,
    brakingShare: brake.length ? brake.filter((v) => v > 0.05).length / brake.length : 0,
  };
}

export interface TrackPath {
  /** [x, z] in meters, the game's own axes, with z drawn upward as seen from above. */
  points: Array<[number, number]>;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The line the car drove, thinned to about `maxPoints`; null if the lap has no position channels. */
export function trackPath(lap: LapFile, maxPoints = 700): TrackPath | null {
  const { x, z } = lap.data;
  if (!x || !z || x.length === 0) return null;
  const stride = Math.max(1, Math.ceil(x.length / maxPoints));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < x.length; i += stride) if (Number.isFinite(x[i]) && Number.isFinite(z[i])) points.push([x[i], z[i]]);
  if (points.length < 2) return null;
  const xs = points.map((p) => p[0]);
  const zs = points.map((p) => p[1]);
  return { points, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

/** `3:27.250` for a time in milliseconds. */
export function formatLapTime(ms: number): string {
  const whole = Math.max(0, Math.round(ms));
  return `${Math.floor(whole / 60_000)}:${String(Math.floor(whole / 1000) % 60).padStart(2, '0')}.${String(whole % 1000).padStart(3, '0')}`;
}

/** `+0.123` or `-0.123`: a gap in seconds with its sign. */
export function formatGap(seconds: number): string {
  if (!Number.isFinite(seconds)) return '–';
  const text = Math.abs(seconds).toFixed(3);
  return seconds > 0.0005 ? `+${text}` : seconds < -0.0005 ? `-${text}` : text;
}

/** Speed and length in the units a person chose: km and km/h, or miles and mph (lengths in feet). */
export type DistanceUnit = 'km' | 'mi';
export const speedIn = (ms: number, unit: DistanceUnit) => (unit === 'mi' ? ms * 2.236936 : ms * 3.6);
export const speedLabel = (unit: DistanceUnit) => (unit === 'mi' ? 'mph' : 'km/h');
export const lengthIn = (meters: number, unit: DistanceUnit) => (unit === 'mi' ? meters * 3.28084 : meters);
export const lengthLabel = (unit: DistanceUnit) => (unit === 'mi' ? 'ft' : 'm');
