// Racing data, read side: API v1 under /api/sim/v1/. The signed-in person only (a device key is not a sign-in: 401), cursor-paged,
// filterable, one error shape everywhere: { "error": "<code>", "retryable": <bool> }. Contract: docs/platform/API-V1.md.
//
//   GET    /v1/laps?game&track&car&session&valid&cursor&limit     GET /v1/laps/<id>   GET /v1/laps/<id>/file   DELETE /v1/laps/<id>
//   GET    /v1/sessions?game&track&car&cursor&limit               GET /v1/sessions/<id>      DELETE /v1/sessions/<id>
//   GET    /v1/tracks?game&cursor&limit        GET /v1/tracks/<id>       GET /v1/cars?...        GET /v1/cars/<id>
//   GET    /v1/pbs?game&track&car&cursor&limit                    GET /v1/overview     GET /v1/stats?range (api/sim/_stats.ts)
//   profiles, friends, shares, leaderboards, reports, admin, me/export, me/data: api/sim/_social.ts
//
// The queries are database functions (sim_v1_*) that run as the signed-in person, so row level security keeps everyone to their
// own rows; this file checks the parameters, pages with an opaque cursor and shapes the answer.
import { openBackend } from '../_backend';
import { bearer, browserHeaders, MAX_ACCOUNT_BYTES, reply } from './_shared';
import { download, remove, removeSession, type Answer } from './laps';
import { cachedOverview, rememberOverview } from './_v1cache';
import { call, decodeCursor, DEFAULT_LIMIT, failed, gameParam, Invalid, limitParam, MAX_LIMIT, paged, UUID, uuidParam, type Item } from './_v1util';
import { handleSocial, isSocialPath } from './_social';
import { statsFor } from './_stats';

export { DEFAULT_LIMIT, MAX_LIMIT };

function validParam(params: URLSearchParams): boolean | null {
  const value = params.get('valid');
  if (value === null || value === '') return null;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Invalid('invalid_valid');
}

type Resource = 'laps' | 'sessions' | 'tracks' | 'cars' | 'pbs' | 'overview' | 'stats';
const LISTS = new Set<string>(['laps', 'sessions', 'tracks', 'cars', 'pbs', 'overview', 'stats']);
const WITH_ID = new Set<string>(['laps', 'sessions', 'tracks', 'cars']);

/** `<resource>`, `<resource>/<id>` or `laps/<id>/file`, and the methods each takes; null for any other path. */
function route(parts: string[]): { resource: Resource; id?: string; file?: boolean; methods: string[] } | null {
  const [resource, id, tail] = parts;
  if (parts.length === 1 && LISTS.has(resource)) return { resource: resource as Resource, methods: ['GET'] };
  if (parts.length >= 2 && !WITH_ID.has(resource)) return null;
  if (parts.length >= 2 && !UUID.test(id)) return null;
  if (parts.length === 2) return { resource: resource as Resource, id: id.toLowerCase(), methods: resource === 'laps' ? ['GET', 'DELETE'] : resource === 'sessions' ? ['GET', 'DELETE'] : ['GET'] };
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

  const parts = url.pathname.replace(/\/$/, '').split('/').slice(4); // after /api/sim/v1
  // Profiles, friends, shares, leaderboards, reports, moderation and the privacy rights: api/sim/_social.ts.
  if (isSocialPath(parts)) return handleSocial(req, parts, { send, problem, empty: () => new Response(null, { status: 204, headers: { ...browserHeaders(req), 'Cache-Control': 'private, no-store' } }) });
  const where = route(parts);
  if (!where) return problem('not_found', 404);
  if (!where.methods.includes(req.method)) return problem('method_not_allowed', 405, { Allow: where.methods.join(', ') });
  const { resource, id: lower } = where;

  const backend = openBackend();
  if (!backend) return problem('unavailable', 503);
  const token = bearer(req);
  if (!token) return problem('unauthorized', 401);

  try {
    if (resource === 'laps' && lower !== undefined && (where.file || req.method === 'DELETE')) {
      // The same file download and deletion as /api/sim/laps/<id>/file and DELETE /api/sim/laps/<id>.
      return where.file ? await download(req, lower, shared) : await remove(req, lower, shared);
    }
    if (resource === 'sessions' && lower !== undefined && req.method === 'DELETE') return await removeSession(req, lower, shared);
    const userId = await backend.userId(token);
    if (!userId) return problem('unauthorized', 401);
    // As the person: the functions below run with their rights, so row level security decides what they see.
    const db = await backend.asUser(token);
    const params = url.searchParams;

    switch (resource) {
      case 'laps': {
        if (lower !== undefined) {
          const found = await call<Item | null>(db, 'sim_v1_lap', { p_id: lower });
          return found ? send(found) : problem('lap_not_found', 404);
        }
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
      case 'stats': return send(await statsFor(db, userId, params));
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
