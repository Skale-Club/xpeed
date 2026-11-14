// The typed client of the racing data API (docs/platform/API-V1.md) and the React Query hooks every Virtual screen reads it
// through. One place for the base path, the error shape, the query keys, how long data stays fresh and what a delete refreshes.
import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';

// ---------------------------------------------------------------------------------------------------------------- errors

/**
 * What a call to the API failed with. `status` is the HTTP status (0 when the server could not be reached at all), `code` is the
 * server's `error` (or `network` / `bad_response`), and `retryable` says whether trying again can help (an outage, never a 4xx).
 */
export class V1Error extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryable: boolean, message?: string) {
    super(message ?? `${code} (${status})`);
    this.name = 'V1Error';
  }
}

/** Signed out (or the sign-in no longer works): a sign-in is needed, a retry would not help. */
export const isSignedOut = (error: unknown): boolean => error instanceof V1Error && error.status === 401;
/** The server or the network is out: the data on screen may be old, and trying again may work. */
export const isOutage = (error: unknown): boolean => error instanceof V1Error && error.retryable;

// ---------------------------------------------------------------------------------------------------------------- objects

export interface V1Ref { id: string; name: string }
export type SessionKind = 'practice' | 'qualifying' | 'race' | 'unknown';

export interface V1Lap {
  id: string;
  game: string;
  track: V1Ref | null;
  car: V1Ref | null;
  sessionId: string | null;
  lapNumber: number;
  timeMs: number;
  valid: boolean;
  startedAt: string;
  sectorsMs: number[] | null;
  topSpeedKmh: number | null;
  fuelUsedL: number | null;
  inLap: boolean | null;
  outLap: boolean | null;
  sampleCount: number;
  sizeBytes: number;
  reduced: boolean;
  formatVersion: number | null;
  createdAt: string;
  deviceName: string | null;
}

export interface V1Session {
  id: string;
  game: string;
  track: V1Ref;
  car: V1Ref;
  kind: SessionKind;
  origin: 'companion' | 'inferred';
  startedAt: string;
  endedAt: string;
  weather: string | null;
  airTempC: number | null;
  trackTempC: number | null;
  lapCount: number;
  bestLapMs: number | null;
}

export interface V1Pb {
  game: string;
  track: V1Ref;
  car: V1Ref;
  bestMs: number;
  lapId: string;
  achievedAt: string;
  /** The best this lap replaced (the best valid lap before it was driven); null for the first, or when nothing slower came before. */
  previousBestMs: number | null;
  /** How much faster than that, in ms (`previousBestMs - bestMs`); null with it. */
  improvedByMs: number | null;
}

export interface V1TrackItem {
  id: string;
  game: string;
  name: string;
  lengthM: number | null;
  lapCount: number;
  validLapCount: number;
  sessionCount: number;
  carCount: number;
  bestLapMs: number | null;
  lastDrivenAt: string;
  /** Whether Xpeed Companion sent a layout (the shape of the circuit) for this track, and its id. Absent from a server that predates it. */
  hasLayout?: boolean;
  layoutId?: string | null;
}

export interface V1CarItem {
  id: string;
  game: string;
  name: string;
  brand: string | null;
  class: string | null;
  lapCount: number;
  validLapCount: number;
  sessionCount: number;
  trackCount: number;
  bestLapMs: number | null;
  lastDrivenAt: string;
}

export interface V1DayCount { day: string; laps: number; validLaps: number }

export interface V1TrackDetail {
  track: { id: string; game: string; name: string; lengthM: number | null; hasLayout?: boolean; layoutId?: string | null };
  totals: { lapCount: number; validLapCount: number; sessionCount: number; carCount: number; bestLapMs: number | null; lastDrivenAt: string | null };
  progress: { bestPerDay: Array<{ day: string; bestMs: number; lapId: string; car: V1Ref }>; lapsPerDay: V1DayCount[] };
  bestPerCar: Array<{ car: V1Ref & { class: string | null }; lapCount: number; validLapCount: number; bestMs: number | null; lapId: string | null; achievedAt: string | null }>;
}

export interface V1CarDetail {
  car: { id: string; game: string; name: string; brand: string | null; class: string | null };
  totals: { lapCount: number; validLapCount: number; sessionCount: number; trackCount: number; bestLapMs: number | null; lastDrivenAt: string | null };
  /** `bestPerDay`: the fastest valid lap of each day on each track (lap times of different tracks cannot be compared), oldest day first. */
  progress: { bestPerDay: Array<{ day: string; bestMs: number; lapId: string; track: V1Ref }>; lapsPerDay: V1DayCount[] };
  bestPerTrack: Array<{ track: V1Ref; lapCount: number; validLapCount: number; bestMs: number | null; lapId: string | null; achievedAt: string | null }>;
}

