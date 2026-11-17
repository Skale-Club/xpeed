import { gunzipTrack, layoutGame, TRACK_LIMITS, TrackFormatError, trackKeyOf, unpackTrack } from './track-file';
import type { TrackFile } from './track-file';
import { offsetsFromLine } from './line-offset';

export interface LocalTrackIdentity { game: string; name: string; variant?: string | null }
/** Bound the input before reading it; decompression has its own streaming output bound. */
export const LOCAL_TRACK_MAX_BYTES = TRACK_LIMITS.unpackedBytes;

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

export async function readLocalTrack(file: Pick<File, 'size' | 'arrayBuffer'>, wanted: LocalTrackIdentity) {
  if (file.size > LOCAL_TRACK_MAX_BYTES) throw new TrackFormatError('too_large', 'The local file exceeds the size limit.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > LOCAL_TRACK_MAX_BYTES) throw new TrackFormatError('too_large', 'The local file exceeds the size limit.');
  const track = bytes[0] === 0x1f && bytes[1] === 0x8b ? await gunzipTrack(bytes) : unpackTrack(bytes);
  const key = (identity: LocalTrackIdentity) => trackKeyOf(layoutGame(identity.game), identity.name, identity.variant);
  if (key({ game: track.header.game, ...track.header.track }) !== key(wanted)) throw new Error('identity_mismatch');
  return track;
}
