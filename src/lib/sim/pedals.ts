import { CHART_PALETTE } from '@/lib/chart-palette';

// What the driver's feet did around a lap, for the small pedal map beside the lap analysis' track map.

/** One lap on the analysis' distance grid: where the car was and what the feet did. */
export interface PedalSeries {
  x: ArrayLike<number>;
  z: ArrayLike<number>;
  speed: ArrayLike<number>;
  throttle: ArrayLike<number>;
  brake: ArrayLike<number>;
}

/** What the driver's feet are doing at a point: on the brake (it wins), on the throttle, or on neither. */
export type PedalState = 'brake' | 'throttle' | 'coast';
/** Under this much of a pedal's travel it is not counted as pressed (a foot resting on it, sensor noise). */
export const PEDAL_PRESSED = 0.05;

export function pedalState(throttle: number, brake: number): PedalState {
  if (Number.isFinite(brake) && brake > PEDAL_PRESSED) return 'brake';
  if (Number.isFinite(throttle) && throttle > PEDAL_PRESSED) return 'throttle';
  return 'coast';
}

export interface PedalRun { state: PedalState; points: string }

/** At most this many points of the lap are drawn on the small map. */
const MAX_POINTS = 700;
export const PEDAL_COLOUR: Record<PedalState, string> = { throttle: CHART_PALETTE.green, brake: CHART_PALETTE.red, coast: 'hsl(var(--muted-foreground))' };

/**
 * The lap as stretches of one pedal state each, in the small map's own units (0..100, x to the right, z down, as on the big map). Each
 * stretch ends on the first point of the next, so the line has no gaps.
 */
export function pedalRuns(lap: PedalSeries): { runs: PedalRun[]; at: (index: number) => { x: number; y: number } | null } {
  const n = lap.x.length;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const [x, z] = [lap.x[i], lap.z[i]];
    if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (minX === Infinity) return { runs: [], at: () => null };
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const scale = 92 / span;
  const [offX, offY] = [(100 - (maxX - minX) * scale) / 2, (100 - (maxZ - minZ) * scale) / 2];
  const at = (index: number) => {
    const [x, z] = [lap.x[index], lap.z[index]];
    return Number.isFinite(x) && Number.isFinite(z) ? { x: offX + (x - minX) * scale, y: offY + (z - minZ) * scale } : null;
  };
  const step = Math.max(1, Math.ceil(n / MAX_POINTS));
  const runs: PedalRun[] = [];
  let current: { state: PedalState; points: string[] } | null = null;
  for (let i = 0; i < n; i += step) {
    const p = at(i);
    if (!p) continue;
    const text = `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const state = pedalState(lap.throttle[i], lap.brake[i]);
    if (current && current.state !== state) {
      current.points.push(text);
      runs.push({ state: current.state, points: current.points.join(' ') });
      current = null;
    }
    if (!current) current = { state, points: [] };
    current.points.push(text);
  }
  if (current) runs.push({ state: current.state, points: current.points.join(' ') });
  return { runs, at };
}