/** One thing worth working on, from `GET /sessions/<id>/insights` (worked out from the stored lap metadata, no lap file). */
export type V1InsightFinding =
  | { kind: 'sectorGain'; sector: number; gainMs: number; lapId: string }
  | { kind: 'sectorSpread'; sector: number; stdDevMs: number; laps: number }
  | { kind: 'consistency'; stdDevMs: number; laps: number };

export interface V1SessionInsights {
  sessionId: string;
  source: 'metadata';
  lapsUsed: number;
  lapsConsidered: number;
  summary: { bestLapMs: number | null; bestLapId: string | null; averageMs: number | null; consistencyMs: number | null; sectors: unknown };
  findings: V1InsightFinding[];
}

export interface V1Overview {
  latestSessions: V1Session[];
  latestPersonalBests: V1Pb[];
  lapsPerGame: Array<{ game: string; laps: number; validLaps: number; sessions: number; lastDrivenAt: string }>;
  companion: {
    devices: Array<{ id: string; name: string; pairedAt: string; lastSeenAt: string | null; lastLapAt: string | null }>;
    lastLap: V1Lap | null;
  };
  storage: { lapCount: number; usedBytes: number; limitBytes: number };
}

/** The periods the dashboard reads (`GET /stats?range=`): the last 7, 30, 90 days, 12 months, or everything. */
export type StatsRange = '7d' | '30d' | '90d' | '1y' | 'all';
export const STATS_RANGES: readonly StatsRange[] = ['7d', '30d', '90d', '1y', 'all'];

export interface V1StatsTotals {
  laps: number;
  validLaps: number;
  sessions: number;
  /** The sum of the lap times, in ms. */
  timeMs: number;
  /** The track length times the laps driven, in meters (a track whose length is not known counts nothing). */
  distanceM: number;
  personalBests: number;
  tracks: number;
  cars: number;
  games: number;
}

export interface V1StatsDay {
  day: string;
  laps: number;
  validLaps: number;
  timeMs: number;
  distanceM: number;
  sessions: number;
  personalBests: number;
  tracks: number;
  cars: number;
}

export interface V1Improvement {
  lapId: string;
  trackId: string;
  trackName: string;
  carId: string;
  carName: string;
  game: string;
  timeMs: number;
  /** The best the person had before this lap on this track and car; null for the first valid lap there. */
  previousBestMs: number | null;
  savedMs: number | null;
  achievedAt: string;
}

export interface V1StatsPair {
  trackId: string;
  trackName: string;
  carId: string;
  carName: string;
  game: string;
  laps: number;
  bestPerDay: Array<{ day: string; bestMs: number }>;
}

export interface V1SpreadSession {
  sessionId: string;
  startedAt: string;
  validLaps: number;
  /** The standard deviation of the valid laps that are not in or out laps, in ms; null under 3 of them. */
  spreadMs: number | null;
  /** The share of the session's laps that are valid and not in or out laps, 0 to 1. */
  cleanShare: number;
}

export interface V1Stats {
  range: { key: StatsRange; from: string; to: string; days: number };
  totals: V1StatsTotals;
  /** The period of the same length just before the range (zeros for "all"). */
  previous: V1StatsTotals;
  /** Only the days that have laps, oldest first. */
  perDay: V1StatsDay[];
  /** Laps per day over the last 12 months (ranges of 90 days and more); null for a shorter range. */
  heatmapDays: Array<{ day: string; laps: number }> | null;
  streak: { current: number; best: number; bestDay: { day: string; laps: number } | null };
  improvements: V1Improvement[];
  pairs: V1StatsPair[];
  breakdown: {
    games: Array<{ game: string; laps: number; validLaps: number }>;
    tracks: Array<{ id: string; name: string; game: string; laps: number }>;
    cars: Array<{ id: string; name: string; game: string; laps: number }>;
  };
  consistency: V1SpreadSession[];
}

export interface LapFilters { game?: string; track?: string; car?: string; session?: string; valid?: boolean }
export interface SessionFilters { game?: string; track?: string; car?: string }
export interface CatalogFilters { game?: string }
export interface PbFilters { game?: string; track?: string; car?: string }

