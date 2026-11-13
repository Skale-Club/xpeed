import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { makeLapFixtures } from '@/test/lap-fixture';
import { fakeV1Fetch, fakeV1State, type FakeV1State } from '@/test/v1-fake-server';
import { gzipLap } from './lap-file';
import { CACHE_LIMITS, clearCache, forgetLaps, openLap, reconcileSession } from './library';
import { LapReadError } from './read-lap-file';
import { V1Error } from './v1-client';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const [mine] = makeLapFixtures();

let idb: FakeIdb;
let state: FakeV1State;
let fetchMock: ReturnType<typeof vi.fn>;
let bytes: Uint8Array;
const fileDownloads = () => state.requests.filter((request) => request.path.endsWith('/file')).length;
const cachedIds = (user = 'ana') => Object.keys(idb.dump('laps')).filter((key) => key.startsWith(`${user}|`)).map((key) => key.slice(user.length + 1));
const serve = (...ids: string[]) => ids.forEach((id) => state.files.set(id, bytes));

beforeEach(async () => {
  idb = installFakeIndexedDb();
  state = fakeV1State();
  fetchMock = vi.fn(fakeV1Fetch(state));
  vi.stubGlobal('fetch', fetchMock);
  bytes = await gzipLap(mine);
});
afterEach(() => {
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('opening a lap', () => {
  it('downloads the file once, checks it, and reads it from the device the next time', async () => {
    serve('lap-1');
    const first = await openLap('ana', 'lap-1');
    expect(first.header).toEqual(mine.header);
    expect(fileDownloads()).toBe(1);
    expect(state.requests[0].path).toBe('/laps/lap-1/file');
    expect(cachedIds()).toEqual(['lap-1']); // keyed by the server's lap id

    const second = await openLap('ana', 'lap-1');
    expect(second.header).toEqual(mine.header);
    expect(Array.from(second.data.speed.slice(0, 20))).toEqual(Array.from(mine.data.speed.slice(0, 20)));
    expect(fileDownloads()).toBe(1);
  });

  it('shares one download between screens that ask at the same moment', async () => {
    serve('lap-1');
    await Promise.all([openLap('ana', 'lap-1'), openLap('ana', 'lap-1'), openLap('ana', 'lap-1')]);
    expect(fileDownloads()).toBe(1);
  });

  it('never lists everything: a lap on the device is read by its key, without walking the cache', async () => {
    serve('lap-1', 'lap-2');
    await openLap('ana', 'lap-1');
    await openLap('ana', 'lap-2');
    const cursors = idb.cursors();
    await openLap('ana', 'lap-1');
    await openLap('ana', 'lap-2');
    expect(idb.cursors()).toBe(cursors);
    expect(fileDownloads()).toBe(2);
  });

  it('keeps one cache per account', async () => {
    serve('lap-1');
    await openLap('ana', 'lap-1');
    await openLap('bob', 'lap-1');
    expect(fileDownloads()).toBe(2);
    expect(cachedIds('ana')).toEqual(['lap-1']);
    expect(cachedIds('bob')).toEqual(['lap-1']);
    await clearCache('bob');
    expect(cachedIds('bob')).toEqual([]);
    expect(cachedIds('ana')).toEqual(['lap-1']);
  });

  it('refuses a file that is not a lap and keeps nothing', async () => {
    state.files.set('bad', new TextEncoder().encode('hello'));
    await expect(openLap('ana', 'bad')).rejects.toBeInstanceOf(LapReadError);
    expect(cachedIds()).toEqual([]);
  });

  it('says why when the server cannot give the lap', async () => {
    const gone = await openLap('ana', 'never-there').catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(V1Error);
    expect(gone).toMatchObject({ status: 404, code: 'lap_not_found' });
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    expect(await openLap('ana', 'lap-x').catch((e: unknown) => e)).toMatchObject({ status: 503, retryable: true });
    expect(cachedIds()).toEqual([]);
  });

  it('still opens the lap when the device cannot keep it', async () => {
    serve('lap-1');
    idb.failTransactions(true);
    expect((await openLap('ana', 'lap-1')).header).toEqual(mine.header);
    idb.failTransactions(false);
    expect(cachedIds()).toEqual([]);
  });

  it('still opens the lap in a browser with no IndexedDB', async () => {
    idb.uninstall();
    serve('lap-1');
    expect((await openLap('ana', 'lap-1')).header).toEqual(mine.header);
  });
});

describe('the limits of the cache', () => {
  it('evicts the least recently used lap past 150 laps', async () => {
    const ids = Array.from({ length: CACHE_LIMITS.maxLaps }, (_, i) => `lap-${i}`);
    serve(...ids, 'lap-new');
    for (const id of ids) await openLap('ana', id);
    expect(cachedIds()).toHaveLength(150);

    await openLap('ana', 'lap-0'); // used again: no longer the oldest
    await openLap('ana', 'lap-new');
    const kept = cachedIds();
    expect(kept).toHaveLength(150);
    expect(kept).toContain('lap-0');
    expect(kept).toContain('lap-new');
    expect(kept).not.toContain('lap-1'); // the one used longest ago
    // The small records go with the laps.
    expect(Object.keys(idb.dump('lap-meta'))).toHaveLength(150);
  }, 30_000);

  it('evicts the least recently used laps past the size limit', async () => {
    const limits = CACHE_LIMITS as { maxBytes: number };
    const original = limits.maxBytes;
    limits.maxBytes = bytes.byteLength * 3 + 10;
    try {
      serve('a', 'b', 'c', 'd');
      for (const id of ['a', 'b', 'c']) await openLap('ana', id);
      await openLap('ana', 'a');
      await openLap('ana', 'd');
      expect(cachedIds().sort()).toEqual(['a', 'c', 'd']); // b was the least recently used
    } finally {
      limits.maxBytes = original;
    }
  });

  it('counts the limits per account', async () => {
    const limits = CACHE_LIMITS as { maxBytes: number };
    const original = limits.maxBytes;
    limits.maxBytes = bytes.byteLength + 10;
    try {
      serve('a');
      await openLap('ana', 'a');
      await openLap('bob', 'a');
      expect(cachedIds('ana')).toEqual(['a']);
      expect(cachedIds('bob')).toEqual(['a']);
    } finally {
      limits.maxBytes = original;
    }
  });
});

describe('a lap that is no longer on the server', () => {
  it('is dropped when the lap it was cached from is gone from its session', async () => {
    serve('lap-1', 'lap-2', 'lap-3');
    await openLap('ana', 'lap-1', { sessionId: 's1' });
    await openLap('ana', 'lap-2', { sessionId: 's1' });
    await openLap('ana', 'lap-3', { sessionId: 's2' });
    await reconcileSession('ana', 's1', ['lap-2']); // the server's session no longer has lap-1
    expect(cachedIds().sort()).toEqual(['lap-2', 'lap-3']);
    await openLap('ana', 'lap-1', { sessionId: 's1' });
    expect(fileDownloads()).toBe(4); // it is fetched again, never shown from the cache alone
  });

  it('is forgotten when it is deleted here', async () => {
    serve('lap-1', 'lap-2');
    await openLap('ana', 'lap-1');
    await openLap('ana', 'lap-2');
    await forgetLaps('ana', ['lap-1', 'never-cached']);
    expect(cachedIds()).toEqual(['lap-2']);
    await forgetLaps('ana', []);
    expect(cachedIds()).toEqual(['lap-2']);
  });
});
