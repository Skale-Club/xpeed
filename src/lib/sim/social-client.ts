// The typed client of the social side of the racing data API (docs/platform/API-V1.md, "Social side") and the React Query hooks the
// social screens read it through: profiles, friends, share links, leaderboards, reports, moderation, export and delete. It reuses
// the authenticated helpers and the V1Error of v1-client.ts. The one public call (a shared lap or session, `/api/sim/public/share`)
// is made WITHOUT a session: it sends no Authorization header and no cookies.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { publicAppUrl } from '@/lib/trips';
import {
  PAGE_SIZE, STALE, V1Error, failure, usePaged, useUserId, v1Delete, v1Get, v1GetBlob, v1Keys, v1Send, type V1Ref,
} from '@/lib/sim/v1-client';

// ---------------------------------------------------------------------------------------------------------------- objects

export type Visibility = 'public' | 'friends' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'friends', 'private'];
export type Scope = 'public' | 'friends';

/** The person's own profile. */
export interface MyProfile {
  handle: string;
  /** Never null for one's own profile, but screens treat it like everyone else's: a missing name shows the handle only. */
  displayName: string | null;
  visibility: Visibility;
  createdAt: string;
  /** How many handle changes are left in the current 30 days (0 to 3). */
  handleChangesLeft: number;
  /** When the oldest change leaves the window and one more is allowed; null while nothing is used. */
  handleChangesResetAt: string | null;
}

export type Relation = 'self' | 'friend' | 'requested' | 'incoming' | 'none';

/** What anybody else sees of a driver. */
export interface DriverPage {
  handle: string;
  displayName: string | null;
  joinedAt: string;
  isMe: boolean;
  relation: Relation;
  /** The owner only; null for everyone else. */
  visibility: Visibility | null;
  gamesPlayed: string[];
  personalBestsCount: number;
  bestLaps: Array<{ lapId: string; game: string; track: V1Ref; car: V1Ref; timeMs: number; achievedAt: string }>;
}

export type FriendStatus = 'accepted' | 'incoming' | 'outgoing' | 'blocked';

export interface Friend {
  handle: string;
  /** Null when that person's profile is private (the handle stays, so the friendship can be removed). */
  displayName: string | null;
  status: FriendStatus;
  since: string;
}

export interface Share {
  id: string;
  kind: 'lap' | 'session';
  lapId: string | null;
  sessionId: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
  /** What the link is about, in the list only (`GET /shares`): the track and car of the lap or session, the lap's time or the session's kind and laps. */
  trackName?: string | null;
  carName?: string | null;
  lapMs?: number | null;
  sessionKind?: 'practice' | 'qualifying' | 'race' | 'unknown' | null;
  lapCount?: number | null;
}

export interface CreatedShare { share: Share; token: string; path: string }

/** What a share link shows to whoever holds it. */
export interface PublicLapShare {
  kind: 'lap';
  createdAt: string;
  expiresAt: string | null;
  driver: { handle: string; displayName: string | null } | null;
  lap: {
    id: string; game: string; track: { name: string; lengthM: number | null }; car: { name: string; class: string | null }; lapNumber: number;
    timeMs: number; valid: boolean; startedAt: string; sectorsMs: number[] | null; topSpeedKmh: number | null;
  };
}
export interface PublicSessionShare {
  kind: 'session';
  createdAt: string;
  expiresAt: string | null;
  driver: { handle: string; displayName: string | null } | null;
  session: {
    game: string; track: { name: string; lengthM: number | null }; car: { name: string; class: string | null }; kind: string;
    startedAt: string; endedAt: string; weather: string | null; airTempC: number | null; trackTempC: number | null; lapCount: number; bestLapMs: number | null;
    laps: Array<{ id: string; lapNumber: number; timeMs: number; valid: boolean; startedAt: string; sectorsMs: number[] | null; topSpeedKmh: number | null }>;
  };
}
export type PublicShare = PublicLapShare | PublicSessionShare;

