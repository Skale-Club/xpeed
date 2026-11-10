import { LAP_LIMITS, LapFormatError, gunzipLap, unpackLap, type LapFile } from '@/lib/sim/lap-file';

/** A lap file is a few hundred KB; this is generous, and refuses a wrong file before it is read at all. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class LapReadError extends Error {
  constructor(public readonly reason: 'too_big' | 'not_a_lap' | 'unreadable', message: string) {
    super(message);
    this.name = 'LapReadError';
  }
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Reads a lap file the way it is stored (gzip) or unpacked, told apart by the first bytes, not by the name.
 * The file never leaves the browser. Throws a LapReadError with a reason the screen can say in words.
 */
export async function readLapFile(file: Blob): Promise<LapFile> {
  if (file.size > MAX_FILE_BYTES) throw new LapReadError('too_big', 'The file is too large to be a lap.');
  let bytes: Uint8Array;
  try {
    bytes = await bytesOf(file);
  } catch {
    throw new LapReadError('unreadable', 'The file could not be read.');
  }
  try {
    const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    return gzipped ? await gunzipLap(bytes, { maxBytes: LAP_LIMITS.unpackedBytes }) : unpackLap(bytes);
  } catch (error) {
    if (error instanceof LapFormatError) throw new LapReadError('not_a_lap', error.message);
    throw new LapReadError('unreadable', 'The file could not be read.');
  }
}
