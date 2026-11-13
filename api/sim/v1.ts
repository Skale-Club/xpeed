// Racing data, read side: API v1 under /api/sim/v1/. The signed-in person only (a device key is not a sign-in: 401), cursor-paged,
// filterable, one error shape everywhere: { "error": "<code>", "retryable": <bool> }. Contract: docs/platform/API-V1.md.
//
//   GET    /v1/laps?game&track&car&session&valid&cursor&limit     GET /v1/laps/<id>/file     DELETE /v1/laps/<id>
//   GET    /v1/sessions?game&track&car&cursor&limit               GET /v1/sessions/<id>
//   GET    /v1/tracks?game&cursor&limit        GET /v1/tracks/<id>       GET /v1/cars?...        GET /v1/cars/<id>
//   GET    /v1/pbs?game&track&car&cursor&limit                    GET /v1/overview
//
// The queries are database functions (sim_v1_*) that run as the signed-in person, so row level security keeps everyone to their
// own rows; this file checks the parameters, pages with an opaque cursor and shapes the answer.
import type { SupabaseClient } from '@supabase/supabase-js';
import { openBackend } from '../_backend';
import { bearer, browserHeaders, MAX_ACCOUNT_BYTES, reply } from './_shared';
import { download, remove, type Answer } from './laps';
import { cachedOverview, rememberOverview } from './_v1cache';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAME = /^[a-z][a-z0-9_]{0,31}$/;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** A request the caller got wrong: the code names the parameter; nothing about it can work on a retry. */
class Invalid extends Error {
  constructor(readonly code: string) { super(code); }
}

type Item = Record<string, unknown> & { _k?: string; _i?: string };

const encodeCursor = (time: string, id: string) => Buffer.from(JSON.stringify([time, id])).toString('base64url');
function decodeCursor(raw: string | null): { t: string; id: string } | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      && CURSOR_TIME.test(parsed[0]) && UUID.test(parsed[1])) return { t: parsed[0], id: parsed[1].toLowerCase() };
  } catch { /* falls through */ }
  throw new Invalid('invalid_cursor');
}

function uuidParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value === null || value === '') return null;
  if (!UUID.test(value)) throw new Invalid(`invalid_${name}`);
  return value.toLowerCase();
}
function gameParam(params: URLSearchParams): string | null {
  const value = params.get('game');
  if (value === null || value === '') return null;
  if (!GAME.test(value)) throw new Invalid('invalid_game');
  return value;
}
function validParam(params: URLSearchParams): boolean | null {
  const value = params.get('valid');
  if (value === null || value === '') return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Invalid('invalid_valid');
}
/** 1 to 100, 50 when absent; a number above 100 is read as 100. */
function limitParam(params: URLSearchParams): number {
  const value = params.get('limit');
  if (value === null || value === '') return DEFAULT_LIMIT;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new Invalid('invalid_limit');
  return Math.min(Number(value), MAX_LIMIT);
}

/** The functions return up to limit + 1 items: the extra one says there is another page, and the cursor points after the last one kept. */
function paged(rows: Item[], limit: number): { items: Record<string, unknown>[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  const nextCursor = rows.length > limit && last?._k && last._i ? encodeCursor(last._k, last._i) : null;
  return { items: kept.map(({ _k, _i, ...item }) => item), nextCursor };
}

async function call<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const answer = await db.rpc(name, args);
  if (answer.error) throw answer.error;
  return answer.data as T;
}

const failed = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

type Resource = 'laps' | 'sessions' | 'tracks' | 'cars' | 'pbs' | 'overview';
const LISTS = new Set<string>(['laps', 'sessions', 'tracks', 'cars', 'pbs', 'overview']);
const WITH_ID = new Set<string>(['laps', 'sessions', 'tracks', 'cars']);

/** `<resource>`, `<resource>/<id>` or `laps/<id>/file`, and the methods each takes; null for any other path. */
function route(parts: string[]): { resource: Resource; id?: string; file?: boolean; methods: string[] } | null {
  const [resource, id, tail] = parts;
  if (parts.length === 1 && LISTS.has(resource)) return { resource: resource as Resource, methods: ['GET'] };
  if (parts.length >= 2 && !WITH_ID.has(resource)) return null;
  if (parts.length >= 2 && !UUID.test(id)) return null;
  if (parts.length === 2) return { resource: resource as Resource, id: id.toLowerCase(), methods: resource === 'laps' ? ['DELETE'] : ['GET'] };
  if (parts.length === 3 && resource === 'laps' && tail === 'file') return { resource: 'laps', id: id.toLowerCase(), file: true, methods: ['GET'] };
  return null;
}