export interface LeaderboardEntry {
  rank: number;
  lapId: string;
  handle: string;
  displayName: string | null;
  timeMs: number;
  gapMs: number;
  achievedAt: string;
  isMe: boolean;
}

export interface LeaderboardMeta {
  game: string;
  scope: Scope;
  track: { id: string; name: string; lengthM: number | null };
  car: { id: string; name: string; class: string | null };
}

export interface LeaderboardMe extends LeaderboardMeta {
  total: number;
  me: LeaderboardEntry | null;
  reason: null | 'not_listed';
  neighbours: { above: LeaderboardEntry[]; below: LeaderboardEntry[] };
}

/** A track or a car that has at least one lap on the public boards (`GET /leaderboards/catalog`). */
export interface CatalogEntry {
  id: string;
  game: string;
  name: string;
  /** The public laps on the boards that count it (valid, plausible, visible). */
  lapCount: number;
  lengthM?: number | null;
  brand?: string | null;
  class?: string | null;
}
export type CatalogKind = 'track' | 'car';
export interface CatalogQuery { kind: CatalogKind; game?: string | null; track?: string | null; car?: string | null }

export type ReportReason = 'cheating' | 'offensive_name' | 'impersonation' | 'spam' | 'other';
export const REPORT_REASONS: readonly ReportReason[] = ['cheating', 'offensive_name', 'impersonation', 'spam', 'other'];
export type ReportTarget = { kind: 'profile'; handle: string } | { kind: 'lap'; lapId: string };
export const REPORT_DETAILS_MAX = 300;

export type ReportStatus = 'open' | 'dismissed' | 'actioned';
export interface AdminReport {
  id: string;
  kind: 'profile' | 'lap';
  status: ReportStatus;
  reason: ReportReason;
  details: string | null;
  createdAt: string;
  decidedAt: string | null;
  reporter: { handle: string; displayName: string | null };
  target:
    | { handle: string; displayName: string | null; visibility: Visibility; hidden: boolean }
    | { lapId: string; game: string; track: V1Ref | null; car: V1Ref | null; timeMs: number; plausible: boolean | null; hidden: boolean; owner: { handle: string; displayName: string | null } }
    | null;
}

export interface PlausibilityCheck { check: string; detail?: Record<string, unknown> }
export interface AdminLap {
  lap: {
    id: string; game: string; track: V1Ref | null; car: V1Ref | null; lapNumber: number; timeMs: number; valid: boolean; startedAt: string;
    sectorsMs: number[] | null; topSpeedKmh: number | null; sampleCount: number; sizeBytes: number; formatVersion: number | null; createdAt: string;
    marked: boolean; plausible: boolean | null; plausibility: { v: number; failed: PlausibilityCheck[] } | null; hidden: boolean;
  };
  owner: { handle: string; displayName: string | null; visibility: Visibility; hidden: boolean } | null;
  onLeaderboard: boolean;
  reports: Array<{ id: string; status: ReportStatus; reason: ReportReason; createdAt: string }>;
}
export type AdminAction = 'dismiss' | 'action' | 'unhide';
export interface RecheckResult { checked: number; plausible: number; implausible: number; remaining: number }
export type AdminReportFilter = 'open' | 'dismissed' | 'actioned' | 'all';

export interface DeletedSummary {
  laps: number; sessions: number; trackLayouts: number; shares: number; friendships: number; reports: number; devices: number; profile: number;
}

/** The sentence the server wants, exactly, to delete a person's racing data. */
export const DELETE_SENTENCE = 'delete my racing data';
/** The file name of the export, as the server names it. */
export const EXPORT_FILE_NAME = 'xpeed-virtual-data.json';

// ---------------------------------------------------------------------------------------------------------------- names

const LOOKS_LIKE_EMAIL = /\S+@\S+\.\S+/;
const LOOKS_LIKE_PHONE = /\+?\d[\d\s().-]{6,}\d/;

/**
 * A display name that is safe to put on screen: the trimmed name, or null (so the screen shows the handle alone) when it is empty or
 * looks like an e-mail address or a phone number. The server refuses such names and never sends an e-mail or a phone number; this is
 * the second lock, so nothing like that can ever be drawn from a field that should not have it.
 */
