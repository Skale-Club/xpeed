// POST /api/sim/heartbeat: Xpeed Companion says it is running (once a minute, and when a game connects or goes away), so the site can tell
// a computer that is on from one that only sent its last lap a while ago. Device key, like a lap upload; not a browser: no CORS headers.
//
//   { "version": "0.8.0", "state": "idle" | "waiting" | "connected" | "needs_setup", "game": "ams2" | null, "pendingLaps": 0 }
//
// From Xpeed Companion 0.8.5 it may also say how the run is going (all optional; an older Companion sends none, a newer server reads what it knows):
//   "lapsSaved": 12, "lapsDropped": { "partial": 0, "short": 1, "failedSave": 0 }, "lapsRejected": 0,
//   "workers": { "failed": ["kunos"], "restarting": [] }, "games": [{ "id": "ac", "build": "1.16.3" | null }]
// Counts and ids only. A part that is malformed is dropped, never a reason to refuse the heartbeat (the Companion must be heard either way);
// the cleaned report is kept on the device row (`last_health`) for the site's computer card and the owner.
//
// `needs_setup` (Xpeed Companion 0.8): the game named in `game` is open but shares no data, so a setting in the game is off; the site's
// computer card then says which one to turn on (src/lib/sim/game-setup.ts).
//
// Strict on the four fields; any other field is ignored (a newer Companion may send more) except the report above, which is cleaned and kept. Nothing personal travels: no name, no path.
// `pendingLaps` is checked and capped (the laps waiting to be sent) but not kept: the site has no use for it.
// Answers 200 {"ok":true}; refusals are { error, retryable } like every upload refusal. Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md (2c).
import { openBackend } from '../_backend';
import { bearer, refuse, reply, sha256Hex } from './_shared';
import { forgetOverview } from './_v1cache';

/** Heartbeats one device may make in a minute (counted in the database, like the upload limiter): the Companion sends 1 a minute and a few for state changes. */
export const HEARTBEATS_PER_MINUTE = 30;
/** The body is a few dozen bytes; anything bigger is not a heartbeat. */
export const MAX_HEARTBEAT_BYTES = 2048;
/** A count of waiting laps above this is read as this. */
export const MAX_PENDING_LAPS = 1_000_000;

export const HEARTBEAT_STATES = ['idle', 'waiting', 'connected', 'needs_setup'] as const;
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number];

// 0.7.0, or 0.7.0-beta.1: numbers, then an optional short tag.
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,16})?$/;
const GAME_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** The cleaned report of how a Companion run is going (what is stored in `sim_devices.last_health`). */
export interface Health {
  lapsSaved: number;
  lapsDropped: { partial: number; short: number; failedSave: number };
  lapsRejected: number;
  workers: { failed: string[]; restarting: string[] };
  games: { id: string; build: string | null }[];
}

export interface Heartbeat { version: string; state: HeartbeatState; game: string | null; pendingLaps: number; health: Health | null }

/** The report keeps at most this many workers and games (a Companion has about ten workers and plays a handful of games). */
export const MAX_HEALTH_ITEMS = 12;
const WORKER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
// A game's own version text: printable, no markup that matters, cut to 64.
const BUILD = /^[\w .()+:/-]{1,64}$/;

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_PENDING_LAPS, Math.max(0, Math.trunc(value))) : 0);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && WORKER_ID.test(v)).slice(0, MAX_HEALTH_ITEMS) : []);

