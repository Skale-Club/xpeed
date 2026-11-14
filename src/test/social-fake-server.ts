import type {
  AdminLap, AdminReport, CatalogEntry, DeletedSummary, DriverPage, Friend, FriendStatus, LeaderboardEntry, MyProfile, PublicShare, Relation, Share, Visibility,
} from '@/lib/sim/social-client';
import { fakeV1State, handleV1, type FakeResponse, type FakeV1State } from '@/test/v1-fake-server';

// A fake of the social side of the racing data API (docs/platform/API-V1.md, "Social side") for tests and the screen harness: profiles,
// friends, share links, public shares, leaderboards, reports, moderation, export and delete, with the same paths, bodies, status codes
// and `{ error, retryable }` shape. It answers the signed-in paths itself and hands every other path to the read-side fake.

export interface FakeDriver {
  handle: string;
  displayName: string | null;
  visibility: Visibility;
  joinedAt: string;
  gamesPlayed: string[];
  personalBestsCount: number;
  bestLaps: DriverPage['bestLaps'];
  /** How this person stands with the signed-in one. */
  relation: Exclude<Relation, 'self'> | 'blocked';
  hidden?: boolean;
}

export interface FakeBoard { entries: LeaderboardEntry[]; game: string; track: { id: string; name: string; lengthM: number | null }; car: { id: string; name: string; class: string | null } }

export interface FakeRequest { method: string; path: string; params: Record<string, string>; body: unknown; authorization: string | null }

export interface FakeSocialState {
  /** The ordinary side (laps, sessions, tracks, cars): the social fake hands it every path it does not know. */
  v1: FakeV1State;
  me: MyProfile;
  drivers: FakeDriver[];
  /** The rows of the friend lists (the signed-in person's side). */
  friendRows: Friend[];
  shares: Share[];
  /** Public shares by token (what `GET /api/sim/public/share/<token>` answers); a share made through the fake adds its own. */
  publicTokens: Map<string, PublicShare>;
  /** What a new share link to a lap or a session shows. */
  shareable: { laps: Map<string, PublicShare>; sessions: Map<string, PublicShare> };
  /** Lap files for public shares, by lap id. */
  publicFiles: Map<string, Uint8Array>;
  /** Boards by `track|car|scope`. */
  boards: Map<string, FakeBoard>;
  /** The tracks and cars that have public laps (`GET /leaderboards/catalog`). */
  catalog: { tracks: CatalogEntry[]; cars: CatalogEntry[] };
  reports: AdminReport[];
  adminLaps: Map<string, AdminLap>;
  admin: boolean;
  recheckRemaining: number;
  /** Report targets already reported by the person (`profile:<handle>` or `lap:<id>`). */
  reported: Set<string>;
  deleted: DeletedSummary | null;
  requests: FakeRequest[];
  /** Makes every call fail with this status and error. */
  failing: { status: number; error: string; retryable: boolean } | null;
  delayMs: number;
  tokenCounter: number;
}

export const boardKey = (track: string, car: string, scope: string) => `${track}|${car}|${scope}`;

export function fakeSocialState(partial: Partial<FakeSocialState> = {}): FakeSocialState {
  return {
    v1: partial.v1 ?? fakeV1State(),
    me: { handle: 'lap_fan', displayName: 'Lap Fan', visibility: 'public', createdAt: '2026-10-01T10:00:00.000Z', handleChangesLeft: 3, handleChangesResetAt: null },
    drivers: [], friendRows: [], shares: [], publicTokens: new Map(), shareable: { laps: new Map(), sessions: new Map() }, publicFiles: new Map(),
    boards: new Map(), catalog: { tracks: [], cars: [] }, reports: [], adminLaps: new Map(), admin: false, recheckRemaining: 0, reported: new Set(), deleted: null, requests: [],
    failing: null, delayMs: 0, tokenCounter: 0, ...partial,
  };
}