export function cleanName(name: string | null | undefined): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || LOOKS_LIKE_EMAIL.test(trimmed) || LOOKS_LIKE_PHONE.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------------------------------------------- paths

export const handlePath = (handle: string) => encodeURIComponent(handle);
/** The page of a driver. */
export const driverPath = (handle: string) => `/virtual/drivers/${handlePath(handle)}`;
/** The address that people open for a shared lap or session. */
export const sharePagePath = (token: string) => `/s/${encodeURIComponent(token)}`;
/** The page of a track (built by the Tracks screens). */
export const trackPagePath = (trackId: string) => `/virtual/tracks/${encodeURIComponent(trackId)}`;
/** A leaderboard, opened on a track and a car. */
export function leaderboardPath(options: { track?: string; car?: string; game?: string; scope?: Scope } = {}): string {
  const pairs = Object.entries(options).filter((entry): entry is [string, string] => !!entry[1]);
  return `/virtual/leaderboards${pairs.length ? `?${new URLSearchParams(pairs).toString()}` : ''}`;
}

// ---------------------------------------------------------------------------------------------------------------- errors

/** The profile field an error of a PATCH belongs to, so the screen can show it under that field. */
export type ProfileField = 'handle' | 'displayName' | 'visibility';
const FIELD_OF: Record<string, ProfileField> = {
  invalid_handle: 'handle', reserved_handle: 'handle', handle_taken: 'handle', handle_change_limit: 'handle',
  invalid_display_name: 'displayName', invalid_visibility: 'visibility',
};
export const errorCode = (error: unknown): string | null => (error instanceof V1Error ? error.code : null);
/** The profile field an error belongs to, or null when it is about the whole save (an outage, a rate limit). */
export const profileFieldOf = (error: unknown): ProfileField | null => FIELD_OF[errorCode(error) ?? ''] ?? null;

/**
 * Every code the social side can answer with that a screen words specially, mapped to the key of its sentence under `social.errors`.
 * Anything else falls back to `generic`, or to `offline` for a failure to reach the server and `signedOut` for a 401.
 */
const ERROR_KEYS = [
  'invalid_handle', 'reserved_handle', 'handle_taken', 'handle_change_limit', 'invalid_display_name', 'invalid_visibility',
  'handle_not_found', 'profile_not_found', 'request_not_found', 'friend_not_found', 'share_not_found', 'target_not_found', 'report_not_found',
  'lap_not_found', 'session_not_found',
  'already_friends', 'already_requested', 'blocked', 'already_reported', 'already_decided',
  'friend_limit', 'pending_limit', 'share_limit', 'too_many_open_reports', 'too_many_requests',
  'invalid_target', 'invalid_details', 'invalid_reason', 'invalid_expires', 'confirmation_required', 'forbidden',
] as const;
export type SocialErrorKey = (typeof ERROR_KEYS)[number] | 'generic' | 'offline' | 'signedOut' | 'unavailable';

/** The key (under `social.errors`) of the sentence for an error. */
export function socialErrorKey(error: unknown): SocialErrorKey {
  if (!(error instanceof V1Error)) return 'generic';
  if (error.status === 401) return 'signedOut';
  if (error.status === 0) return 'offline';
  if ((ERROR_KEYS as readonly string[]).includes(error.code)) return error.code as SocialErrorKey;
  if (error.status >= 500) return 'unavailable';
  return 'generic';
}

// ---------------------------------------------------------------------------------------------------------------- keys

