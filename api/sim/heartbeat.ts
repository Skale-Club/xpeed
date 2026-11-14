// POST /api/sim/heartbeat: Xpeed Companion says it is running (once a minute, and when a game connects or goes away), so the site can tell
// a computer that is on from one that only sent its last lap a while ago. Device key, like a lap upload; not a browser: no CORS headers.
//
//   { "version": "0.7.0", "state": "idle" | "waiting" | "connected", "game": "ams2" | null, "pendingLaps": 0 }
//
// Strict on the four fields; any other field is ignored (a newer Companion may send more). Nothing personal travels: no name, no path.
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

export const HEARTBEAT_STATES = ['idle', 'waiting', 'connected'] as const;
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number];

// 0.7.0, or 0.7.0-beta.1: numbers, then an optional short tag.
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,16})?$/;
const GAME_ID = /^[a-z][a-z0-9_]{0,31}$/;

export interface Heartbeat { version: string; state: HeartbeatState; game: string | null; pendingLaps: number }

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
  return { ok: true, value: { version, state: state as HeartbeatState, game, pendingLaps: Math.min(pendingLaps, MAX_PENDING_LAPS) } };
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
    const { version, state, game } = read.value;

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
    return reply({ ok: true });
  } catch (error) {
    failed(error);
    return refuse({ error: 'unavailable' }, 503, true);
  }
}