export default async function v1(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  const url = new URL(req.url);
  const send: Answer = (body, status = 200, extra = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
  // Every error carries `retryable`: true for a throttle or an outage, false for what a retry cannot fix.
  const problem = (error: string, status: number, extra: Record<string, string> = {}) => send({ error, retryable: status === 429 || status >= 500 }, status, extra);
  // The handlers shared with /api/sim/laps answer { error } alone: this adds the flag.
  const shared: Answer = (body, status = 200, extra = {}) =>
    send(typeof body === 'object' && body !== null && 'error' in body && !('retryable' in body)
      ? { ...body, retryable: status === 429 || status >= 500 } : body, status, extra);

  const where = route(url.pathname.replace(/\/$/, '').split('/').slice(4)); // after /api/sim/v1
  if (!where) return problem('not_found', 404);
  if (!where.methods.includes(req.method)) return problem('method_not_allowed', 405, { Allow: where.methods.join(', ') });
  const { resource, id: lower } = where;

  const backend = openBackend();
  if (!backend) return problem('unavailable', 503);
  const token = bearer(req);
  if (!token) return problem('unauthorized', 401);

  try {
    if (resource === 'laps' && lower !== undefined) {
      // The same file download and deletion as /api/sim/laps/<id>/file and DELETE /api/sim/laps/<id>.
      return where.file ? await download(req, lower, shared) : await remove(req, lower, shared);
    }
    const userId = await backend.userId(token);
    if (!userId) return problem('unauthorized', 401);
    // As the person: the functions below run with their rights, so row level security decides what they see.
    const db = await backend.asUser(token);
    const params = url.searchParams;

    switch (resource) {
      case 'laps': {
        const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
        const rows = await call<Item[]>(db, 'sim_v1_laps', {
          p_game: gameParam(params), p_track: uuidParam(params, 'track'), p_car: uuidParam(params, 'car'), p_session: uuidParam(params, 'session'),
          p_valid: validParam(params), p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1,
        });
        const { items, nextCursor } = paged(rows, limit);
        return send({ laps: items, nextCursor });
      }
      case 'sessions': {
        if (lower !== undefined) {
          const found = await call<{ session: unknown; laps: unknown[] } | null>(db, 'sim_v1_session', { p_id: lower });
          return found ? send(found) : problem('session_not_found', 404);
        }
        const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
        const rows = await call<Item[]>(db, 'sim_v1_sessions', {
          p_game: gameParam(params), p_track: uuidParam(params, 'track'), p_car: uuidParam(params, 'car'),
          p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1,
        });
        const { items, nextCursor } = paged(rows, limit);
        return send({ sessions: items, nextCursor });
      }
      case 'tracks':
      case 'cars': {
        const one = resource === 'tracks' ? 'track' : 'car';
        if (lower !== undefined) {
          const found = await call<unknown | null>(db, `sim_v1_${one}`, { p_id: lower });
          return found ? send(found) : problem(`${one}_not_found`, 404);
        }
        const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
        const rows = await call<Item[]>(db, `sim_v1_${resource}`, { p_game: gameParam(params), p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 });
        const { items, nextCursor } = paged(rows, limit);
        return send({ [resource]: items, nextCursor });
      }
      case 'pbs': {
        const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
        const rows = await call<Item[]>(db, 'sim_v1_pbs', {
          p_game: gameParam(params), p_track: uuidParam(params, 'track'), p_car: uuidParam(params, 'car'),
          p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1,
        });
        const { items, nextCursor } = paged(rows, limit);
        return send({ pbs: items, nextCursor });
      }
      default: {
        // overview: cheap, and cached for 10 seconds per person (an upload or a deletion drops their entry).
        let body = cachedOverview(userId);
        if (body === undefined) {
          const overview = await call<{ storage: Record<string, unknown> } & Record<string, unknown>>(db, 'sim_v1_overview', {});
          body = { ...overview, storage: { ...overview.storage, limitBytes: MAX_ACCOUNT_BYTES } };
          rememberOverview(userId, body);
        }
        return send(body);
      }
    }
  } catch (error) {
    if (error instanceof Invalid) return problem(error.code, 400);
    failed('sim_v1_failed', error);
    return problem('unavailable', 503);
  }
}
