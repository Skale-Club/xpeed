import type { CornerComparison, CornerDelta } from '@/lib/sim/corner-compare';
import type { Corner } from '@/lib/sim/corners';

/**
 * The corner table of the Compare screen, as data: one row per corner in the order of the track, how it is coloured, the stretch
 * of the lap a click on it zooms to, and the corners that only one of the two laps had (listed apart, never paired with a wrong one).
 */

/** Under this many seconds a corner is neither a gain nor a loss: it is "even" and has no colour. */
export const EVEN_S = 0.005;

export type RowTone = 'loss' | 'gain' | 'even';

export const toneOf = (deltaTime: number): RowTone => (deltaTime > EVEN_S ? 'loss' : deltaTime < -EVEN_S ? 'gain' : 'even');

/** A stretch of the lap, in meters from the start line. */
export interface Range {
  fromM: number;
  toM: number;
}

export interface CornerRow {
  corner: CornerDelta;
  tone: RowTone;
}

export type CornerOrder = 'track' | 'loss';

/** The rows: in the order of the track, or the corner that lost the most first (ties keep the order of the track). */
export function cornerRows(comparison: CornerComparison, order: CornerOrder = 'track'): CornerRow[] {
  const rows = comparison.corners.map((corner) => ({ corner, tone: toneOf(corner.deltaTime) }));
  const byTrack = (p: CornerRow, q: CornerRow) => p.corner.index - q.corner.index;
  return rows.sort(order === 'loss' ? (p, q) => q.corner.deltaTime - p.corner.deltaTime || byTrack(p, q) : byTrack);
}

/** How much of the road around a corner the zoom shows beyond the corner itself (meters on each side). */
export const ZOOM_PAD_M = 60;

/** The stretch a click on a corner zooms to: the corner with some road before and after it, kept inside the lap. */
export function cornerRange(corner: Pick<CornerDelta, 'startDist' | 'endDist'>, lapLengthM: number): Range {
  const fromM = Math.max(0, corner.startDist - ZOOM_PAD_M);
  const toM = Math.min(lapLengthM, corner.endDist + ZOOM_PAD_M);
  return toM > fromM ? { fromM, toM } : { fromM: 0, toM: lapLengthM };
}

export interface UnmatchedCorner {
  /** Which lap had it. */
  side: 'lap' | 'reference';
  /** Its number on its own lap. */
  index: number;
  apexM: number;
  minSpeedKmh: number;
}

/** The corners found on only one of the two laps, the studied lap's first, each in track order. */
export function unmatchedCorners(comparison: CornerComparison): UnmatchedCorner[] {
  const list = (corners: readonly Corner[], side: UnmatchedCorner['side']) =>
    corners.map((c) => ({ side, index: c.index, apexM: c.apexDist, minSpeedKmh: c.minSpeed * 3.6 })).sort((p, q) => p.apexM - q.apexM);
  return [...list(comparison.unmatchedStudy, 'lap'), ...list(comparison.unmatchedReference, 'reference')];
}