export function driver(extra: Partial<FakeDriver> & { handle: string }): FakeDriver {
  return { displayName: extra.handle, visibility: 'public', joinedAt: '2026-09-01T10:00:00.000Z', gamesPlayed: ['lmu'], personalBestsCount: 0, bestLaps: [], relation: 'none', ...extra };
}

/** Ranks a list of times (fastest first): ties share a rank (1, 2, 2, 4), and the gap is to the leader. */
export function ranked(rows: Array<{ handle: string; displayName?: string | null; timeMs: number; isMe?: boolean; lapId?: string }>): LeaderboardEntry[] {
  const sorted = [...rows].sort((p, q) => p.timeMs - q.timeMs);
  return sorted.map((row, index) => ({
    rank: sorted.findIndex((other) => other.timeMs === row.timeMs) + 1,
    lapId: row.lapId ?? `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    handle: row.handle,
    displayName: row.displayName === undefined ? row.handle : row.displayName,
    timeMs: row.timeMs,
    gapMs: row.timeMs - sorted[0].timeMs,
    achievedAt: '2026-11-10T12:00:00.000Z',
    isMe: !!row.isMe,
  }));
}

// What the server wants, exactly, to delete a person's data (written out here on purpose: the fake does not import the client, so the harness
// can load it on the server side of Vite, where there is no window).
const DELETE_SENTENCE = 'delete my racing data';
const fail = (status: number, error: string, retryable = false): FakeResponse => ({ status, json: { error, retryable } });
const RESERVED = ['admin', 'support', 'me', 'requests', 'driver'];
const HANDLE = /^[a-z0-9_]{3,24}$/;
const encode = (offset: number) => `o${offset}`;
const decode = (cursor: string | undefined) => (cursor === undefined ? 0 : /^o\d+$/.test(cursor) ? Number(cursor.slice(1)) : -1);

function page<T>(items: T[], params: Record<string, string>, list: string): FakeResponse {
  const limitRaw = params.limit === undefined ? 50 : Number(params.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) return fail(400, 'invalid_limit');
  const limit = Math.min(limitRaw, 100);
  const start = decode(params.cursor);
  if (start < 0) return fail(400, 'invalid_cursor');
  const next = start + limit;
  return { status: 200, json: { [list]: items.slice(start, start + limit), nextCursor: next < items.length ? encode(next) : null } };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether the signed-in person could see this driver (a private, hidden or blocked one is the same as an unknown one). */
const visibleDriver = (state: FakeSocialState, handle: string): FakeDriver | null => {
  const found = state.drivers.find((entry) => entry.handle === handle);
  if (!found || found.hidden || found.relation === 'blocked') return null;
  if (found.visibility === 'private') return null;
  if (found.visibility === 'friends' && found.relation !== 'friend') return null;
  return found;
};

function setRelation(state: FakeSocialState, handle: string, relation: FakeDriver['relation'], status: FriendStatus | null) {
  const found = state.drivers.find((entry) => entry.handle === handle);
  if (found) found.relation = relation;
  state.friendRows = state.friendRows.filter((row) => row.handle !== handle);
  if (status) {
    state.friendRows.unshift({ handle, displayName: found && found.visibility !== 'private' ? found.displayName : null, status, since: '2026-11-13T09:00:00.000Z' });
  }
  return state.friendRows.find((row) => row.handle === handle) ?? null;
}

const SHARE_HEADS = new Set(['profile', 'profiles', 'friends', 'shares', 'leaderboard', 'leaderboards', 'reports', 'admin', 'me']);

/** Answers one call of the social side; `path` is what comes after `/api/sim/v1`. Anything else goes to the read side. */
export function handleSocial(state: FakeSocialState, method: string, path: string, params: Record<string, string>, body: unknown): FakeResponse {
  const parts = path.split('/').filter(Boolean);
  const [head, a, b, c] = parts;
  if (!SHARE_HEADS.has(head ?? '')) return handleV1(state.v1, method, path, params);
  if (state.failing) return fail(state.failing.status, state.failing.error, state.failing.retryable);

  switch (head) {
    case 'profile': {
      if (method === 'GET') return { status: 200, json: { profile: state.me } };
      if (method !== 'PATCH') return fail(405, 'method_not_allowed');
      if (!isObject(body)) return fail(400, 'invalid_body');
      const keys = Object.keys(body);
      if (keys.length === 0 || keys.some((key) => !['handle', 'displayName', 'visibility'].includes(key))) return fail(400, 'invalid_request');
      const next = { ...state.me };
      if ('visibility' in body) {
        if (!['public', 'friends', 'private'].includes(String(body.visibility))) return fail(400, 'invalid_visibility');
        next.visibility = body.visibility as Visibility;
      }
      if ('displayName' in body) {
        const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        if (name.length < 1 || name.length > 40 || /@/.test(name)) return fail(400, 'invalid_display_name');
        next.displayName = name;
      }
      if ('handle' in body) {
        const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
        if (!HANDLE.test(handle)) return fail(400, 'invalid_handle');
        if (RESERVED.includes(handle) || handle.startsWith('xpeed')) return fail(400, 'reserved_handle');
        if (handle !== state.me.handle) {
          if (state.drivers.some((entry) => entry.handle === handle)) return fail(409, 'handle_taken');
          if (state.me.handleChangesLeft <= 0) return fail(429, 'handle_change_limit', true);
          next.handle = handle;
          next.handleChangesLeft = state.me.handleChangesLeft - 1;
          next.handleChangesResetAt = state.me.handleChangesResetAt ?? '2026-12-13T09:00:00.000Z';
        }
      }
      state.me = next;
      return { status: 200, json: { profile: next } };
    }
    case 'profiles': {
      if (method !== 'GET' || !a) return fail(404, 'not_found');
      const handle = decodeURIComponent(a);
      if (handle === state.me.handle) {
        const profile: DriverPage = {
          handle: state.me.handle, displayName: state.me.displayName, joinedAt: state.me.createdAt, isMe: true, relation: 'self', visibility: state.me.visibility,
          gamesPlayed: ['lmu'], personalBestsCount: 0, bestLaps: [],
        };
        return { status: 200, json: { profile } };
      }
      const found = visibleDriver(state, handle);
      if (!found) return fail(404, 'profile_not_found');
      const profile: DriverPage = {
        handle: found.handle, displayName: found.displayName, joinedAt: found.joinedAt, isMe: false, relation: found.relation as Relation, visibility: null,
        gamesPlayed: found.gamesPlayed, personalBestsCount: found.personalBestsCount, bestLaps: found.bestLaps,
      };
      return { status: 200, json: { profile } };
    }
    case 'friends': {
      if (method === 'GET' && !a) {
        const status = (params.status ?? 'accepted') as FriendStatus;
        if (!['accepted', 'incoming', 'outgoing', 'blocked'].includes(status)) return fail(400, 'invalid_status');
        return page(state.friendRows.filter((row) => row.status === status), params, 'friends');
      }
      if (a === 'requests' && b === 'count' && !c) {
        if (method !== 'GET') return fail(405, 'method_not_allowed');
        return { status: 200, json: { incoming: state.friendRows.filter((row) => row.status === 'incoming').length } };
      }
      if (a === 'requests' && method === 'POST' && !b) {
        if (!isObject(body) || typeof body.handle !== 'string') return fail(400, 'invalid_request');
        const handle = body.handle.trim().toLowerCase();
        if (handle === state.me.handle) return fail(400, 'invalid_target');
        const found = state.drivers.find((entry) => entry.handle === handle);
        if (found?.relation === 'friend') return fail(409, 'already_friends');
        if (found?.relation === 'requested') return fail(409, 'already_requested');
        if (found?.relation === 'blocked' && state.friendRows.some((row) => row.handle === handle && row.status === 'blocked')) return fail(409, 'blocked');
        if (found?.relation === 'incoming') return { status: 200, json: { friend: setRelation(state, handle, 'friend', 'accepted') } };
        if (!found || found.visibility === 'private' || found.hidden || found.relation === 'blocked') return fail(404, 'handle_not_found');
        if (state.friendRows.filter((row) => row.status === 'accepted').length >= 200) return fail(422, 'friend_limit');
        return { status: 201, json: { friend: setRelation(state, handle, 'requested', 'outgoing') } };
      }
      if (a === 'requests' && b && c === 'accept' && method === 'POST') {
        const handle = decodeURIComponent(b);
        if (!state.friendRows.some((row) => row.handle === handle && row.status === 'incoming')) return fail(404, 'request_not_found');
        return { status: 200, json: { friend: setRelation(state, handle, 'friend', 'accepted') } };
      }
      if (a === 'requests' && b && c === 'decline' && method === 'POST') {
        const handle = decodeURIComponent(b);
        if (!state.friendRows.some((row) => row.handle === handle && row.status === 'incoming')) return fail(404, 'request_not_found');
        setRelation(state, handle, 'none', null);
        return { status: 204 };
      }
      if (a && b === 'block' && method === 'POST') {
        const handle = decodeURIComponent(a);
        const found = state.drivers.find((entry) => entry.handle === handle);
        if (!found || (found.visibility === 'private' && found.relation === 'none')) return fail(404, 'handle_not_found');
        return { status: 200, json: { friend: setRelation(state, handle, 'blocked', 'blocked') } };
      }
      if (a && !b && method === 'DELETE') {
        const handle = decodeURIComponent(a);
        if (!state.friendRows.some((row) => row.handle === handle)) return fail(404, 'friend_not_found');
        setRelation(state, handle, 'none', null);
        return { status: 204 };
      }
      return fail(404, 'not_found');
    }
    case 'shares': {
      if (method === 'GET' && !a) return page([...state.shares].sort((p, q) => Date.parse(q.createdAt) - Date.parse(p.createdAt)), params, 'shares');
      if (method === 'POST' && !a) {
        if (!isObject(body)) return fail(400, 'invalid_body');
        const lapId = typeof body.lapId === 'string' ? body.lapId : null;
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
        if ((lapId === null) === (sessionId === null)) return fail(400, 'invalid_request');
        const days = body.expiresInDays;
        if (days !== undefined && (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)) return fail(400, 'invalid_expires');
        const content = lapId ? state.shareable.laps.get(lapId) : state.shareable.sessions.get(sessionId!);
        if (!content) return fail(404, lapId ? 'lap_not_found' : 'session_not_found');
        if (state.shares.filter((entry) => entry.active).length >= 100) return fail(422, 'share_limit');
        state.tokenCounter++;
        const token = `tok${String(state.tokenCounter).padStart(40, 'x')}`;
        const createdAt = '2026-11-13T10:00:00.000Z';
        const share: Share = {
          id: `20000000-0000-4000-8000-${String(state.tokenCounter).padStart(12, '0')}`, kind: lapId ? 'lap' : 'session', lapId, sessionId, createdAt,
          expiresAt: typeof days === 'number' ? new Date(Date.parse(createdAt) + days * 86_400_000).toISOString() : null, revokedAt: null, active: true,
        };
        state.shares.unshift(share);
        state.publicTokens.set(token, content);
        return { status: 201, json: { share, token, path: `/api/sim/public/share/${token}` } };
      }
      if (method === 'DELETE' && a) {
        const share = state.shares.find((entry) => entry.id === a);
        if (!share) return fail(404, 'share_not_found');
        share.revokedAt = '2026-11-13T11:00:00.000Z';
        share.active = false;
        return { status: 204 };
      }
      return fail(404, 'not_found');
    }
    case 'leaderboard': {
      if (method !== 'GET') return fail(405, 'method_not_allowed');
      if (!params.track) return fail(400, 'invalid_track');
      if (!params.car) return fail(400, 'invalid_car');
      const scope = params.scope ?? 'public';
      if (!['public', 'friends'].includes(scope)) return fail(400, 'invalid_scope');
      const board = state.boards.get(boardKey(params.track, params.car, scope));
      const meta = { game: board?.game ?? params.game ?? 'lmu', scope, track: board?.track ?? { id: params.track, name: 'Track', lengthM: null }, car: board?.car ?? { id: params.car, name: 'Car', class: null } };
      const entries = board?.entries ?? [];
      if (a === 'me') {
        const index = entries.findIndex((entry) => entry.isMe);
        const me = index >= 0 ? entries[index] : null;
        return {
          status: 200,
          json: {
            ...meta, total: entries.length, me, reason: me ? null : 'not_listed',
            neighbours: me ? { above: entries.slice(Math.max(0, index - 2), index), below: entries.slice(index + 1, index + 3) } : { above: [], below: [] },
          },
        };
      }
      const limitRaw = params.limit === undefined ? 50 : Number(params.limit);
      if (!Number.isInteger(limitRaw) || limitRaw < 1) return fail(400, 'invalid_limit');
      const start = decode(params.cursor);
      if (start < 0) return fail(400, 'invalid_cursor');
      const limit = Math.min(limitRaw, 100);
      return { status: 200, json: { ...meta, entries: entries.slice(start, start + limit), nextCursor: start + limit < entries.length ? encode(start + limit) : null } };
    }
    case 'leaderboards': {
      if (a !== 'catalog' || b) return fail(404, 'not_found');
      if (method !== 'GET') return fail(405, 'method_not_allowed');
      const kind = params.kind ?? 'track';
      if (kind !== 'track' && kind !== 'car') return fail(400, 'invalid_kind');
      const listed = (kind === 'track' ? state.catalog.tracks : state.catalog.cars).filter((entry) => !params.game || entry.game === params.game);
      const answer = page([...listed].sort((p, q) => p.name.localeCompare(q.name)), params, 'items');
      return answer.json ? { ...answer, json: { kind, ...(answer.json as object) } } : answer;
    }
    case 'reports': {
      if (method !== 'POST' || a) return fail(404, 'not_found');
      if (!isObject(body)) return fail(400, 'invalid_body');
      if (body.kind !== 'profile' && body.kind !== 'lap') return fail(400, 'invalid_kind');
      if (!['cheating', 'offensive_name', 'impersonation', 'spam', 'other'].includes(String(body.reason))) return fail(400, 'invalid_reason');
      if (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > 300)) return fail(400, 'invalid_details');
      const key = body.kind === 'profile' ? `profile:${String(body.handle)}` : `lap:${String(body.lapId)}`;
      if (body.kind === 'profile' && body.handle === state.me.handle) return fail(400, 'invalid_target');
      if (body.kind === 'profile' && !visibleDriver(state, String(body.handle))) return fail(404, 'target_not_found');
      if (state.reported.has(key)) return fail(409, 'already_reported');
      state.reported.add(key);
      return { status: 201, json: { report: { id: `30000000-0000-4000-8000-${String(state.reported.size).padStart(12, '0')}`, status: 'open', createdAt: '2026-11-13T10:00:00.000Z' } } };
    }
    case 'admin': {
      if (!state.admin) return fail(403, 'forbidden');
      if (a === 'reports' && !b && method === 'GET') {
        const status = params.status ?? 'open';
        return page(state.reports.filter((report) => status === 'all' || report.status === status), params, 'reports');
      }
      if (a === 'reports' && b && method === 'POST') {
        const report = state.reports.find((entry) => entry.id === b);
        if (!report) return fail(404, 'report_not_found');
        if (!isObject(body) || !['dismiss', 'action', 'unhide'].includes(String(body.action))) return fail(400, 'invalid_action');
        if (report.status !== 'open' && body.action !== 'unhide') return fail(409, 'already_decided');
        const hide = body.hideTarget === true;
        report.status = body.action === 'action' ? 'actioned' : 'dismissed';
        report.decidedAt = '2026-11-13T12:00:00.000Z';
        if (report.target) report.target = { ...report.target, hidden: body.action === 'unhide' ? false : hide || report.target.hidden };
        return { status: 200, json: { report } };
      }
      if (a === 'laps' && b && method === 'GET') {
        const lap = state.adminLaps.get(b);
        return lap ? { status: 200, json: lap } : fail(404, 'lap_not_found');
      }
      if (a === 'recheck' && method === 'POST') {
        const limit = isObject(body) && typeof body.limit === 'number' ? body.limit : 50;
        const checked = Math.min(limit, state.recheckRemaining);
        state.recheckRemaining -= checked;
        return { status: 200, json: { checked, plausible: checked, implausible: 0, remaining: state.recheckRemaining } };
      }
      return fail(404, 'not_found');
    }
    case 'me': {
      if (a === 'export' && method === 'GET') {
        const document = {
          format: 'xpeed-virtual-export', version: 1, exportedAt: '2026-11-13T10:00:00.000Z',
          profile: { handle: state.me.handle, displayName: state.me.displayName, visibility: state.me.visibility, createdAt: state.me.createdAt, updatedAt: state.me.createdAt },
          friends: state.friendRows.map((row) => ({ handle: row.handle, status: row.status, since: row.since })),
          sessions: state.v1.sessions, laps: state.v1.laps, shares: state.shares,
        };
        return { status: 200, bytes: new TextEncoder().encode(JSON.stringify(document)) };
      }
      if (a === 'data' && method === 'DELETE') {
        if (!isObject(body) || body.confirm !== DELETE_SENTENCE) return fail(400, 'confirmation_required');
        const deleted: DeletedSummary = {
          laps: state.v1.laps.length, sessions: state.v1.sessions.length, trackLayouts: 0, shares: state.shares.length, friendships: state.friendRows.length,
          reports: state.reported.size, devices: state.v1.devices.length, profile: 1,
        };
        state.v1.laps = []; state.v1.sessions = []; state.shares = []; state.friendRows = []; state.deleted = deleted;
        return { status: 200, json: { deleted } };
      }
      return fail(404, 'not_found');
    }
    default:
      return fail(404, 'not_found');
  }
}

/** Answers the public share endpoint; `path` is what comes after `/api/sim/public/share/`. */
export function handlePublic(state: FakeSocialState, path: string): FakeResponse {
  if (state.failing) return fail(state.failing.status, state.failing.error, state.failing.retryable);
  const [token, file, lapId] = path.split('/').filter(Boolean);
  const share = token ? state.publicTokens.get(decodeURIComponent(token)) : undefined;
  if (!share) return fail(404, 'not_found');
  if (file === 'file') {
    const bytes = lapId ? state.publicFiles.get(decodeURIComponent(lapId)) : undefined;
    return bytes ? { status: 200, bytes } : fail(404, 'not_found');
  }
  return { status: 200, json: share };
}

/** A `fetch` that answers the signed-in social calls, the public share calls and (through the read-side fake) everything else. */
export function fakeSocialFetch(state: FakeSocialState) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const authorization = new Headers(init?.headers).get('authorization');
    let body: unknown;
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const params = Object.fromEntries(url.searchParams);
    const method = init?.method ?? 'GET';
    let answer: FakeResponse;
    const publicPrefix = '/api/sim/public/share/';
    const v1Prefix = '/api/sim/v1';
    if (url.pathname.startsWith(publicPrefix)) {
      state.requests.push({ method, path: url.pathname.slice(publicPrefix.length - 1), params, body, authorization });
      answer = handlePublic(state, url.pathname.slice(publicPrefix.length));
    } else if (url.pathname.startsWith(v1Prefix)) {
      const path = url.pathname.slice(v1Prefix.length);
      state.requests.push({ method, path, params, body, authorization });
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      answer = handleSocial(state, method, path, params, body);
    } else {
      return new Response(null, { status: 404 });
    }
    if (answer.bytes) return new Response(answer.bytes as BodyInit, { status: answer.status });
    return new Response(answer.json === undefined ? null : JSON.stringify(answer.json), { status: answer.status });
  };
}
