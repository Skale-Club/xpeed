// Racing data, social side: API v1 under /api/sim/v1/ (contract: docs/platform/API-V1.md, privacy: docs/platform/PRIVACY-MODEL.md).
//
//   GET/PATCH /v1/profile                         the person's own profile (created on first use), handle / displayName / visibility
//   GET       /v1/profiles/<handle>               another driver's page, as their visibility allows
//   GET       /v1/friends?status                  POST /v1/friends/requests {handle}      POST /v1/friends/requests/<handle>/accept|decline
//   DELETE    /v1/friends/<handle>                POST /v1/friends/<handle>/block
//   GET/POST  /v1/shares                          DELETE /v1/shares/<id>                  (the public side: api/sim/public.ts)
//   GET       /v1/leaderboard?track&car&scope     GET /v1/leaderboard/me?track&car&scope
//   POST      /v1/reports                         GET /v1/admin/reports   POST /v1/admin/reports/<id>   GET /v1/admin/laps/<id>   POST /v1/admin/recheck
//   GET       /v1/me/export                       DELETE /v1/me/data {"confirm":"delete my racing data"}
//
// The signed-in person only. The queries are database functions (sim_*) that take the person's id, which this file resolves from
// the token first; none of them is reachable by anyone else. An e-mail, a phone number or the account's real name is in no answer.
import { randomBytes } from 'node:crypto';
import { openBackend, type Backend } from '../_backend';
import { bearer, sha256Hex } from './_shared';
import { call, CURSOR_TIME, decodeCursor, failed, gameParam, Invalid, limitParam, paged, UUID, uuidParam, type Item } from './_v1util';
import { forgetOverview } from './_v1cache';
import { recheckLaps } from './_plausibility';

export type Send = (body: unknown, status?: number, extra?: Record<string, string>) => Response;
export type Problem = (error: string, status: number, extra?: Record<string, string>) => Response;
/** A 204: no body, with the app's CORS headers and never cached. */
export type Empty = () => Response;

const FIRST = new Set(['profile', 'profiles', 'friends', 'shares', 'leaderboard', 'reports', 'admin', 'me']);
export const isSocialPath = (parts: string[]) => FIRST.has(parts[0]);

// ---------------------------------------------------------------- the rules for a handle and a name

export const HANDLE = /^[a-z0-9_]{3,24}$/;
/** Words nobody can take as a handle: the product, roles, and the words the API itself uses in paths. */
export const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'staff', 'team', 'moderator', 'mod', 'mods', 'official', 'xpeed', 'xpeedapp', 'companion',
  'api', 'www', 'app', 'null', 'undefined', 'anonymous', 'deleted', 'unknown', 'driver', 'drivers', 'user', 'users', 'me', 'you', 'self', 'public', 'private',
  'friends', 'friend', 'requests', 'request', 'block', 'blocked', 'profile', 'profiles', 'leaderboard', 'share', 'shares', 'report', 'reports', 'login', 'logout', 'signup',
]);
const RESERVED_PREFIX = /^(xpeed|admin|moderator|staff|support)/;
export const VISIBILITIES = ['public', 'friends', 'private'] as const;
export const REPORT_REASONS = ['cheating', 'offensive_name', 'impersonation', 'spam', 'other'] as const;
export const DELETE_CONFIRMATION = 'delete my racing data';
const SCOPES = ['public', 'friends'] as const;
const FRIEND_STATUSES = ['accepted', 'incoming', 'outgoing', 'blocked'] as const;
const REPORT_STATUSES = ['open', 'dismissed', 'actioned', 'all'] as const;
const FORMAT_OR_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LOOKS_LIKE_EMAIL = /\S+@\S+/;

