import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { accountLap } from '@/test/account-laps-fixture';
import { gzipLap, type LapFile } from './lap-file';
import { addLapFile, lapIdentity, listLaps } from './library';
import { makeSampleLaps } from './sample-laps';
import { accountLapSummary, deleteAccountLap, downloadAccountLap, listAccountLaps, mergeLaps, openLap, type AccountLap } from './account-laps';

let token: string | null = 'token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));

const [mine] = makeSampleLaps();
const asServerLap = (lap: LapFile, id: string): AccountLap =>
  accountLap({
    id,
    game: lap.header.game,
    track: lap.header.track.name,
    car: lap.header.car.name,
    lapNumber: lap.header.lap.number,
    timeMs: lap.header.lap.timeMs,
    startedAt: lap.header.startedAt,
    sampleCount: lap.header.sampleCount,
  });

let idb: FakeIdb;
const calls: string[] = [];
let list: unknown;
beforeEach(async () => {
  token = 'token';
  idb = installFakeIndexedDb();
  calls.length = 0;
  list = { laps: [asServerLap(mine, 'a1')] };
  const bytes = await gzipLap(mine);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init.method} ${path} ${(init.headers as Record<string, string>).Authorization}`);
    if (path === '/api/sim/laps') return new Response(JSON.stringify(list), { status: 200 });
    if (path === '/api/sim/laps/a1/file') return new Response(bytes, { status: 200 });
    if (path === '/api/sim/laps/a1' && init.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  }));
});
afterEach(() => {
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('the account laps list', () => {
  it('maps what the server sends, signed in', async () => {
    const laps = await listAccountLaps();
    expect(laps).toHaveLength(1);
    expect(laps![0]).toMatchObject({ id: 'a1', game: 'sample', track: mine.header.track.name, car: 'Sample Car', lapNumber: 7, valid: true, deviceName: 'Rig' });
    expect(calls).toEqual(['GET /api/sim/laps Bearer token']);
    // The summary carries the same identity the library gives the lap file.
    expect(lapIdentity(accountLapSummary(laps![0]))).toBe(lapIdentity({
      game: 'sample', trackName: mine.header.track.name, carName: 'Sample Car', lapNumber: 7, timeMs: mine.header.lap.timeMs,
      valid: true, startedAt: mine.header.startedAt, sampleCount: mine.header.sampleCount,
    }));
  });

  it('is null when signed out or when the answer is not a list', async () => {
    token = null;
    expect(await listAccountLaps()).toBeNull();
    token = 'token';
    list = { nope: true };
    expect(await listAccountLaps()).toBeNull();
  });

  it('downloads a lap file and parses it', async () => {
    const lap = await downloadAccountLap('a1');
    expect(lap?.header.lap.number).toBe(7);
    expect(lap?.data.speed?.length ?? lap?.header.sampleCount).toBeGreaterThan(0);
    expect(await downloadAccountLap('missing')).toBeNull();
  });

  it('forgets a lap in the account', async () => {
    expect(await deleteAccountLap('a1')).toBe(true);
    expect(await deleteAccountLap('zzz')).toBe(false);
  });
});

describe('merging with the laps on the device', () => {
  it('shows a lap that is in both once, as on the server, and keeps the others', async () => {
    await addLapFile('ana', new File([await gzipLap(mine)], 'mine.xlap.gz'));
    const other = asServerLap(mine, 'a2');
    other.lapNumber = 8;
    other.timeMs = 99_000;
    const merged = mergeLaps('ana', await listLaps('ana'), [asServerLap(mine, 'a1'), other]);
    expect(merged).toHaveLength(2);
    const both = merged.find((lap) => lap.serverId === 'a1')!;
    expect(both).toMatchObject({ onServer: true, onDevice: true });
    const serverOnly = merged.find((lap) => lap.serverId === 'a2')!;
    expect(serverOnly).toMatchObject({ onServer: true, onDevice: false, id: `ana|${serverOnly.identity}` });
    expect(await listLaps('ana')).toHaveLength(1);
  });

  it('keeps a lap that only the device has', async () => {
    await addLapFile('ana', new File([await gzipLap(mine)], 'mine.xlap.gz'));
    const merged = mergeLaps('ana', await listLaps('ana'), []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ onServer: false, onDevice: true });
  });
});

describe('opening a lap', () => {
  it('downloads it from the account the first time and keeps it, so the next time is instant', async () => {
    const identity = lapIdentity(accountLapSummary((await listAccountLaps())![0]));
    calls.length = 0;
    expect((await openLap('ana', `ana|${identity}`))?.header.lap.number).toBe(7);
    expect(calls.filter((call) => call.includes('/file'))).toHaveLength(1);
    expect(await listLaps('ana')).toHaveLength(1);
    calls.length = 0;
    expect((await openLap('ana', identity))?.header.lap.number).toBe(7);
    expect(calls).toEqual([]);
  });

  it('is null for a lap that neither has', async () => {
    expect(await openLap('ana', 'ana|sample|Nowhere|Car|2026-01-01T00:00:00.000Z|1|1|1')).toBeNull();
  });
});