/** Every query key of the social side, under the account's key so a delete or a sign-out clears them with the rest. */
export const socialKeys = {
  profile: (userId: string | null) => ['sim-v1', userId, 'social', 'profile'] as const,
  driver: (userId: string | null, handle: string | null) => ['sim-v1', userId, 'social', 'driver', handle] as const,
  friends: (userId: string | null, status: FriendStatus) => ['sim-v1', userId, 'social', 'friends', status] as const,
  shares: (userId: string | null) => ['sim-v1', userId, 'social', 'shares'] as const,
  board: (userId: string | null, query: BoardQuery) => ['sim-v1', userId, 'social', 'board', query] as const,
  boardMe: (userId: string | null, query: BoardQuery) => ['sim-v1', userId, 'social', 'board-me', query] as const,
  catalog: (userId: string | null, query: CatalogQuery) => ['sim-v1', userId, 'social', 'catalog', query] as const,
  requestCount: (userId: string | null) => ['sim-v1', userId, 'social', 'friends', 'request-count'] as const,
  adminReports: (userId: string | null, status: AdminReportFilter) => ['sim-v1', userId, 'social', 'admin-reports', status] as const,
  adminLap: (userId: string | null, id: string | null) => ['sim-v1', userId, 'social', 'admin-lap', id] as const,
  /** Public: no account, so no user id. */
  publicShare: (token: string | null) => ['sim-public-share', token] as const,
};

// ---------------------------------------------------------------------------------------------------------------- profile

/** The person's own profile (created by the server on the first read). */
export function useMyProfile() {
  const userId = useUserId();
  return useQuery({
    queryKey: socialKeys.profile(userId),
    queryFn: async () => (await v1Get<{ profile: MyProfile }>('/profile')).profile,
    enabled: !!userId,
    staleTime: STALE.detail,
  });
}

export interface ProfilePatch { handle?: string; displayName?: string; visibility?: Visibility }

/** `PATCH /profile`: the answer is the new profile, which replaces the cached one. */
export function useUpdateProfile() {
  const client = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: async (patch: ProfilePatch) => (await v1Send<{ profile: MyProfile }>('PATCH', '/profile', patch)).profile,
    onSuccess: (profile) => {
      client.setQueryData(socialKeys.profile(userId), profile);
      // The name on every board and page may have changed.
      void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'board'] });
      void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'driver'] });
    },
  });
}

/** A driver's page; `profile_not_found` (private, hidden, blocked or unknown) is one and the same answer. */
export function useDriver(handle: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: socialKeys.driver(userId, handle),
    queryFn: async () => (await v1Get<{ profile: DriverPage }>(`/profiles/${handlePath(handle ?? '')}`)).profile,
    enabled: !!userId && !!handle,
    staleTime: STALE.detail,
    retry: false,
  });
}

// ---------------------------------------------------------------------------------------------------------------- friends

/** The people in one list of friends: accepted ones, requests to the person, requests by the person, blocked ones. */
export function useFriends(status: FriendStatus) {
  const userId = useUserId();
  return usePaged<Friend>(socialKeys.friends(userId, status), '/friends', 'friends', { status }, { enabled: !!userId, staleTime: STALE.list });
}

/** How many people asked the person to be friends and still wait (one cheap call; the list of them is `useFriends('incoming')`). */
export function useFriendRequestCount() {
  const userId = useUserId();
  return useQuery({
    queryKey: socialKeys.requestCount(userId),
    queryFn: async () => (await v1Get<{ incoming: number }>('/friends/requests/count')).incoming,
    enabled: !!userId,
    staleTime: STALE.list,
    refetchOnWindowFocus: true,
  });
}

/** What a friendship action refreshes: the lists, the driver pages, and the friends boards. */
function useAfterFriendChange() {
  const client = useQueryClient();
  const userId = useUserId();
  return () => {
    void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'friends'] });
    void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'driver'] });
    void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'board'] });
    void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'board-me'] });
  };
}

