import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { gzipLap, type LapFile } from './lap-file';
import { importLapFiles } from './import-laps';
import { listLaps } from './library';
import { makeSampleLaps } from './sample-laps';

const [mine, best] = makeSampleLaps();
const file = async (lap: LapFile, name: string) => new File([await gzipLap(lap)], name);

let idb: FakeIdb;
beforeEach(() => {
  idb = installFakeIndexedDb();
});
afterEach(() => idb.uninstall());

describe('importing a batch of files', () => {
  it('keeps the laps, counts the ones it already had and names the ones that are not laps', async () => {
    const progress = vi.fn();
    const result = await importLapFiles('ana', [
      await file(mine, 'a.xlap.gz'),
      await file(best, 'b.xlap.gz'),
      await file(mine, 'a-again.xlap.gz'),
      new File(['not a lap'], 'notes.txt'),
    ], { onProgress: progress });

    expect(result).toEqual({ added: 2, duplicates: 1, ignored: 0, failed: [{ name: 'notes.txt', reason: 'not_a_lap' }], stopped: false });
    expect(await listLaps('ana')).toHaveLength(2);
    expect(progress).toHaveBeenCalledTimes(4);
    expect(progress).toHaveBeenLastCalledWith(4, 4);
  });

  it('skips what a folder holds besides laps, without calling it an error', async () => {
    const result = await importLapFiles('ana', [
      await file(mine, 'a.xlap.gz'),
      new File(['x'], 'lap.xlap.gz.part'),
      new File(['x'], 'README.txt'),
      new File(['x'], 'photo.png'),
    ], { fromFolder: true });
    expect(result).toMatchObject({ added: 1, ignored: 3, failed: [], stopped: false });
  });

  it('still reports a file with a lap-like name that is not a lap, in a folder', async () => {
    const result = await importLapFiles('ana', [new File(['broken'], 'bad.xlap.gz')], { fromFolder: true });
    expect(result.failed).toEqual([{ name: 'bad.xlap.gz', reason: 'not_a_lap' }]);
  });

  it('stops when the device is out of room, and says so', async () => {
    idb.failTransactions(true);
    const result = await importLapFiles('ana', [await file(mine, 'a.xlap.gz'), await file(best, 'b.xlap.gz')]);
    expect(result.stopped).toBe(true);
    expect(result.added).toBe(0);
    expect(result.failed).toEqual([{ name: 'a.xlap.gz', reason: 'full' }]); // the second was not even tried
  });

  it('is fine with nothing to import', async () => {
    expect(await importLapFiles('ana', [])).toEqual({ added: 0, duplicates: 0, ignored: 0, failed: [], stopped: false });
  });
});
