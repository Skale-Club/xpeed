// The laps the person's computers sent to the account (Xpeed Companion uploads them by itself; server side: api/sim/laps).
// The list is metadata only; a lap file is downloaded when a lap is opened or compared, and kept in the local library so the
// second open is instant. A lap on the server and the same lap in the library are one lap: they share an identity.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';
import type { LapFile } from '@/lib/sim/lap-file';
import { addLapFile, lapIdentity, loadLap, type LapSummary, type LibraryLap } from '@/lib/sim/library';
import { readLapFile } from '@/lib/sim/read-lap-file';

/** A lap in the account, as the server lists it. */
export interface AccountLap {
  id: string;
  game: string;
  track: string;
  car: string;
  lapNumber: number;
  timeMs: number;
  valid: boolean;
  /** ISO 8601, UTC. */
  startedAt: string;
  sampleCount: number;
  sizeBytes: number;
  /** ISO time the server received it. */
  createdAt: string;
  deviceName: string | null;
}

/** A lap wherever it is kept: what the lists show, with the same identity for the server copy and the device copy. */
export interface LapEntry extends LibraryLap {
  /** The identity both copies share (see lapIdentity). */
  identity: string;
  onServer: boolean;
  onDevice: boolean;
  /** The id the server knows it by, when it is there. */
  serverId?: string;
  /** Epoch ms the server received it, when it is there. */
  receivedAt?: number;
  deviceName?: string | null;
}

export const accountLapSummary = (lap: AccountLap): LapSummary => ({
  game: lap.game,
  trackName: lap.track,
  carName: lap.car,
  lapNumber: lap.lapNumber,
  timeMs: lap.timeMs,
  valid: lap.valid,
  startedAt: lap.startedAt,
  sampleCount: lap.sampleCount,
});

async function request(path: string, method: 'GET' | 'DELETE'): Promise<Response | null> {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const response = await fetch(`${publicAppUrl()}${path}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

const isAccountLap = (value: unknown): value is AccountLap => {
  const lap = value as Partial<AccountLap> | null;
  return !!lap && typeof lap.id === 'string' && typeof lap.game === 'string' && typeof lap.track === 'string' && typeof lap.car === 'string'
    && typeof lap.lapNumber === 'number' && typeof lap.timeMs === 'number' && typeof lap.startedAt === 'string' && typeof lap.sampleCount === 'number';
};

/** The account's laps, newest first; null when they cannot be read (signed out, offline, or a server without this yet). */
export async function listAccountLaps(): Promise<AccountLap[] | null> {
  const response = await request('/api/sim/laps', 'GET');
  if (!response) return null;
  try {
    const body = (await response.json()) as { laps?: unknown[] };
    if (!Array.isArray(body.laps)) return null;
    return body.laps.filter(isAccountLap).map((lap) => ({
      ...lap,
      valid: lap.valid !== false,
      createdAt: lap.createdAt ?? lap.startedAt,
      deviceName: lap.deviceName ?? null,
    }));
  } catch {
    return null;
  }
}

async function downloadBlob(id: string): Promise<Blob | null> {
  const response = await request(`/api/sim/laps/${encodeURIComponent(id)}/file`, 'GET');
  return response ? response.blob() : null;
}

/** One lap's samples, parsed; null when the server does not have the file. Throws a LapReadError when it is not a lap. */
export async function downloadAccountLap(id: string): Promise<LapFile | null> {
  const blob = await downloadBlob(id);
  return blob ? readLapFile(blob) : null;
}

/** Forgets a lap in the account (the copy on the device is removed separately). */
export async function deleteAccountLap(id: string): Promise<boolean> {
  return (await request(`/api/sim/laps/${encodeURIComponent(id)}`, 'DELETE')) !== null;
}

/** The two lists as one: a lap in both appears once, and counts as on the server. */
export function mergeLaps(userId: string, local: readonly LibraryLap[], server: readonly AccountLap[]): LapEntry[] {
  const merged = new Map<string, LapEntry>();
  for (const lap of local) {
    const identity = lapIdentity(lap.summary);
    merged.set(identity, { ...lap, identity, onServer: false, onDevice: true });
  }
  for (const lap of server) {
    const summary = accountLapSummary(lap);
    const identity = lapIdentity(summary);
    const receivedAt = Date.parse(lap.createdAt) || 0;
    const remote = { onServer: true, serverId: lap.id, receivedAt, deviceName: lap.deviceName };
    const base = merged.get(identity);
    if (base) merged.set(identity, { ...base, ...remote });
    else {
      merged.set(identity, {
        // The key the library would keep it under, so a link made before the download still finds it afterwards.
        id: `${userId}|${identity}`,
        fileName: `${identity}.xlap.gz`,
        addedAt: receivedAt,
        size: lap.sizeBytes,
        summary,
        identity,
        onDevice: false,
        ...remote,
      });
    }
  }
  return [...merged.values()];
}

/** The library key of a lap named by a compare link: the key itself, or just the identity. */
export const libraryKey = (userId: string, id: string) => (id.startsWith(`${userId}|`) ? id : `${userId}|${id}`);

/**
 * A lap's samples by the id a compare link carries: the library key, or just the identity. Kept on the device, it is
 * read from there; otherwise it is downloaded from the account once and kept, so the next open is instant.
 * Null when neither has it. `account` may be passed when the list is already at hand.
 */
export async function openLap(userId: string, id: string, account?: readonly AccountLap[] | null): Promise<LapFile | null> {
  const key = libraryKey(userId, id);
  const here = await loadLap(userId, key);
  if (here) return here;
  const identity = key.slice(userId.length + 1);
  const list = account ?? (await listAccountLaps());
  const found = list?.find((lap) => lapIdentity(accountLapSummary(lap)) === identity);
  if (!found) return null;
  const blob = await downloadBlob(found.id);
  if (!blob) return null;
  const lap = await readLapFile(blob);
  // Keeping it is a convenience: a full or unavailable device still shows the lap.
  await addLapFile(userId, blob, `${identity}.xlap.gz`).catch(() => undefined);
  return lap;
}

export const ACCOUNT_LAPS_KEY = ['sim-account-laps'] as const;
/** How often the list is read again while a Virtual screen is open. */
export const ACCOUNT_LAPS_REFRESH_MS = 60_000;

/** The account's laps, read again when the window gets focus and every 60 s while a Virtual screen is open. */
export function useAccountLaps(userId: string | null) {
  return useQuery({
    queryKey: [...ACCOUNT_LAPS_KEY, userId],
    queryFn: async () => (await listAccountLaps()) ?? [],
    enabled: !!userId,
    refetchOnWindowFocus: true,
    refetchInterval: ACCOUNT_LAPS_REFRESH_MS,
    staleTime: 15_000,
  });
}

export function useRefreshAccountLaps() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ACCOUNT_LAPS_KEY });
}