/** Friend request by handle: `outgoing`, or `accepted` when that person had already asked. */
export function useSendFriendRequest() {
  const after = useAfterFriendChange();
  return useMutation({
    mutationFn: async (handle: string) => (await v1Send<{ friend: Friend }>('POST', '/friends/requests', { handle })).friend,
    onSuccess: after,
  });
}
export function useAcceptFriend() {
  const after = useAfterFriendChange();
  return useMutation({
    mutationFn: async (handle: string) => (await v1Send<{ friend: Friend }>('POST', `/friends/requests/${handlePath(handle)}/accept`)).friend,
    onSuccess: after,
  });
}
export function useDeclineFriend() {
  const after = useAfterFriendChange();
  return useMutation({ mutationFn: (handle: string) => v1Send('POST', `/friends/requests/${handlePath(handle)}/decline`), onSuccess: after });
}
/** Removes a friend, withdraws a request or lifts a block (the server decides which by the relation). */
export function useRemoveFriend() {
  const after = useAfterFriendChange();
  return useMutation({ mutationFn: (handle: string) => v1Delete(`/friends/${handlePath(handle)}`), onSuccess: after });
}
export function useBlockDriver() {
  const after = useAfterFriendChange();
  return useMutation({
    mutationFn: async (handle: string) => (await v1Send<{ friend: Friend }>('POST', `/friends/${handlePath(handle)}/block`)).friend,
    onSuccess: after,
  });
}

// ---------------------------------------------------------------------------------------------------------------- shares

/** The person's share links (never with the token), newest first. */
export function useShares(options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<Share>(socialKeys.shares(userId), '/shares', 'shares', {}, { enabled: !!userId && (options.enabled ?? true), staleTime: STALE.list });
}

/** Makes a link to a lap or a session. The answer carries the token: the only time it is ever given. */
export function useCreateShare() {
  const client = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: (input: { lapId?: string; sessionId?: string; expiresInDays?: number }) => v1Send<CreatedShare>('POST', '/shares', input),
    onSuccess: () => void client.invalidateQueries({ queryKey: socialKeys.shares(userId) }),
  });
}
export function useRevokeShare() {
  const client = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: (id: string) => v1Delete(`/shares/${encodeURIComponent(id)}`),
    onSuccess: () => void client.invalidateQueries({ queryKey: socialKeys.shares(userId) }),
  });
}

// ---------------------------------------------------------------------------------------------------------------- public share

