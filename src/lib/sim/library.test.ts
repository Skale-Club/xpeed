import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { gzipLap, packLap, type LapFile } from './lap-file';
import { LibraryError, addLapFile, clearLibrary, lapIdentity, listLaps, loadLap, removeLaps, subscribeLibrary, summarize } from './library';
import { LapReadError } from './read-lap-file';
import { makeSampleLaps } from './sample-laps';

const [mine, best] = makeSampleLaps();
const file = async (lap: LapFile, name = 'lap.xlap.gz') => new File([await gzipLap(lap)], name);

let idb: FakeIdb;
beforeEach(() => {
  idb = installFakeIndexedDb();
});
afterEach(() => idb.uninstall());

describe('keeping a lap', () => {
  it('keeps it, lists what it says about itself, and gives the samples back', async () => {
    const { status, id } = await addLapFile('ana', await file(mine, 'my-lap.xlap.gz'));
    expect(status).toBe('added');
    expect(id.startsWith('ana|')).toBe(true);

    const laps = await listLaps('ana');
    expect(laps).toHaveLength(1);
    expect(laps[0]).toMatchObject({ id, fileName: 'my-lap.xlap.gz', summary: summarize(mine) });
    expect(laps[0].summary).toMatchObject({ game: 'sample', trackName: 'Sample Ring', carName: 'Sample Car', lapNumber: 7, valid: true });
    expect(laps[0].size).toBeGreaterThan(1000);
    expect(laps[0].addedAt).toBeGreaterThan(0);

    const back = (await loadLap('ana', id))!;
    expect(back.header).toEqual(mine.header);
    expect(Array.from(back.data.speed.slice(0, 20))).toEqual(Array.from(mine.data.speed.slice(0, 20)));
  });

  it('keeps a lap given unpacked as the gzip file, and names it', async () => {
    const { id } = await addLapFile('ana', new Blob([packLap(mine)]), 'raw.xlap');
    expect((await listLaps('ana'))[0].fileName).toBe('raw.xlap');
    expect((await loadLap('ana', id))!.header).toEqual(mine.header);
  });

  it('does not keep the same lap twice, whatever the file was called or how it was packed', async () => {
    await addLapFile('ana', await file(mine, 'a.xlap.gz'));
    expect((await addLapFile('ana', await file(mine, 'copy of a.xlap.gz'))).status).toBe('duplicate');
    expect((await addLapFile('ana', new Blob([packLap(mine)]), 'raw.xlap')).status).toBe('duplicate');
    expect(await listLaps('ana')).toHaveLength(1);
    expect((await addLapFile('ana', await file(best))).status).toBe('added');
    expect(await listLaps('ana')).toHaveLength(2);
  });

  it('tells laps apart by what they say about themselves', () => {
    const other = { ...summarize(mine), startedAt: '2026-01-02T12:00:00.000Z' };
    expect(lapIdentity(summarize(mine))).not.toBe(lapIdentity(other));
    expect(lapIdentity(summarize(mine))).toBe(lapIdentity(summarize(mine)));
  });

  it('refuses a file that is not a lap and keeps nothing', async () => {
    await expect(addLapFile('ana', new File(['hello'], 'notes.txt'))).rejects.toBeInstanceOf(LapReadError);
    expect(await listLaps('ana')).toEqual([]);
  });
});

describe('one account never sees another account’s laps', () => {
  it('lists, loads and removes only its own', async () => {
    const { id: anaLap } = await addLapFile('ana', await file(mine));
    const { id: bobLap } = await addLapFile('bob', await file(mine));
    expect(anaLap).not.toBe(bobLap); // the same lap, kept separately by each account
    expect(await listLaps('ana')).toHaveLength(1);
    expect(await listLaps('bob')).toHaveLength(1);

    expect(await loadLap('bob', anaLap)).toBeNull();
    await removeLaps('bob', [anaLap]);
    expect(await listLaps('ana')).toHaveLength(1);

    await clearLibrary('bob');
    expect(await listLaps('bob')).toEqual([]);
    expect(await listLaps('ana')).toHaveLength(1);
  });

  it('does not let one account’s name stand in for another that starts the same', async () => {
    await addLapFile('an', await file(mine));
    await addLapFile('ana', await file(best));
    expect((await listLaps('an')).map((l) => l.summary.lapNumber)).toEqual([7]);
    expect((await listLaps('ana')).map((l) => l.summary.lapNumber)).toEqual([5]);
  });
});

describe('removing laps', () => {
  it('removes the ones asked for, and says nothing if one is not there', async () => {
    const { id: first } = await addLapFile('ana', await file(mine));
    const { id: second } = await addLapFile('ana', await file(best));
    await removeLaps('ana', [first, 'ana|never-there']);
    expect((await listLaps('ana')).map((l) => l.id)).toEqual([second]);
    expect(await loadLap('ana', first)).toBeNull();
    await removeLaps('ana', []);
    expect(await listLaps('ana')).toHaveLength(1);
  });
});

describe('telling a screen that the library changed', () => {
  it('after each change, until it stops listening', async () => {
    const listener = vi.fn();
    const stop = subscribeLibrary(listener);
    const { id } = await addLapFile('ana', await file(mine));
    expect(listener).toHaveBeenCalledTimes(1);
    await addLapFile('ana', await file(mine)); // a duplicate changes nothing
    expect(listener).toHaveBeenCalledTimes(1);
    await removeLaps('ana', [id]);
    await clearLibrary('ana');
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    await addLapFile('ana', await file(best));
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('when the device cannot keep laps', () => {
  it('says there is no room, and keeps nothing', async () => {
    idb.failTransactions(true);
    await expect(addLapFile('ana', await file(mine))).rejects.toMatchObject({ code: 'full' });
    idb.failTransactions(false);
    expect(await listLaps('ana')).toEqual([]);
  });

  it('says so when the browser has no IndexedDB', async () => {
    idb.uninstall();
    const error = await addLapFile('ana', await file(mine)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LibraryError);
    expect((error as LibraryError).code).toBe('unavailable');
    await expect(listLaps('ana')).rejects.toMatchObject({ code: 'unavailable' });
  });
});
