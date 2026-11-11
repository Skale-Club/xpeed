import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { findTrack, listTracks } from './track-library';
import { deleteAccountTrack, syncAccountTracks, type AccountTrack } from './account-tracks';

let token: string | null = 'token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));

const layoutBytes = (name: string) => gzipBytes(packLayout(makeLayout({ points: circle(300, 40), width: 8, closed: true, ideal: true, name })));
const track = (id: string, trackName: string, updatedAt = '2026-11-11T10:00:00.000Z'): AccountTrack => ({
  id, game: 'ac', trackName, variant: null, title: null, lengthM: 1885, size: 100, updatedAt,
});

let idb: FakeIdb;
let account: AccountTrack[];
let files: Record<string, Uint8Array>;
const calls: string[] = [];

beforeEach(async () => {
  token = 'token';
  idb = installFakeIndexedDb();
  account = [track('t1', 'Monza'), track('t2', 'Spa')];
  files = { t1: await layoutBytes('Monza'), t2: await layoutBytes('Spa') };
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path} ${(init.headers as Record<string, string>).Authorization}`);
    if (path === '/api/sim/tracks') return new Response(JSON.stringify({ tracks: account }), { status: 200 });
    const file = /^\/api\/sim\/tracks\/(\w+)\/file$/.exec(path);
    if (file) return files[file[1]] ? new Response(files[file[1]], { status: 200 }) : new Response(null, { status: 404 });
    const one = /^\/api\/sim\/tracks\/(\w+)$/.exec(path);
    if (one && init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('the layouts in the account', () => {
  it('are copied onto the device once, signed in, and then found by the name a lap uses', async () => {
    const first = await syncAccountTracks('ana');
    expect(first).toMatchObject({ reached: true, copied: 2, failed: 0 });
    expect(calls.every((call) => call.endsWith('Bearer token'))).toBe(true);
    expect(await findTrack('ana', 'ac', 'monza')).not.toBeNull();
    expect((await listTracks('ana')).map((entry) => entry.summary.trackName).sort()).toEqual(['Monza', 'Spa']);

    const second = await syncAccountTracks('ana');
    expect(second.copied).toBe(0);
    expect(calls.filter((call) => call.includes('/file'))).toHaveLength(2);
  });

  it('are copied again when the account has a newer one', async () => {
    await syncAccountTracks('ana');
    account = [track('t1', 'Monza', '2099-01-01T00:00:00.000Z'), track('t2', 'Spa')];
    expect((await syncAccountTracks('ana')).copied).toBe(1);
  });

  it('skip one that cannot be downloaded or read, and copy the rest', async () => {
    files.t2 = new Uint8Array([1, 2, 3]);
    account.push(track('t3', 'Nowhere'));
    const result = await syncAccountTracks('ana');
    expect(result).toMatchObject({ reached: true, copied: 1, failed: 2 });
  });

  it('are left alone when the account cannot be read (signed out, or a server without them)', async () => {
    token = null;
    expect(await syncAccountTracks('ana')).toMatchObject({ reached: false, copied: 0 });
    token = 'token';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    expect((await syncAccountTracks('ana')).reached).toBe(false);
    expect(await listTracks('ana')).toEqual([]);
  });

  it('can be removed from the account', async () => {
    expect(await deleteAccountTrack('t1')).toBe(true);
    expect(calls).toContain('DELETE /api/sim/tracks/t1 Bearer token');
  });
});
