import { describe, expect, it } from 'vitest';
import { gzipLap, packLap } from './lap-file';
import { LapReadError, MAX_FILE_BYTES, readLapFile } from './read-lap-file';
import { makeSampleLaps } from './sample-laps';

const [lap] = makeSampleLaps();

async function reasonOf(file: Blob): Promise<string> {
  try {
    await readLapFile(file);
  } catch (error) {
    return error instanceof LapReadError ? error.reason : `other: ${String(error)}`;
  }
  return 'no error';
}

describe('reading a lap file picked by a person', () => {
  it('reads the gzip file the collector writes', async () => {
    const read = await readLapFile(new Blob([await gzipLap(lap)]));
    expect(read.header).toEqual(lap.header);
  });

  it('reads the same file unpacked, told apart by its first bytes and not by its name', async () => {
    const read = await readLapFile(new File([packLap(lap)], 'lap.txt'));
    expect(read.header).toEqual(lap.header);
    const zipped = await readLapFile(new File([await gzipLap(lap)], 'lap.xlap'));
    expect(zipped.header).toEqual(lap.header);
  });

  it('says a file that is not a lap is not a lap', async () => {
    expect(await reasonOf(new Blob(['hello, this is not a lap file at all']))).toBe('not_a_lap');
    expect(await reasonOf(new Blob([new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4, 5, 6])]))).toBe('not_a_lap');
    expect(await reasonOf(new Blob([]))).toBe('not_a_lap');
  });

  it('refuses a file that is too large before reading it', async () => {
    const huge = new Blob([new Uint8Array(8)]);
    Object.defineProperty(huge, 'size', { value: MAX_FILE_BYTES + 1 });
    expect(await reasonOf(huge)).toBe('too_big');
  });

  it('refuses a damaged lap file', async () => {
    const bytes = packLap(lap);
    expect(await reasonOf(new Blob([bytes.subarray(0, bytes.length - 8)]))).toBe('not_a_lap');
  });
});
