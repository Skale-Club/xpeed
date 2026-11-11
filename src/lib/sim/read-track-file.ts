import { TrackFormatError, gunzipTrack, unpackTrack, type TrackFile } from '@/lib/sim/track-file';

/** A track layout is a few MB at most (200000 points of 6 columns, gzipped); this refuses a wrong file before it is read at all. */
export const MAX_TRACK_FILE_BYTES = 32 * 1024 * 1024;

export class TrackReadError extends Error {
  constructor(public readonly reason: 'too_big' | 'not_a_track' | 'unreadable', message: string) {
    super(message);
    this.name = 'TrackReadError';
  }
}

export async function blobBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a track layout file the way it is stored (gzip) or unpacked, told apart by the first bytes, not by the name.
 * The file never leaves the browser. Throws a TrackReadError with a reason the screen can say in words.
 */
export async function readTrackFile(file: Blob): Promise<TrackFile> {
  if (file.size > MAX_TRACK_FILE_BYTES) throw new TrackReadError('too_big', 'The file is too large to be a track layout.');
  let bytes: Uint8Array;
  try {
    bytes = await blobBytes(file);
  } catch {
    throw new TrackReadError('unreadable', 'The file could not be read.');
  }
  try {
    const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    return gzipped ? await gunzipTrack(bytes) : unpackTrack(bytes);
  } catch (error) {
    if (error instanceof TrackFormatError) throw new TrackReadError('not_a_track', error.message);
    throw new TrackReadError('unreadable', 'The file could not be read.');
  }
}