// ---------------------------------------------------------------------------------------------------------------- calls

export const V1_BASE = '/api/sim/v1';
/** How many items one page asks for. */
export const PAGE_SIZE = 50;

type Params = Record<string, string | number | boolean | null | undefined>;

const queryString = (params?: Params): string => {
  const pairs = Object.entries(params ?? {}).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '');
  return pairs.length === 0 ? '' : `?${new URLSearchParams(pairs.map(([key, value]) => [key, String(value)])).toString()}`;
};

export async function failure(response: Response): Promise<V1Error> {
  let body: { error?: unknown; retryable?: unknown } | null = null;
  try {
    body = (await response.json()) as { error?: unknown; retryable?: unknown };
  } catch {
    body = null;
  }
  const code = typeof body?.error === 'string' ? body.error : response.status === 401 ? 'unauthorized' : response.status >= 500 ? 'unavailable' : 'error';
  const retryable = typeof body?.retryable === 'boolean' ? body.retryable : response.status >= 500;
  return new V1Error(response.status, code, retryable);
}

type Method = 'GET' | 'DELETE' | 'POST' | 'PATCH';

async function call(method: Method, path: string, params?: Params, body?: unknown): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new V1Error(401, 'unauthorized', false);
  let response: Response;
  try {
    response = await fetch(`${publicAppUrl()}${V1_BASE}${path}${queryString(params)}`, {
      method,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new V1Error(0, 'network', true);
  }
  if (!response.ok) throw await failure(response);
  return response;
}

/** POST, PATCH or DELETE a path of the API with an optional JSON body; the answer is the JSON (undefined for `204`). Throws a V1Error. */
export async function v1Send<T = undefined>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await call(method, path, undefined, body);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new V1Error(response.status, 'bad_response', false);
  }
}

/** GET a path of the API as JSON. Throws a V1Error. */
export async function v1Get<T>(path: string, params?: Params): Promise<T> {
  const response = await call('GET', path, params);
  try {
    return (await response.json()) as T;
  } catch {
    throw new V1Error(response.status, 'bad_response', false);
  }
}

/** GET a path of the API as bytes (a lap file). Throws a V1Error. */
export async function v1GetBlob(path: string): Promise<Blob> {
  return (await call('GET', path)).blob();
}

/** DELETE a path of the API. Throws a V1Error. */
export async function v1Delete(path: string): Promise<void> {
  await call('DELETE', path);
}

export const lapPath = (lapId: string) => `/laps/${encodeURIComponent(lapId)}`;
export const lapFilePath = (lapId: string) => `${lapPath(lapId)}/file`;

// ---------------------------------------------------------------------------------------------------------------- keys

/** How long what was read stays fresh (ms). A list is read again when the window gets focus once it is older than this. */
export const STALE = { list: 15_000, detail: 30_000, overview: 10_000, stats: 20_000, catalog: 60_000 } as const;
/** How often what is on screen is read again while a Virtual page is open. */
export const REFRESH_MS = 60_000;

/** Every query key of the API, under the account so that another sign-in never sees these answers. */
export const v1Keys = {
  all: ['sim-v1'] as const,
  account: (userId: string | null) => ['sim-v1', userId] as const,
  laps: (userId: string | null, filters: LapFilters) => ['sim-v1', userId, 'laps', filters] as const,
  sessions: (userId: string | null, filters: SessionFilters) => ['sim-v1', userId, 'sessions', filters] as const,
  session: (userId: string | null, id: string | null) => ['sim-v1', userId, 'session', id] as const,
  tracks: (userId: string | null, filters: CatalogFilters) => ['sim-v1', userId, 'tracks', filters] as const,
  track: (userId: string | null, id: string | null) => ['sim-v1', userId, 'track', id] as const,
  cars: (userId: string | null, filters: CatalogFilters) => ['sim-v1', userId, 'cars', filters] as const,
  car: (userId: string | null, id: string | null) => ['sim-v1', userId, 'car', id] as const,
  pbs: (userId: string | null, filters: PbFilters) => ['sim-v1', userId, 'pbs', filters] as const,
  overview: (userId: string | null) => ['sim-v1', userId, 'overview'] as const,
  stats: (userId: string | null, range: StatsRange) => ['sim-v1', userId, 'stats', range] as const,
};

/** After laps or a session are deleted: everything derived from them (lists, counters, personal bests, overview) is read again. */
export function invalidateAfterDelete(client: QueryClient, userId: string | null): Promise<void> {
  return client.invalidateQueries({ queryKey: v1Keys.account(userId) });
}

