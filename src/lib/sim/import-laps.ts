import { LibraryError, addLapFile } from '@/lib/sim/library';
import { LapReadError } from '@/lib/sim/read-lap-file';

export type ImportFailure = 'too_big' | 'not_a_lap' | 'unreadable' | 'full' | 'unavailable' | 'failed';

export interface ImportResult {
  added: number;
  /** Laps that were already kept. */
  duplicates: number;
  /** Files of a chosen folder that do not look like lap files, skipped without a word. */
  ignored: number;
  failed: Array<{ name: string; reason: ImportFailure }>;
  /** True if the device ran out of room (or cannot keep laps) and the rest was not tried. */
  stopped: boolean;
}

const LOOKS_LIKE_A_LAP = /\.(xlap(\.gz)?|gz)$/i;

/**
 * Keeps a batch of files one after another (a lap at a time keeps memory low). With `fromFolder`, a folder
 * can hold other things (an unfinished `.part` file, notes), so files that do not look like laps are skipped;
 * files a person picked one by one are all tried and each one that is not a lap is reported.
 */
export async function importLapFiles(
  userId: string,
  files: readonly File[],
  options: { fromFolder?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<ImportResult> {
  const result: ImportResult = { added: 0, duplicates: 0, ignored: 0, failed: [], stopped: false };
  const candidates = options.fromFolder ? files.filter((file) => LOOKS_LIKE_A_LAP.test(file.name)) : [...files];
  result.ignored = files.length - candidates.length;

  let done = 0;
  for (const file of candidates) {
    try {
      const { status } = await addLapFile(userId, file);
      if (status === 'added') result.added++;
      else result.duplicates++;
    } catch (error) {
      if (error instanceof LibraryError && (error.code === 'full' || error.code === 'unavailable')) {
        result.failed.push({ name: file.name, reason: error.code });
        result.stopped = true;
        break;
      }
      const reason: ImportFailure = error instanceof LapReadError ? error.reason : error instanceof LibraryError ? 'failed' : 'unreadable';
      result.failed.push({ name: file.name, reason });
    }
    options.onProgress?.(++done, candidates.length);
  }
  return result;
}