/** The report in a heartbeat, cleaned (unknown or malformed parts become empty or zero), or null when the Companion sent none of it. */
export function readHealth(input: Record<string, unknown>): Health | null {
  const { lapsSaved, lapsDropped, lapsRejected, workers, games } = input;
  if ([lapsSaved, lapsDropped, lapsRejected, workers, games].every((v) => v === undefined)) return null;
  const dropped = isObject(lapsDropped) ? lapsDropped : {};
  const w = isObject(workers) ? workers : {};
  const seen = new Set<string>();
  const list: { id: string; build: string | null }[] = [];
  for (const g of Array.isArray(games) ? games : []) {
    if (!isObject(g) || typeof g.id !== 'string' || !GAME_ID.test(g.id) || seen.has(g.id) || list.length >= MAX_HEALTH_ITEMS) continue;
    seen.add(g.id);
    list.push({ id: g.id, build: typeof g.build === 'string' && BUILD.test(g.build) ? g.build : null });
  }
  return {
    lapsSaved: count(lapsSaved),
    lapsDropped: { partial: count(dropped.partial), short: count(dropped.short), failedSave: count(dropped.failedSave) },
    lapsRejected: count(lapsRejected),
    workers: { failed: ids(w.failed), restarting: ids(w.restarting) },
    games: list,
  };
}

/** The heartbeat in a body, or the word for what is wrong with it. */
export function readHeartbeat(text: string): { ok: true; value: Heartbeat } | { ok: false; why: string } {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return { ok: false, why: 'invalid_json' }; }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, why: 'invalid_request' };
  const { version, state, game, pendingLaps } = input as Record<string, unknown>;
  if (typeof version !== 'string' || version.length > 32 || !VERSION.test(version)) return { ok: false, why: 'invalid_version' };
  if (typeof state !== 'string' || !(HEARTBEAT_STATES as readonly string[]).includes(state)) return { ok: false, why: 'invalid_state' };
  if (game !== null && (typeof game !== 'string' || !GAME_ID.test(game))) return { ok: false, why: 'invalid_game' };
  if (typeof pendingLaps !== 'number' || !Number.isInteger(pendingLaps) || pendingLaps < 0) return { ok: false, why: 'invalid_pending_laps' };
  return { ok: true, value: { version, state: state as HeartbeatState, game, pendingLaps: Math.min(pendingLaps, MAX_PENDING_LAPS), health: readHealth(input as Record<string, unknown>) } };
}

const failed = (error: unknown) => console.error(JSON.stringify({
  event: 'sim_heartbeat_failed',
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

export default async function heartbeat(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const key = bearer(req);
  if (!key) return refuse({ error: 'unauthorized' }, 401, false);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_HEARTBEAT_BYTES) return refuse({ error: 'too_large' }, 413, false);

  const backend = openBackend();
  if (!backend) return refuse({ error: 'unavailable' }, 503, true);
  try {
    const text = await req.text();
    if (text.length > MAX_HEARTBEAT_BYTES) return refuse({ error: 'too_large' }, 413, false);
    const read = readHeartbeat(text);
    if (!read.ok) return refuse({ error: read.why }, 400, false);
    const { version, state, game, health } = read.value;

    // One statement: the device behind the key, the rate count and the write. A revoked or unknown key is null.
    const done = await backend.service.rpc('sim_device_heartbeat', {
      p_token_hash: sha256Hex(key), p_version: version, p_state: state, p_game: game, p_max: HEARTBEATS_PER_MINUTE,
    });
    if (done.error) throw done.error;
    const answer = done.data as { status?: string; wait?: number; user_id?: string; changed?: boolean } | null;
    if (!answer) return refuse({ error: 'unauthorized' }, 401, false);
    if (answer.status === 'rate') return refuse({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(Math.max(1, Number(answer.wait) || 60)) });
    if (answer.status !== 'ok') throw new Error('unexpected sim_device_heartbeat answer');
    // The site's overview is cached for a few seconds; a game coming or going shows at once.
    if (answer.changed && answer.user_id) forgetOverview(answer.user_id);
    // How the run is going: kept as the last report. Never a reason to fail a heartbeat that was heard (an older database has no place for it yet).
    if (health) {
      const kept = await backend.service.rpc('sim_device_health', { p_token_hash: sha256Hex(key), p_health: health }).then((r) => r.error, (error: unknown) => error);
      if (kept) failed(kept);
    }
    return reply({ ok: true });
  } catch (error) {
    failed(error);
    return refuse({ error: 'unavailable' }, 503, true);
  }
}
