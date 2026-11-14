import { describe, expect, it } from 'vitest';
import { BETA_GAMES, CERTIFIED_GAMES, ONLINE_WINDOW_MS, deviceActivity, deviceState, gameRows, isOnline, parseVersion, splitDevices, updateAvailable } from '@/lib/sim/companion';
import { BUILT_IN_GAME_NAMES } from '@/lib/sim/games';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const device = (over: Partial<SimDevice> = {}): SimDevice => ({ id: 'd', name: 'RIG', created_at: '2026-11-01T10:00:00.000Z', last_seen_at: minutesAgo(1), last_lap_at: null, revoked_at: null, ...over });

describe('the state of a computer', () => {
  it('is online when the server heard from it within three minutes, offline after, and never when it was never heard from', () => {
    expect(ONLINE_WINDOW_MS).toBe(3 * 60_000);
    expect(deviceState(device({ last_seen_at: minutesAgo(0) }), NOW)).toBe('online');
    expect(deviceState(device({ last_seen_at: new Date(NOW - ONLINE_WINDOW_MS).toISOString() }), NOW)).toBe('online');
    expect(deviceState(device({ last_seen_at: new Date(NOW - ONLINE_WINDOW_MS - 1000).toISOString() }), NOW)).toBe('offline');
    expect(deviceState(device({ last_seen_at: null }), NOW)).toBe('never');
    expect(deviceState(device({ last_seen_at: 'not a date' }), NOW)).toBe('never');
    // The old ten-minute window is gone: five minutes without a heartbeat is offline now.
    expect(deviceState(device({ last_seen_at: minutesAgo(2.9) }), NOW)).toBe('online');
    expect(deviceState(device({ last_seen_at: minutesAgo(5) }), NOW)).toBe('offline');
    expect(deviceState(device({ last_seen_at: minutesAgo(9) }), NOW)).toBe('offline');
  });

  it('reads the overview\'s own dates the same way', () => {
    expect(isOnline(minutesAgo(1), NOW)).toBe(true);
    expect(isOnline(minutesAgo(4), NOW)).toBe(false);
    expect(isOnline(null, NOW)).toBe(false);
    expect(isOnline(undefined, NOW)).toBe(false);
    expect(isOnline('not a date', NOW)).toBe(false);
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

describe('what a running computer says it is doing', () => {
  const beat = (over: Partial<SimDevice>) => device({ last_seen_at: minutesAgo(1), ...over });

  it('is connected to a game, waiting for one or paused, while the computer is online', () => {
    expect(deviceActivity(beat({ last_state: 'connected', last_game: 'ams2' }), NOW)).toEqual({ kind: 'connected', game: 'ams2' });
    expect(deviceActivity(beat({ last_state: 'waiting', last_game: null }), NOW)).toEqual({ kind: 'waiting' });
    expect(deviceActivity(beat({ last_state: 'idle' }), NOW)).toEqual({ kind: 'idle' });
    // A connection without a game id is still a connection.
    expect(deviceActivity(beat({ last_state: 'connected', last_game: null }), NOW)).toEqual({ kind: 'connected', game: null });
    expect(deviceActivity(beat({ last_state: 'connected', last_game: '' }), NOW)).toEqual({ kind: 'connected', game: null });
  });

  it('is nothing when the computer is offline (it is old news), revoked or never heard from', () => {
    expect(deviceActivity(beat({ last_state: 'connected', last_game: 'ac', last_seen_at: minutesAgo(10) }), NOW)).toBeNull();
    expect(deviceActivity(beat({ last_state: 'connected', last_game: 'ac', revoked_at: '2026-11-10T00:00:00.000Z' }), NOW)).toBeNull();
    expect(deviceActivity(beat({ last_state: 'connected', last_game: 'ac', last_seen_at: null }), NOW)).toBeNull();
  });

  it('is nothing from an older server or Companion: the fields are absent, null or something this page does not know', () => {
    expect(deviceActivity(beat({}), NOW)).toBeNull();
    expect(deviceActivity(beat({ last_state: null, last_game: null }), NOW)).toBeNull();
    expect(deviceActivity(beat({ last_state: 'sleeping' as never }), NOW)).toBeNull();
  });
});

describe('the version of Xpeed Companion', () => {
  it('reads 0.7.0 and 0.8.0-beta.1 as numbers, and nothing else', () => {
    expect(parseVersion('0.7.0')).toEqual([0, 7, 0]);
    expect(parseVersion(' 1.12.103 ')).toEqual([1, 12, 103]);
    expect(parseVersion('0.8.0-beta.1')).toEqual([0, 8, 0]);
    for (const odd of ['', '0.7', 'v0.7.0', '0.7.0.1', 'latest', '<b>0.7.0', null, undefined]) expect(parseVersion(odd as string | null | undefined), String(odd)).toBeNull();
  });

  it('says an update is available only when the computer\'s version is older than the newest', () => {
    expect(updateAvailable('0.6.2', '0.7.0')).toBe(true);
    expect(updateAvailable('0.7.0', '0.7.1')).toBe(true);
    expect(updateAvailable('0.9.9', '1.0.0')).toBe(true);
    expect(updateAvailable('0.7.0', '0.7.0')).toBe(false);
    expect(updateAvailable('0.7.1', '0.7.0')).toBe(false);
    expect(updateAvailable('0.10.0', '0.9.0')).toBe(false); // numbers, not text: 0.10 is newer than 0.9
    expect(updateAvailable('0.8.0-beta.1', '0.8.0')).toBe(false);
  });

  it('gives no hint when either version cannot be read or is missing: never a false alarm', () => {
    expect(updateAvailable(null, '0.7.0')).toBe(false);
    expect(updateAvailable(undefined, '0.7.0')).toBe(false);
    expect(updateAvailable('0.6.0', undefined)).toBe(false);
    expect(updateAvailable('0.6.0', 'soon')).toBe(false);
    expect(updateAvailable('dev', '0.7.0')).toBe(false);
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
