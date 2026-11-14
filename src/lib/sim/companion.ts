// What the Xpeed Companion screen knows how to say about the computers and the games, as plain functions (nothing here reads or draws anything).
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';

/**
 * A computer counts as online when the server heard from it this recently. Xpeed Companion 0.7 sends a heartbeat every minute while it runs (and a
 * lap or a track layout moves `last_seen_at` too), so three minutes is three missed beats and a little more: a computer that was switched off
 * shows as offline soon, and one with a slow minute does not flicker. An older Companion sends no heartbeat, so it is online only for a few
 * minutes after a lap; the site cannot tell more than the server heard.
 */
export const ONLINE_WINDOW_MS = 3 * 60_000;

export type DeviceState = 'online' | 'offline' | 'never' | 'revoked';

/** Online, offline (seen once, but not lately), never (paired and never heard from) or revoked. A date that cannot be read counts as never. */
export function deviceState(device: Pick<SimDevice, 'last_seen_at' | 'revoked_at'>, now = Date.now()): DeviceState {
  if (device.revoked_at) return 'revoked';
  const seen = device.last_seen_at ? Date.parse(device.last_seen_at) : Number.NaN;
  if (!Number.isFinite(seen)) return 'never';
  return now - seen <= ONLINE_WINDOW_MS ? 'online' : 'offline';
}

/** Whether the server heard from a computer in the last `ONLINE_WINDOW_MS` (the Overview reads it from the overview's own device object). */
export function isOnline(lastSeenAt: string | null | undefined, now = Date.now()): boolean {
  return deviceState({ last_seen_at: lastSeenAt ?? null, revoked_at: null }, now) === 'online';
}

/** What a running computer said it is doing in its last heartbeat. */
export type DeviceActivity = { kind: 'connected'; game: string | null } | { kind: 'waiting' } | { kind: 'idle' };

/**
 * What an online computer is doing, or null when it is not online (what it said is old then), said nothing (an older Xpeed Companion or server
 * sends no state) or said something this page does not know. A game connection with no game id is still a connection.
 */
export function deviceActivity(device: Pick<SimDevice, 'last_seen_at' | 'revoked_at' | 'last_state' | 'last_game'>, now = Date.now()): DeviceActivity | null {
  if (deviceState(device, now) !== 'online') return null;
  switch (device.last_state) {
    case 'connected': return { kind: 'connected', game: typeof device.last_game === 'string' && device.last_game !== '' ? device.last_game : null };
    case 'waiting': return { kind: 'waiting' };
    case 'idle': return { kind: 'idle' };
    default: return null;
  }
}

/** `0.7.0` (or `0.7.0-beta.1`, the tag ignored) as three numbers; null when it is not a version. */
export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:-[0-9A-Za-z.]{1,16})?$/.exec((text ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether a Companion at `version` is older than the newest one (`latest`). Unreadable on either side means no hint: never a false alarm. */
export function updateAvailable(version: string | null | undefined, latest: string | null | undefined): boolean {
  const [have, newest] = [parseVersion(version), parseVersion(latest)];
  if (!have || !newest) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== newest[i]) return have[i] < newest[i];
  return false;
}

/** The computers that can still send laps (online first, then the one heard from most recently, then never seen), then the revoked ones, newest connection first. */
export function splitDevices(devices: readonly SimDevice[], now = Date.now()): { live: SimDevice[]; revoked: SimDevice[] } {
  const rank = (device: SimDevice) => ({ online: 0, offline: 1, never: 2, revoked: 3 })[deviceState(device, now)];
  const seen = (device: SimDevice) => (device.last_seen_at ? Date.parse(device.last_seen_at) : 0) || 0;
  const created = (device: SimDevice) => Date.parse(device.created_at) || 0;
  return {
    live: devices.filter((device) => !device.revoked_at).sort((p, q) => rank(p) - rank(q) || seen(q) - seen(p) || created(q) - created(p)),
    revoked: devices.filter((device) => device.revoked_at).sort((p, q) => created(q) - created(p)),
  };
}

/** The games checked with the real game (laps, track map and inputs): the same ones the public /companion page lists first. */
export const CERTIFIED_GAMES: readonly string[] = ['ac', 'ams2'];
/** Supported, but still being checked with the real game. */
export const BETA_GAMES: readonly string[] = ['lmu', 'acc', 'acevo', 'f1', 'wreckfest2', 'iracing', 'r3e', 'rf1', 'fm'];

export type GameTier = 'certified' | 'beta';
export interface GameRow {
  game: string;
  tier: GameTier;
  /** Laps of the account in this game; 0 when none. */
  laps: number;
  /** When it was last driven (ISO), or null. */
  lastDrivenAt: string | null;
}

/**
 * The checklist of games: the certified ones first (in their order), then the beta ones, then any other game the account has laps in (those
 * are beta too: the server received them, so Xpeed Companion supports them). Each row carries what the account holds in that game.
 */
export function gameRows(lapsPerGame: ReadonlyArray<{ game: string; laps: number; lastDrivenAt: string }> | null | undefined): GameRow[] {
  const known = new Map((lapsPerGame ?? []).map((entry) => [entry.game, entry]));
  const row = (game: string, tier: GameTier): GameRow => ({ game, tier, laps: known.get(game)?.laps ?? 0, lastDrivenAt: known.get(game)?.lastDrivenAt ?? null });
  const listed = new Set([...CERTIFIED_GAMES, ...BETA_GAMES]);
  const extra = [...known.keys()].filter((game) => !listed.has(game)).sort();
  return [...CERTIFIED_GAMES.map((game) => row(game, 'certified')), ...BETA_GAMES.map((game) => row(game, 'beta')), ...extra.map((game) => row(game, 'beta'))];
}

export type StepState = 'done' | 'todo';
export interface ChecklistState {
  /** A computer is connected to the account. */
  connected: StepState;
  /** A connected computer was heard from lately. */
  online: StepState;
  /** The account has laps from Xpeed Companion. */
  laps: StepState;
}

/** Where the person is on the way from "nothing" to "laps arriving". The laps count as done only with a lap known to the account. */
export function checklistOf(devices: readonly SimDevice[], hasLaps: boolean, now = Date.now()): ChecklistState {
  const live = devices.filter((device) => !device.revoked_at);
  return {
    connected: live.length > 0 ? 'done' : 'todo',
    online: live.some((device) => deviceState(device, now) === 'online') ? 'done' : 'todo',
    laps: hasLaps ? 'done' : 'todo',
  };
}