/** The public call: no session, no Authorization header, no cookies. Throws a V1Error (404 `not_found` for any link that is not available). */
async function publicGet(path: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${publicAppUrl()}/api/sim/public/share/${path}`, { method: 'GET', cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new V1Error(0, 'network', true);
  }
  if (!response.ok) throw await failure(response);
  return response;
}

/** A shared lap or session by its token, read without signing in. */
export async function fetchPublicShare(token: string): Promise<PublicShare> {
  const response = await publicGet(encodeURIComponent(token));
  try {
    return (await response.json()) as PublicShare;
  } catch {
    throw new V1Error(response.status, 'bad_response', false);
  }
}

/** The lap file of a lap a share link covers, read without signing in. */
export async function fetchPublicShareFile(token: string, lapId: string): Promise<Blob> {
  return (await publicGet(`${encodeURIComponent(token)}/file/${encodeURIComponent(lapId)}`)).blob();
}

export function usePublicShare(token: string | null) {
  return useQuery({
    queryKey: socialKeys.publicShare(token),
    queryFn: () => fetchPublicShare(token ?? ''),
    enabled: !!token,
    staleTime: STALE.detail,
    // A link that is not available stays not available; an outage is tried once more.
    retry: (count, error) => error instanceof V1Error && (error.status === 0 || error.status >= 500) && count < 1,
    refetchOnWindowFocus: false,
  });
}

// ---------------------------------------------------------------------------------------------------------------- leaderboards

export interface BoardQuery { track: string | null; car: string | null; scope: Scope; game: string | null }
const boardParams = (query: BoardQuery) => ({ track: query.track, car: query.car, scope: query.scope, game: query.game });

/** The ranked table of a track and a car, a page at a time; `meta` is what the first page says about the board. */
export function useLeaderboard(query: BoardQuery) {
  const userId = useUserId();
  const result = useInfiniteQuery({
    queryKey: socialKeys.board(userId, query),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const body = await v1Get<LeaderboardMeta & { entries: LeaderboardEntry[]; nextCursor: string | null }>('/leaderboard', {
        ...boardParams(query), limit: PAGE_SIZE, cursor: pageParam,
      });
      return { meta: { game: body.game, scope: body.scope, track: body.track, car: body.car } as LeaderboardMeta, entries: body.entries ?? [], nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null };
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!userId && !!query.track && !!query.car,
    staleTime: STALE.list,
    refetchOnWindowFocus: true,
  });
  const entries = result.data?.pages.flatMap((page) => page.entries) ?? [];
  return { ...result, entries, meta: result.data?.pages[0]?.meta ?? null };
}

/**
 * The tracks or the cars that have public laps, to open a board for one the person never drove; alphabetical, a page at a time.
 * `track` narrows the cars to those with public laps on it, `car` the tracks to those the car has public laps on.
 */
export function useLeaderboardCatalog(query: CatalogQuery, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<CatalogEntry>(socialKeys.catalog(userId, query), '/leaderboards/catalog', 'items', { ...query }, {
    enabled: !!userId && (options.enabled ?? true), staleTime: STALE.catalog,
  });
}

/** Where the person stands on a board: their row, how many are on it, and two neighbours each side. */
export function useLeaderboardMe(query: BoardQuery) {
  const userId = useUserId();
  return useQuery({
    queryKey: socialKeys.boardMe(userId, query),
    queryFn: () => v1Get<LeaderboardMe>('/leaderboard/me', boardParams(query)),
    enabled: !!userId && !!query.track && !!query.car,
    staleTime: STALE.list,
  });
}

// ---------------------------------------------------------------------------------------------------------------- reports

export interface ReportInput { target: ReportTarget; reason: ReportReason; details?: string }

/** Reports a profile or a lap. Throws `already_reported` (409) when that report is still open. */
export function useReport() {
  return useMutation({
    mutationFn: (input: ReportInput) => {
      const details = input.details?.trim();
      return v1Send<{ report: { id: string; status: 'open'; createdAt: string } }>('POST', '/reports', {
        kind: input.target.kind,
        ...(input.target.kind === 'profile' ? { handle: input.target.handle } : { lapId: input.target.lapId }),
        reason: input.reason,
        ...(details ? { details } : {}),
      });
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------- moderation

/** The reports to decide on (moderators only: anybody else gets `forbidden`). */
export function useAdminReports(status: AdminReportFilter, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<AdminReport>(socialKeys.adminReports(userId, status), '/admin/reports', 'reports', { status }, {
    enabled: !!userId && (options.enabled ?? true), staleTime: STALE.list,
  });
}

export function useDecideReport() {
  const client = useQueryClient();
  const userId = useUserId();
  return useMutation({
    mutationFn: (input: { id: string; action: AdminAction; hideTarget?: boolean }) =>
      v1Send<{ report: AdminReport }>('POST', `/admin/reports/${encodeURIComponent(input.id)}`, {
        action: input.action,
        ...(input.hideTarget ? { hideTarget: true } : {}),
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: [...v1Keys.account(userId), 'social', 'admin-reports'] }),
  });
}

/** One lap with the plausibility details, for a moderator. */
export function useAdminLap(id: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: socialKeys.adminLap(userId, id),
    queryFn: () => v1Get<AdminLap>(`/admin/laps/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id,
    staleTime: STALE.detail,
    retry: false,
  });
}

/** One batch of the plausibility recheck. */
export function recheckLaps(limit = 50): Promise<RecheckResult> {
  return v1Send<RecheckResult>('POST', '/admin/recheck', { limit });
}

// ---------------------------------------------------------------------------------------------------------------- privacy rights

/** The person's data as one JSON file (at most 5 an hour). */
export function exportMyData(): Promise<Blob> {
  return v1GetBlob('/me/export');
}

/** Deletes the person's racing data (not the account). The sentence must be exactly `DELETE_SENTENCE`. */
export async function deleteMyRacingData(): Promise<DeletedSummary> {
  return (await v1Send<{ deleted: DeletedSummary }>('DELETE', '/me/data', { confirm: DELETE_SENTENCE })).deleted;
}
