// The track layouts kept in the account (Xpeed Companion sends them by itself; server side: api/sim/tracks).
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md. The web keeps a copy of each on the device (the track
// library), so the compare screen works without asking the server every time.
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';
import { sameTrackIdentity, trackKeyOf } from '@/lib/sim/track-file';
import { readTrackFile } from '@/lib/sim/read-track-file';
import { keepAccountTrack, listTracks, loadAccountTrack } from '@/lib/sim/track-library';
import { DEMO_USER_ID, isDemoMode } from '@/lib/sim/demo/mode';

export interface AccountTrack {
  id: string;
  game: string;
  trackName: string;
  variant: string | null;
  title: string | null;
  lengthM: number | null;
  size: number;
  /** ISO time. */
  updatedAt: string;
}

export const accountTrackKey = (track: Pick<AccountTrack, 'game' | 'trackName' | 'variant'>) => trackKeyOf(track.game, track.trackName, track.variant);
export const accountLayoutsKey = (userId: string | null) => ['sim-account-layouts', userId] as const;

interface RequestOptions { userId?: string; signal?: AbortSignal }

export class TrackRequestError extends Error {
  constructor(readonly status: number) {
    super(`Track layout request failed (${status})`);
    this.name = 'TrackRequestError';
  }
}

async function request(path: string, method: 'GET' | 'DELETE', { userId, signal }: RequestOptions = {}): Promise<Response | null> {
  signal?.throwIfAborted();
  // The example (src/lib/sim/demo) answers from the browser and changes nothing.
  if (isDemoMode()) {
    if (userId && userId !== DEMO_USER_ID) throw new TrackRequestError(401);
    if (method !== 'GET') return null;
    const answer = await (await import('@/lib/sim/demo')).answerLayouts(path);
    signal?.throwIfAborted();
    if (!answer) return null;
    return answer.bytes ? new Response(answer.bytes as BodyInit, { status: 200 }) : new Response(JSON.stringify(answer.json), { status: 200 });
  }
  if (userId === DEMO_USER_ID) throw new TrackRequestError(401);
  const token = await getAccessToken().catch(() => null);
  signal?.throwIfAborted();
  if (!token) throw new TrackRequestError(401);
  const url = new URL(`${publicAppUrl()}${path}`);
  if (userId) url.searchParams.set('account', userId);
  let response: Response;
  try {
    response = await fetch(url.href, { method, signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    signal?.throwIfAborted();
    throw new TrackRequestError(0);
  }
  signal?.throwIfAborted();
  if (response.status === 404) return null;
  if (!response.ok) throw new TrackRequestError(response.status);
  return response;
}

/** The account's layouts. A missing endpoint is distinct from an empty list or a failed request. */
export async function listAccountTracks(options?: RequestOptions): Promise<AccountTrack[] | null> {
  const response = await request('/api/sim/tracks', 'GET', options);
  if (!response) return null;
  const body = (await response.json()) as { tracks?: AccountTrack[] };
  options?.signal?.throwIfAborted();
  if (!Array.isArray(body.tracks)) throw new TrackRequestError(502);
  return body.tracks;
}

export async function downloadAccountTrack(id: string, options?: RequestOptions): Promise<Blob | null> {
  const response = await request(`/api/sim/tracks/${encodeURIComponent(id)}/file`, 'GET', options);
  return response ? response.blob() : null;
}

/** Forgets a layout in the account (the copy on the device is removed separately). */
export async function deleteAccountTrack(id: string, options?: RequestOptions): Promise<boolean> {
  return (await request(`/api/sim/tracks/${encodeURIComponent(id)}`, 'DELETE', options).catch(() => null)) !== null;
}

/** Reuses the stored bytes only for the same account, source identity and server revision. */
export async function openAccountTrack(userId: string, entry: AccountTrack, signal?: AbortSignal) {
  const saved = await loadAccountTrack(userId, entry.game, entry.trackName, entry.variant, entry);
  signal?.throwIfAborted();
  if (saved) return { track: saved, copied: false, kept: true };
  const blob = await downloadAccountTrack(entry.id, { userId, signal });
  if (!blob) return { track: null, copied: false, kept: false };
  const track = await readTrackFile(blob);
  signal?.throwIfAborted();
  if (!sameTrackIdentity(track.header, { game: entry.game, track: { name: entry.trackName, variant: entry.variant } })) {
    throw new Error('The downloaded layout has a different identity');
  }
  // A browser without available storage can still draw the verified file.
  const copied = await keepAccountTrack(userId, blob, track, entry, signal).then(() => true, () => false);
  signal?.throwIfAborted();
  return { track, copied, kept: copied };
}

export interface SyncResult {
  /** False when the account could not be read; the device copies are used as they are. */
  reached: boolean;
  /** Layouts copied (or updated) onto the device. */
  copied: number;
  failed: number;
  /** The account's layouts by track key, to remove one from the account too. */
  byKey: Map<string, AccountTrack>;
}

/**
 * Brings the account's layouts onto the device: each one the device does not have, or has older than the account's.
 * A layout that fails to download or read is skipped (and tried again next time).
 */
export async function syncAccountTracks(userId: string, signal?: AbortSignal): Promise<SyncResult> {
  const account = await listAccountTracks({ userId, signal }).catch(() => null);
  signal?.throwIfAborted();
  if (!account) return { reached: false, copied: 0, failed: 0, byKey: new Map() };
  const byKey = new Map(account.map((track) => [accountTrackKey(track), track]));
  const kept = new Map((await listTracks(userId).catch(() => [])).map((entry) => [entry.id, entry.accountVersion]));
  let copied = 0;
  let failed = 0;
  for (const [key, track] of byKey) {
    signal?.throwIfAborted();
    const version = kept.get(`${userId}|${key}`);
    if (version?.id === track.id && version.updatedAt === track.updatedAt) continue;
    try {
      const result = await openAccountTrack(userId, track, signal);
      if (result.copied) copied++;
      else if (!result.kept) failed++;
    } catch {
      signal?.throwIfAborted();
      failed++;
    }
  }
  return { reached: true, copied, failed, byKey };
}