/** A handle as typed (or, with `decode`, as it is in a URL path): trimmed, lower case. Null when it cannot be a handle at all. */
export function readHandle(raw: unknown, decode = false): string | null {
  if (typeof raw !== 'string') return null;
  let text = raw;
  if (decode) { try { text = decodeURIComponent(raw); } catch { return null; } }
  const handle = text.trim().toLowerCase();
  return HANDLE.test(handle) ? handle : null;
}
const reservedHandle = (handle: string) => RESERVED_HANDLES.has(handle) || RESERVED_PREFIX.test(handle);

/** 1 to 40 characters, no control or invisible formatting characters, nothing that looks like an e-mail address. */
export function readDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new Invalid('invalid_display_name');
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > 40 || FORMAT_OR_CONTROL.test(name) || LOOKS_LIKE_EMAIL.test(name)) throw new Invalid('invalid_display_name');
  return name;
}

// ---------------------------------------------------------------- small helpers

type Body = Record<string, unknown>;

async function readBody(req: Request, { optional = false } = {}): Promise<Body> {
  const text = await req.text();
  if (text.trim() === '') { if (optional) return {}; throw new Invalid('invalid_body'); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Invalid('invalid_body'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Invalid('invalid_body');
  return parsed as Body;
}

/** Only the named fields; anything else is a mistake worth telling about. */
function only(body: Body, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new Invalid('invalid_request');
}

const oneOf = <T extends string>(value: string | null, list: readonly T[], fallback: T, code: string): T => {
  if (value === null || value === '') return fallback;
  if ((list as readonly string[]).includes(value)) return value as T;
  throw new Invalid(code);
};

/** Counts a use of a limited action in the database (so restarts and several instances share it). Seconds to wait, 0 when allowed. */
async function throttle(backend: Backend, key: string, max: number, windowSeconds: number): Promise<number> {
  const hit = await backend.service.rpc('sim_rate_hit', { p_key: key, p_max: max, p_window_seconds: windowSeconds });
  if (hit.error) throw hit.error;
  return Number(hit.data);
}

async function ensureProfile(backend: Backend, userId: string) {
  const made = await backend.service.rpc('sim_ensure_profile', { p_user: userId });
  if (made.error) throw made.error;
}

/** Splits an answer {status, ...rest} the database functions give. */
type Answered = { status: string } & Record<string, unknown>;
const run = async <T extends Answered>(backend: Backend, name: string, args: Record<string, unknown>) => call<T>(backend.service, name, args);

// ---------------------------------------------------------------- routing

interface Matched { name: string; methods: string[]; handle?: string | null; id?: string }

function match(parts: string[]): Matched | null {
  const [a, b, c, d] = parts;
  switch (a) {
    case 'profile': return parts.length === 1 ? { name: 'profile', methods: ['GET', 'PATCH'] } : null;
    case 'profiles': return parts.length === 2 ? { name: 'profilePage', methods: ['GET'], handle: readHandle(b, true) } : null;
    case 'friends':
      if (parts.length === 1) return { name: 'friends', methods: ['GET'] };
      if (b === 'requests') {
        if (parts.length === 2) return { name: 'friendRequest', methods: ['POST'] };
        if (parts.length === 4 && (d === 'accept' || d === 'decline')) return { name: d === 'accept' ? 'friendAccept' : 'friendDecline', methods: ['POST'], handle: readHandle(c, true) };
        return null;
      }
      if (parts.length === 2) return { name: 'friendRemove', methods: ['DELETE'], handle: readHandle(b, true) };
      if (parts.length === 3 && c === 'block') return { name: 'friendBlock', methods: ['POST'], handle: readHandle(b, true) };
      return null;
    case 'shares':
      if (parts.length === 1) return { name: 'shares', methods: ['GET', 'POST'] };
      if (parts.length === 2 && UUID.test(b)) return { name: 'shareRevoke', methods: ['DELETE'], id: b.toLowerCase() };
      return null;
    case 'leaderboard':
      if (parts.length === 1) return { name: 'leaderboard', methods: ['GET'] };
      if (parts.length === 2 && b === 'me') return { name: 'leaderboardMe', methods: ['GET'] };
      return null;
    case 'reports': return parts.length === 1 ? { name: 'report', methods: ['POST'] } : null;
    case 'admin':
      if (b === 'reports' && parts.length === 2) return { name: 'adminReports', methods: ['GET'] };
      if (b === 'reports' && parts.length === 3 && UUID.test(c)) return { name: 'adminDecide', methods: ['POST'], id: c.toLowerCase() };
      if (b === 'laps' && parts.length === 3 && UUID.test(c)) return { name: 'adminLap', methods: ['GET'], id: c.toLowerCase() };
      if (b === 'recheck' && parts.length === 2) return { name: 'adminRecheck', methods: ['POST'] };
      return null;
    case 'me':
      if (parts.length === 2 && b === 'export') return { name: 'export', methods: ['GET'] };
      if (parts.length === 2 && b === 'data') return { name: 'deleteData', methods: ['DELETE'] };
      return null;
    default: return null;
  }
}

export async function handleSocial(req: Request, parts: string[], out: { send: Send; problem: Problem; empty: Empty }): Promise<Response> {
  const { send, problem, empty } = out;
  const where = match(parts);
  if (!where) return problem('not_found', 404);
  if (!where.methods.includes(req.method)) return problem('method_not_allowed', 405, { Allow: where.methods.join(', ') });

  const backend = openBackend();
  if (!backend) return problem('unavailable', 503);
  const token = bearer(req);
  if (!token) return problem('unauthorized', 401);

  try {
    const userId = await backend.userId(token);
    if (!userId) return problem('unauthorized', 401);
    const params = new URL(req.url).searchParams;
    const wait = (seconds: number) => problem('too_many_requests', 429, { 'Retry-After': String(seconds) });

    switch (where.name) {
      // ------------------------------------------------------------ profile
      case 'profile': {
        if (req.method === 'GET') return send({ profile: await call(backend.service, 'sim_my_profile', { p_user: userId }) });
        const body = await readBody(req);
        only(body, ['handle', 'displayName', 'visibility']);
        if (body.handle === undefined && body.displayName === undefined && body.visibility === undefined) throw new Invalid('invalid_request');
        let handle: string | null = null;
        if (body.handle !== undefined) {
          handle = readHandle(body.handle);
          if (!handle) throw new Invalid('invalid_handle');
          if (reservedHandle(handle)) throw new Invalid('reserved_handle');
        }
        const displayName = body.displayName === undefined ? null : readDisplayName(body.displayName);
        let visibility: string | null = null;
        if (body.visibility !== undefined) {
          if (typeof body.visibility !== 'string' || !(VISIBILITIES as readonly string[]).includes(body.visibility)) throw new Invalid('invalid_visibility');
          visibility = body.visibility;
        }
        const slow = await throttle(backend, `profile:${userId}`, 60, 600);
        if (slow > 0) return wait(slow);
        const changed = await run<Answered & { retry_after?: number }>(backend, 'sim_set_profile', { p_user: userId, p_handle: handle, p_display: displayName, p_visibility: visibility });
        if (changed.status === 'taken') return problem('handle_taken', 409);
        if (changed.status === 'limit') return problem('handle_change_limit', 429, { 'Retry-After': String(changed.retry_after ?? 60) });
        return send({ profile: await call(backend.service, 'sim_my_profile', { p_user: userId }) });
      }
      case 'profilePage': {
        const slow = await throttle(backend, `lookup:${userId}`, 120, 60);
        if (slow > 0) return wait(slow);
        const page = where.handle ? await call<unknown | null>(backend.service, 'sim_profile_page', { p_viewer: userId, p_handle: where.handle }) : null;
        return page ? send({ profile: page }) : problem('profile_not_found', 404);
      }

      // ------------------------------------------------------------ friends
      case 'friends': {
        const status = oneOf(params.get('status'), FRIEND_STATUSES, 'accepted', 'invalid_status');
        const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
        await ensureProfile(backend, userId);
        const rows = await call<Item[]>(backend.service, 'sim_friend_list', { p_viewer: userId, p_status: status, p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 });
        const { items, nextCursor } = paged(rows, limit);
        return send({ friends: items, nextCursor });
      }
      case 'friendRequest': {
        const body = await readBody(req);
        only(body, ['handle']);
        const handle = readHandle(body.handle);
        const slow = await throttle(backend, `friend:${userId}`, 30, 3600);
        if (slow > 0) return wait(slow);
        // A handle that cannot exist answers like one nobody has: the same as a private profile.
        if (!handle) return problem('handle_not_found', 404);
        const made = await run<Answered & { friend?: unknown }>(backend, 'sim_friend_request', { p_me: userId, p_handle: handle });
        return friendOutcome(made, problem, send, { pending: 201, accepted: 200 });
      }
      case 'friendAccept':
      case 'friendDecline': {
        if (!where.handle) return problem('request_not_found', 404);
        const decided = await run<Answered & { friend?: unknown }>(backend, 'sim_friend_decide', { p_me: userId, p_handle: where.handle, p_accept: where.name === 'friendAccept' });
        if (decided.status === 'declined') return empty();
        if (decided.status === 'not_found') return problem('request_not_found', 404);
        return friendOutcome(decided, problem, send, { accepted: 200 });
      }
      case 'friendRemove': {
        if (!where.handle) return problem('friend_not_found', 404);
        const removed = await run(backend, 'sim_friend_remove', { p_me: userId, p_handle: where.handle });
        return removed.status === 'ok' ? empty() : problem('friend_not_found', 404);
      }
      case 'friendBlock': {
        if (!where.handle) return problem('handle_not_found', 404);
        const blocked = await run<Answered & { friend?: unknown }>(backend, 'sim_friend_block', { p_me: userId, p_handle: where.handle });
        return friendOutcome(blocked, problem, send, { ok: 200 });
      }

      // ------------------------------------------------------------ shares
      case 'shares': {
        if (req.method === 'GET') {
          const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
          const rows = await call<Item[]>(backend.service, 'sim_share_list', { p_user: userId, p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 });
          const { items, nextCursor } = paged(rows, limit);
          return send({ shares: items, nextCursor });
        }
        const body = await readBody(req);
        only(body, ['lapId', 'sessionId', 'expiresInDays']);
        const lapId = body.lapId === undefined || body.lapId === null ? null : typeof body.lapId === 'string' && UUID.test(body.lapId) ? body.lapId.toLowerCase() : 'bad';
        const sessionId = body.sessionId === undefined || body.sessionId === null ? null : typeof body.sessionId === 'string' && UUID.test(body.sessionId) ? body.sessionId.toLowerCase() : 'bad';
        if (lapId === 'bad') throw new Invalid('invalid_lap');
        if (sessionId === 'bad') throw new Invalid('invalid_session');
        if ((lapId === null) === (sessionId === null)) throw new Invalid('invalid_request');
        let expires: string | null = null;
        if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
          const days = body.expiresInDays;
          if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 365) throw new Invalid('invalid_expires');
          expires = new Date(Date.now() + days * 86_400_000).toISOString();
        }
        const slow = await throttle(backend, `share:${userId}`, 30, 3600);
        if (slow > 0) return wait(slow);
        await ensureProfile(backend, userId);
        // 32 random bytes: 43 URL-safe characters. Only the hash is stored; the token is shown here, once.
        const shareToken = randomBytes(32).toString('base64url');
        const made = await run<Answered & { share?: unknown }>(backend, 'sim_share_create', { p_user: userId, p_token_hash: sha256Hex(shareToken), p_lap: lapId, p_session: sessionId, p_expires: expires });
        if (made.status === 'not_found') return problem(lapId ? 'lap_not_found' : 'session_not_found', 404);
        if (made.status === 'limit') return problem('share_limit', 422);
        return send({ share: made.share, token: shareToken, path: `/api/sim/public/share/${shareToken}` }, 201);
      }
      case 'shareRevoke': {
        const revoked = await call<boolean>(backend.service, 'sim_share_revoke', { p_user: userId, p_id: where.id });
        return revoked ? empty() : problem('share_not_found', 404);
      }

      // ------------------------------------------------------------ leaderboards
      case 'leaderboard':
      case 'leaderboardMe': {
        const scope = oneOf(params.get('scope'), SCOPES, 'public', 'invalid_scope');
        const trackId = uuidParam(params, 'track'), carId = uuidParam(params, 'car'), game = gameParam(params);
        if (!trackId) throw new Invalid('invalid_track');
        if (!carId) throw new Invalid('invalid_car');
        const limit = where.name === 'leaderboard' ? limitParam(params) : 0;
        const after = where.name === 'leaderboard' ? decodeBoardCursor(params.get('cursor')) : null;
        const [track, car] = await Promise.all([
          backend.service.from('sim_track_catalog').select('id,game,name,length_m').eq('id', trackId).maybeSingle(),
          backend.service.from('sim_car_catalog').select('id,game,name,class').eq('id', carId).maybeSingle(),
        ]);
        if (track.error) throw track.error;
        if (car.error) throw car.error;
        if (!track.data) return problem('track_not_found', 404);
        if (!car.data) return problem('car_not_found', 404);
        if (game && game !== track.data.game) throw new Invalid('invalid_game');
        if (scope === 'friends' || where.name === 'leaderboardMe') await ensureProfile(backend, userId);
        const header = {
          game: track.data.game, scope,
          track: { id: track.data.id, name: track.data.name, lengthM: track.data.length_m ?? null },
          car: { id: car.data.id, name: car.data.name, class: car.data.class ?? null },
        };
        if (where.name === 'leaderboardMe') {
          const mine = await call<Record<string, unknown>>(backend.service, 'sim_leaderboard_me', { p_viewer: userId, p_track: trackId, p_car: carId, p_scope: scope });
          const { above, below, ...rest } = mine;
          return send({ ...header, ...rest, neighbours: { above, below } });
        }
        const rows = await call<Item[]>(backend.service, 'sim_leaderboard', {
          p_viewer: userId, p_track: trackId, p_car: carId, p_scope: scope,
          p_after_ms: after?.ms ?? null, p_after_t: after?.t ?? null, p_after_lap: after?.id ?? null, p_limit: limit + 1,
        });
        const kept = rows.slice(0, limit);
        const last = kept[kept.length - 1] as { _ms?: number; _t?: string; _i?: string } | undefined;
        const nextCursor = rows.length > limit && last?._t && last._i && typeof last._ms === 'number'
          ? Buffer.from(JSON.stringify([last._ms, last._t, last._i])).toString('base64url') : null;
        return send({ ...header, entries: kept.map(({ _ms, _t, _i, ...entry }) => entry), nextCursor });
      }

      // ------------------------------------------------------------ reports
      case 'report': {
        const body = await readBody(req);
        only(body, ['kind', 'handle', 'lapId', 'reason', 'details']);
        if (body.kind !== 'profile' && body.kind !== 'lap') throw new Invalid('invalid_kind');
        if (typeof body.reason !== 'string' || !(REPORT_REASONS as readonly string[]).includes(body.reason)) throw new Invalid('invalid_reason');
        let details: string | null = null;
        if (body.details !== undefined && body.details !== null) {
          if (typeof body.details !== 'string') throw new Invalid('invalid_details');
          const text = body.details.trim();
          const length = [...text].length;
          if (length > 300 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text.replace(/[\n\t]/g, ' '))) throw new Invalid('invalid_details');
          details = length === 0 ? null : text;
        }
        let handle: string | null = null, lapId: string | null = null;
        if (body.kind === 'profile') {
          handle = readHandle(body.handle);
          if (!handle) throw new Invalid('invalid_target');
        } else {
          if (typeof body.lapId !== 'string' || !UUID.test(body.lapId)) throw new Invalid('invalid_target');
          lapId = body.lapId.toLowerCase();
        }
        const slow = await throttle(backend, `report:${userId}`, 10, 3600);
        if (slow > 0) return wait(slow);
        const made = await run<Answered & { id?: string; createdAt?: string }>(backend, 'sim_report_create', {
          p_reporter: userId, p_kind: body.kind, p_handle: handle, p_lap: lapId, p_reason: body.reason, p_details: details,
        });
        if (made.status === 'not_found') return problem('target_not_found', 404);
        if (made.status === 'self') return problem('invalid_target', 400);
        if (made.status === 'duplicate') return problem('already_reported', 409);
        if (made.status === 'limit') return problem('too_many_open_reports', 422);
        return send({ report: { id: made.id, status: 'open', createdAt: made.createdAt } }, 201);
      }

      // ------------------------------------------------------------ moderation (the app's own admin check)
      case 'adminReports':
      case 'adminDecide':
      case 'adminLap':
      case 'adminRecheck': {
        const asPerson = await backend.asUser(token);
        const admin = await asPerson.rpc('is_admin_user');
        if (admin.error) throw admin.error;
        if (admin.data !== true) return problem('forbidden', 403);
        if (where.name === 'adminReports') {
          const status = oneOf(params.get('status'), REPORT_STATUSES, 'open', 'invalid_status');
          const limit = limitParam(params), after = decodeCursor(params.get('cursor'));
          const rows = await call<Item[]>(backend.service, 'sim_admin_reports', { p_status: status, p_after_t: after?.t ?? null, p_after_id: after?.id ?? null, p_limit: limit + 1 });
          const { items, nextCursor } = paged(rows, limit);
          return send({ reports: items, nextCursor });
        }
        if (where.name === 'adminLap') {
          const found = await call<unknown | null>(backend.service, 'sim_admin_lap', { p_lap: where.id });
          return found ? send(found) : problem('lap_not_found', 404);
        }
        if (where.name === 'adminRecheck') {
          const body = await readBody(req, { optional: true });
          only(body, ['limit']);
          let limit = 50;
          if (body.limit !== undefined) {
            if (typeof body.limit !== 'number' || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 200) throw new Invalid('invalid_limit');
            limit = body.limit;
          }
          return send(await recheckLaps(backend, limit));
        }
        const body = await readBody(req);
        only(body, ['action', 'hideTarget']);
        if (body.action !== 'dismiss' && body.action !== 'action' && body.action !== 'unhide') throw new Invalid('invalid_action');
        if (body.hideTarget !== undefined && typeof body.hideTarget !== 'boolean') throw new Invalid('invalid_request');
        const decided = await run<Answered & { report?: unknown }>(backend, 'sim_admin_decide', {
          p_id: where.id, p_admin: userId, p_action: body.action, p_hide: body.action === 'action' && body.hideTarget === true,
        });
        if (decided.status === 'not_found') return problem('report_not_found', 404);
        if (decided.status === 'already_decided') return problem('already_decided', 409);
        return send({ report: decided.report });
      }

      // ------------------------------------------------------------ privacy rights
      case 'export': {
        const slow = await throttle(backend, `export:${userId}`, 5, 3600);
        if (slow > 0) return wait(slow);
        const data = await call<Record<string, unknown> & { laps: { id: string; sizeBytes: number }[]; trackLayouts: { id: string; sizeBytes: number }[] }>(backend.service, 'sim_export_me', { p_user: userId });
        const body = {
          format: 'xpeed-virtual-export', version: 1, exportedAt: new Date().toISOString(), ...data,
          // The files are not in this document: each is downloaded with the same sign-in, one call per file.
          lapFiles: data.laps.map((lap) => ({ lapId: lap.id, sizeBytes: lap.sizeBytes, path: `/api/sim/v1/laps/${lap.id}/file` })),
          trackLayoutFiles: data.trackLayouts.map((layout) => ({ id: layout.id, sizeBytes: layout.sizeBytes, path: `/api/sim/tracks/${layout.id}/file` })),
        };
        return send(body, 200, { 'Content-Disposition': 'attachment; filename="xpeed-virtual-data.json"' });
      }
      case 'deleteData': {
        const body = await readBody(req, { optional: true });
        if (body.confirm !== DELETE_CONFIRMATION) return problem('confirmation_required', 400);
        const slow = await throttle(backend, `erase:${userId}`, 3, 3600);
        if (slow > 0) return wait(slow);
        const gone = await call<{ lapPaths: string[]; trackPaths: string[]; deleted: Record<string, unknown> }>(backend.service, 'sim_delete_my_data', { p_user: userId });
        forgetOverview(userId);
        // The rows are gone and nothing lists the files any more; a file this cannot remove is picked up by the orphan sweeper.
        await removeFiles(backend, 'sim-laps', userId, gone.lapPaths);
        await removeFiles(backend, 'sim-tracks', userId, gone.trackPaths);
        return send({ deleted: gone.deleted });
      }
      default: return problem('not_found', 404);
    }
  } catch (error) {
    if (error instanceof Invalid) return problem(error.code, 400);
    failed('sim_social_failed', error);
    return problem('unavailable', 503);
  }
}