// ---------------------------------------------------------------------------------------------------------------- hooks

/** One paged list: `items` is every page read so far, `fetchNextPage` (the "Load more" button) reads one more. */
export function usePaged<T>(
  key: readonly unknown[],
  path: string,
  list: string,
  params: Params,
  options: { enabled: boolean; refresh?: boolean; staleTime: number },
) {
  const result = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const body = await v1Get<Record<string, unknown>>(path, { ...params, limit: PAGE_SIZE, cursor: pageParam });
      return { items: Array.isArray(body[list]) ? (body[list] as T[]) : [], nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null };
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: options.enabled,
    staleTime: options.staleTime,
    refetchOnWindowFocus: true,
    refetchInterval: options.refresh ? REFRESH_MS : false,
  });
  const items = result.data?.pages.flatMap((page) => page.items) ?? [];
  return { ...result, items };
}

export const useUserId = (): string | null => useAuth().user?.id ?? null;

/** The laps, newest first, a page at a time. */
export function useLaps(filters: LapFilters = {}, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<V1Lap>(v1Keys.laps(userId, filters), '/laps', 'laps', { ...filters }, { enabled: !!userId && (options.enabled ?? true), staleTime: STALE.list });
}

/** The sessions, newest first, a page at a time. */
export function useSessions(filters: SessionFilters = {}, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<V1Session>(v1Keys.sessions(userId, filters), '/sessions', 'sessions', { ...filters }, {
    enabled: !!userId && (options.enabled ?? true),
    staleTime: STALE.list,
    refresh: true,
  });
}

/** One session with its laps in driving order. */
export function useSession(id: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.session(userId, id),
    queryFn: () => v1Get<{ session: V1Session; laps: V1Lap[] }>(`/sessions/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id,
    staleTime: STALE.detail,
    refetchOnWindowFocus: true,
    refetchInterval: REFRESH_MS,
  });
}

/** The tracks the person has driven, most recently driven first. */
export function useTracks(filters: CatalogFilters = {}, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<V1TrackItem>(v1Keys.tracks(userId, filters), '/tracks', 'tracks', { ...filters }, { enabled: !!userId && (options.enabled ?? true), staleTime: STALE.catalog });
}

export function useTrack(id: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.track(userId, id),
    queryFn: () => v1Get<V1TrackDetail>(`/tracks/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id,
    staleTime: STALE.detail,
  });
}

/** The cars the person has driven, most recently driven first. */
export function useCars(filters: CatalogFilters = {}, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<V1CarItem>(v1Keys.cars(userId, filters), '/cars', 'cars', { ...filters }, { enabled: !!userId && (options.enabled ?? true), staleTime: STALE.catalog });
}

export function useCar(id: string | null) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.car(userId, id),
    queryFn: () => v1Get<V1CarDetail>(`/cars/${encodeURIComponent(id ?? '')}`),
    enabled: !!userId && !!id,
    staleTime: STALE.detail,
  });
}

/** The personal bests, most recently achieved first. With a track and a car it is the one best of that pair. */
export function usePbs(filters: PbFilters = {}, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return usePaged<V1Pb>(v1Keys.pbs(userId, filters), '/pbs', 'pbs', { ...filters }, { enabled: !!userId && (options.enabled ?? true), staleTime: STALE.list });
}

/** The home page's numbers: read again every 60 s while a Virtual page is open, and when the window gets focus. */
export function useOverview() {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.overview(userId),
    queryFn: () => v1Get<V1Overview>('/overview'),
    enabled: !!userId,
    staleTime: STALE.overview,
    refetchOnWindowFocus: true,
    refetchInterval: REFRESH_MS,
  });
}

/**
 * The dashboard's numbers for a range, read again every 60 s while the page is open. Changing the range keeps the old numbers on screen
 * (`isPlaceholderData`) until the new ones arrive, so the page does not collapse into a skeleton at every click.
 */
export function useStats(range: StatsRange, options: { enabled?: boolean } = {}) {
  const userId = useUserId();
  return useQuery({
    queryKey: v1Keys.stats(userId, range),
    queryFn: () => v1Get<V1Stats>('/stats', { range }),
    enabled: !!userId && (options.enabled ?? true),
    staleTime: STALE.stats,
    // The old range's numbers stay up while the new ones load, but never another account's.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === userId ? previous : undefined),
    refetchOnWindowFocus: true,
    refetchInterval: REFRESH_MS,
  });
}
