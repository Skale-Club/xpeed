import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import {
  appendTripSamples, deleteTripCopy, getTripCopy, listTripCopies, saveTripCopy, tripKey, type StoredTrip, type StoredTripMeta,
} from './trip-store';

let idb: FakeIdb;
beforeEach(() => {
  idb = installFakeIndexedDb();
});
afterEach(() => {
  idb.uninstall();
  vi.restoreAllMocks();
});

const sample = (t: number) => ({ t, values: { speed: t * 10 } });
const samples = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => sample(from + i));
const id = tripKey(1000);
const meta: StoredTripMeta = { id, carId: 'car-1', userId: 'u1', startedAt: 1000, columns: ['speed'], dtcs: ['P0420'] };
const whole = (over: Partial<StoredTrip> = {}): StoredTrip => ({ ...meta, endedAt: 9000, samples: samples(0, 4), ...over });

describe('trip copies', () => {
  it('keeps a whole trip until it is deleted', async () => {
    expect(await saveTripCopy(whole())).toBe(true);
    const [copy] = await listTripCopies();
    expect(copy).toMatchObject({ id, carId: 'car-1', userId: 'u1', endedAt: 9000 });
    expect(copy.samples).toHaveLength(4);
    expect(await getTripCopy(id)).toMatchObject({ id, userId: 'u1' });
    expect(await deleteTripCopy(id)).toBe(true);
    expect(await listTripCopies()).toEqual([]);
    expect(await getTripCopy(id)).toBeNull();
  });

  it('backs up a recording in appended chunks and puts them back together', async () => {
    expect(await appendTripSamples(meta, samples(0, 3), 0)).toBe(true);
    expect(await appendTripSamples({ ...meta, columns: ['speed', 'rpm'] }, samples(3, 5), 3)).toBe(true);
    // Each backup wrote only the new samples: two chunks, and the entry itself holds none
    expect(Object.keys(idb.dump('chunks'))).toHaveLength(2);
    expect((idb.dump('trips')[id] as StoredTrip).samples).toEqual([]);
    const [copy] = await listTripCopies();
    expect(copy.samples.map((s) => s.t)).toEqual([0, 1, 2, 3, 4]);
    expect(copy.columns).toEqual(['speed', 'rpm']);
    expect(copy.endedAt).toBeUndefined();
  });

  it('does not duplicate samples when a backup is sent again after a failure', async () => {
    await appendTripSamples(meta, samples(0, 3), 0);
    // The caller didn't hear back and sends from the same point, now with more samples
    await appendTripSamples(meta, samples(0, 5), 0);
    const [copy] = await listTripCopies();
    expect(copy.samples.map((s) => s.t)).toEqual([0, 1, 2, 3, 4]);
    // Even if chunks overlap on disk, a sample is never read twice
    await appendTripSamples(meta, samples(4, 7), 4);
    expect((await getTripCopy(id))!.samples.map((s) => s.t)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('replaces the chunks with the finished trip, and ignores a backup that arrives after it', async () => {
    await appendTripSamples(meta, samples(0, 3), 0);
    await saveTripCopy(whole({ samples: samples(0, 6) }));
    expect(Object.keys(idb.dump('chunks'))).toHaveLength(0);
    // A late backup of the same trip must not turn the finished copy back into a recording
    await appendTripSamples(meta, samples(6, 8), 6);
    const copy = (await getTripCopy(id))!;
    expect(copy.endedAt).toBe(9000);
    expect(copy.samples).toHaveLength(6);
    expect(Object.keys(idb.dump('chunks'))).toHaveLength(0);
  });

  it('reads trips from before backups were chunked, and lists them oldest first', async () => {
    await saveTripCopy(whole({ id: tripKey(2000), startedAt: 2000 }));
    await saveTripCopy(whole({ id: tripKey(500), startedAt: 500 }));
    await appendTripSamples({ ...meta, id: tripKey(1500), startedAt: 1500 }, samples(0, 2), 0);
    expect((await listTripCopies()).map((t) => t.startedAt)).toEqual([500, 1500, 2000]);
  });

  it('only counts a save once the transaction has committed, and says so when it did not', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    idb.failTransactions(true);
    expect(await saveTripCopy(whole())).toBe(false);
    expect(await appendTripSamples(meta, samples(0, 2), 0)).toBe(false);
    expect(await deleteTripCopy(id)).toBe(false);
    idb.failTransactions(false);
    // Nothing from the failed attempts is on the device
    expect(await listTripCopies()).toEqual([]);
  });

  it('reports that nothing can be kept where there is no IndexedDB', async () => {
    idb.uninstall();
    (globalThis as { indexedDB?: unknown }).indexedDB = undefined;
    expect(await saveTripCopy(whole())).toBe(false);
    expect(await appendTripSamples(meta, samples(0, 2), 0)).toBe(false);
    expect(await listTripCopies()).toEqual([]);
  });
});