/** The friendship functions' answers as HTTP: `ok` maps the statuses that are a success (status to HTTP code). */
function friendOutcome(made: Answered & { friend?: unknown }, problem: Problem, send: Send, ok: Record<string, number>): Response {
  if (made.status in ok) return send({ friend: made.friend }, ok[made.status]);
  switch (made.status) {
    case 'not_found': return problem('handle_not_found', 404);
    case 'self': return problem('invalid_target', 400);
    case 'blocked': return problem('blocked', 409);
    case 'already_friends': return problem('already_friends', 409);
    case 'already_requested': return problem('already_requested', 409);
    case 'friend_limit': return problem('friend_limit', 422);
    case 'pending_limit': return problem('pending_limit', 422);
    default: throw new Error(`unexpected friendship answer ${made.status}`);
  }
}

function decodeBoardCursor(raw: string | null): { ms: number; t: string; id: string } | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 3 && Number.isInteger(parsed[0]) && parsed[0] > 0 && parsed[0] < 2 ** 31
      && typeof parsed[1] === 'string' && CURSOR_TIME.test(parsed[1]) && typeof parsed[2] === 'string' && UUID.test(parsed[2])) {
      return { ms: parsed[0], t: parsed[1], id: parsed[2].toLowerCase() };
    }
  } catch { /* falls through */ }
  throw new Invalid('invalid_cursor');
}

/** Removes stored files: the ones the deleted rows named, then anything else still under the person's folder (a staging file, a leftover). */
async function removeFiles(backend: Backend, bucketName: string, userId: string, paths: string[]) {
  const bucket = backend.service.storage.from(bucketName);
  try {
    for (let i = 0; i < paths.length; i += 100) {
      const removed = await bucket.remove(paths.slice(i, i + 100));
      if (removed.error) failed('sim_erase_file_failed', removed.error);
    }
    for (let round = 0; round < 200; round++) {
      const listed = await bucket.list(userId, { limit: 100, offset: 0 });
      const names = ((listed.data ?? []) as { name: string; id: string | null }[]).filter((entry) => entry.id !== null).map((entry) => `${userId}/${entry.name}`);
      if (listed.error || names.length === 0) break;
      const removed = await bucket.remove(names);
      if (removed.error) { failed('sim_erase_file_failed', removed.error); break; }
    }
  } catch (error) {
    failed('sim_erase_file_failed', error);
  }
}
