// The track layouts kept in the account (Xpeed Companion sends them by itself; server side: api/sim/tracks).
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md. The web keeps a copy of each on the device (the track
// library), so the compare screen works without asking the server every time.
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';
import { trackKeyOf } from '@/lib/sim/track-file';
import { addTrackFile, listTracks } from '@/lib/sim/track-library';

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

/** The account's layouts; null when they cannot be read (signed out, offline, or a server without this yet). */
export async function listAccountTracks(): Promise<AccountTrack[] | null> {
  const response = await request('/api/sim/tracks', 'GET');
  if (!response) return null;
  try {
    const body = (await response.json()) as { tracks?: AccountTrack[] };
    return Array.isArray(body.tracks) ? body.tracks : null;
  } catch {
    return null;
  }
}

export async function downloadAccountTrack(id: string): Promise<Blob | null> {
  const response = await request(`/api/sim/tracks/${encodeURIComponent(id)}/file`, 'GET');
  return response ? response.blob() : null;
}

/** Forgets a layout in the account (the copy on the device is removed separately). */
export async function deleteAccountTrack(id: string): Promise<boolean> {
  return (await request(`/api/sim/tracks/${encodeURIComponent(id)}`, 'DELETE')) !== null;
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
export async function syncAccountTracks(userId: string): Promise<SyncResult> {
  const account = await listAccountTracks();
  if (!account) return { reached: false, copied: 0, failed: 0, byKey: new Map() };
  const byKey = new Map(account.map((track) => [accountTrackKey(track), track]));
  const kept = new Map((await listTracks(userId).catch(() => [])).map((entry) => [entry.id.slice(userId.length + 1), entry.addedAt]));
  let copied = 0;
  let failed = 0;
  for (const [key, track] of byKey) {
    const addedAt = kept.get(key);
    if (addedAt !== undefined && addedAt >= Date.parse(track.updatedAt)) continue;
    const blob = await downloadAccountTrack(track.id);
    if (!blob) {
      failed++;
      continue;
    }
    try {
      await addTrackFile(userId, blob, `${[track.trackName, track.variant].filter(Boolean).join('-')}.xtrk.gz`);
      copied++;
    } catch {
      failed++;
    }
  }
  return { reached: true, copied, failed, byKey };
}
