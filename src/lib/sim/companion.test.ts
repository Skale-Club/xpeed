import { describe, expect, it } from 'vitest';
import { BETA_GAMES, CERTIFIED_GAMES, ONLINE_WINDOW_MS, checklistOf, deviceState, gameRows, splitDevices } from '@/lib/sim/companion';
import { BUILT_IN_GAME_NAMES } from '@/lib/sim/games';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const device = (over: Partial<SimDevice> = {}): SimDevice => ({ id: 'd', name: 'RIG', created_at: '2026-11-01T10:00:00.000Z', last_seen_at: minutesAgo(1), last_lap_at: null, revoked_at: null, ...over });

describe('the state of a computer', () => {
  it('is online when the server heard from it within ten minutes, offline after, and never when it was never heard from', () => {
    expect(deviceState(device({ last_seen_at: minutesAgo(0) }), NOW)).toBe('online');
    expect(deviceState(device({ last_seen_at: new Date(NOW - ONLINE_WINDOW_MS).toISOString() }), NOW)).toBe('online');
    expect(deviceState(device({ last_seen_at: new Date(NOW - ONLINE_WINDOW_MS - 1000).toISOString() }), NOW)).toBe('offline');
    expect(deviceState(device({ last_seen_at: null }), NOW)).toBe('never');
    expect(deviceState(device({ last_seen_at: 'not a date' }), NOW)).toBe('never');
  });

  it('is revoked whatever else is true', () => {
    expect(deviceState(device({ revoked_at: '2026-11-12T00:00:00.000Z', last_seen_at: minutesAgo(1) }), NOW)).toBe('revoked');
  });

  it('puts the computers in order: online, then the latest seen, then never seen; the revoked apart', () => {
    const { live, revoked } = splitDevices([
      device({ id: 'never', last_seen_at: null }),
      device({ id: 'old', last_seen_at: minutesAgo(60 * 48) }),
      device({ id: 'older', last_seen_at: minutesAgo(60 * 96) }),
      device({ id: 'on', last_seen_at: minutesAgo(2) }),
      device({ id: 'gone', revoked_at: '2026-11-02T00:00:00.000Z' }),
    ], NOW);
    expect(live.map((entry) => entry.id)).toEqual(['on', 'old', 'older', 'never']);
    expect(revoked.map((entry) => entry.id)).toEqual(['gone']);
  });
});

describe('the games', () => {
  it('has Assetto Corsa and Automobilista 2 as the certified ones, and every game has a name', () => {
    expect(CERTIFIED_GAMES).toEqual(['ac', 'ams2']);
    for (const id of [...CERTIFIED_GAMES, ...BETA_GAMES]) expect(BUILT_IN_GAME_NAMES[id], id).toBeTruthy();
    expect(BETA_GAMES.filter((id) => CERTIFIED_GAMES.includes(id))).toEqual([]);
  });

  it('lists the certified games first, then the beta ones, then any other game the account has laps in', () => {
    const rows = gameRows([{ game: 'lmu', laps: 149, lastDrivenAt: '2026-11-13T09:00:00.000Z' }, { game: 'ac', laps: 44, lastDrivenAt: '2026-11-07T09:00:00.000Z' }, { game: 'zzz', laps: 3, lastDrivenAt: '2026-11-01T09:00:00.000Z' }]);
    expect(rows.slice(0, 2).map((row) => [row.game, row.tier])).toEqual([['ac', 'certified'], ['ams2', 'certified']]);
    expect(rows.slice(2).every((row) => row.tier === 'beta')).toBe(true);
    expect(rows[rows.length - 1]).toMatchObject({ game: 'zzz', tier: 'beta', laps: 3 });
    expect(rows.find((row) => row.game === 'ac')).toMatchObject({ laps: 44, lastDrivenAt: '2026-11-07T09:00:00.000Z' });
    expect(rows.find((row) => row.game === 'ams2')).toMatchObject({ laps: 0, lastDrivenAt: null });
  });

  it('is the same list with no numbers when the account cannot be read', () => {
    expect(gameRows(undefined).map((row) => row.game)).toEqual([...CERTIFIED_GAMES, ...BETA_GAMES]);
    expect(gameRows(null).every((row) => row.laps === 0)).toBe(true);
  });
});

describe('the connection checklist', () => {
  it('moves from nothing, to a computer connected and online, to laps arriving', () => {
    expect(checklistOf([], false, NOW)).toEqual({ connected: 'todo', online: 'todo', laps: 'todo' });
    expect(checklistOf([device({ last_seen_at: minutesAgo(90) })], false, NOW)).toEqual({ connected: 'done', online: 'todo', laps: 'todo' });
    expect(checklistOf([device()], true, NOW)).toEqual({ connected: 'done', online: 'done', laps: 'done' });
  });

  it('does not count a revoked computer as connected', () => {
    expect(checklistOf([device({ revoked_at: '2026-11-10T00:00:00.000Z' })], false, NOW).connected).toBe('todo');
  });
});
