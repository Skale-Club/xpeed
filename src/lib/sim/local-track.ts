import type { TrackFile } from './track-file';
import { offsetsFromLine } from './line-offset';
import type { LapHeader } from './lap-file';
import { evoCoordinateFrame } from './reference-context';


export function localTrackSurface(track: TrackFile): 'asphalt' | 'limits' | 'ai' | 'estimated' | 'unknown' {
  const source = track.header.source.toLowerCase();
  if (source === 'mesh_asphalt') return 'asphalt';
  if (source === 'ego_white_line') return 'limits';
  if (source === 'aisplinedata' || ((source.includes('aiw') || source.includes('fast_lane')) && track.boundaries)) return 'ai';
  if (!track.boundaries && (source.includes('fast_lane') || source.includes('aiw'))) return 'estimated';
  return 'unknown';
}

/** Reuse the map's 25 m median alignment rule, with bounded lap sampling. Never adjust coordinates. */
export function assertLocalTrackAlignment(track: TrackFile, x: ArrayLike<number>, z: ArrayLike<number>) {
  const indices = Array.from({ length: Math.min(64, x.length) }, (_, i) => Math.floor(i * x.length / Math.min(64, x.length)));
  const line = track.fast ?? track.centerline;
  const distances = offsetsFromLine({ ...line, closed: track.header.closed }, indices.map((i) => x[i]), indices.map((i) => z[i]))
    .filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  if (!distances.length || distances[Math.floor(distances.length / 2)] > 25) throw new Error('alignment_mismatch');
}

/**
 * Assetto Corsa EVO layouts are always stored in the reflected X frame (`x = -source.x`). A lap recorded in the original frame
 * (see `evoCoordinateFrame`) gets a mirrored copy of the layout: every X negated and, because a mirror swaps the driver's sides,
 * left and right exchanged. Pure: neither the layout nor the lap is modified; any other case returns the layout itself.
 */
export function layoutInLapFrame(track: TrackFile, lap: LapHeader): TrackFile {
  if (track.header.game !== 'acevo' || lap.game !== 'acevo' || evoCoordinateFrame(lap) !== 'original') return track;
  const neg = (a: Float32Array) => a.map((v) => -v);
  const copy = (a: Float32Array) => a.slice();
  const { centerline: c, fast, pitlane: p, boundaries: b } = track;
  return {
    header: track.header,
    centerline: { x: neg(c.x), y: copy(c.y), z: copy(c.z), dist: copy(c.dist), left: copy(c.right), right: copy(c.left) },
    ...(fast ? { fast: { x: neg(fast.x), z: copy(fast.z) } } : {}),
    ...(p ? { pitlane: { x: neg(p.x), z: copy(p.z), left: copy(p.right), right: copy(p.left) } } : {}),
    ...(b ? { boundaries: { left_x: neg(b.right_x), left_z: copy(b.right_z), right_x: neg(b.left_x), right_z: copy(b.left_z) } } : {}),
  };
}

/** Whether an account layout may be drawn over a lap: converted to the lap's frame first, then the 25 m alignment check decides. */
export function layoutFitsLap(track: TrackFile, header: LapHeader, x: ArrayLike<number>, z: ArrayLike<number>): boolean {
  try { assertLocalTrackAlignment(layoutInLapFrame(track, header), x, z); return true; }
  catch { return false; }
}
