// The calls the Virtual > Collector screen makes (server side: api/sim/codes and api/sim/devices).
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md.
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';

export interface CollectorDevice {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string | null;
  last_lap_at: string | null;
  revoked_at: string | null;
}
export interface PairingCode {
  /** `ABCD-2345`, shown to the person once. */
  code: string;
  /** ISO time after which the code no longer works. */
  expiresAt: string;
}

export type CollectorErrorReason = 'signin' | 'too_many' | 'not_found' | 'unavailable';
export class CollectorApiError extends Error {
  constructor(readonly reason: CollectorErrorReason) {
    super(reason);
    this.name = 'CollectorApiError';
  }
}

async function call<T>(path: string, method: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new CollectorApiError('signin');
  let response: Response;
  try {
    response = await fetch(`${publicAppUrl()}${path}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new CollectorApiError('unavailable');
  }
  if (response.status === 401) throw new CollectorApiError('signin');
  if (response.status === 429) throw new CollectorApiError('too_many');
  if (response.status === 404) throw new CollectorApiError('not_found');
  if (!response.ok) throw new CollectorApiError('unavailable');
  try {
    return (await response.json()) as T;
  } catch {
    throw new CollectorApiError('unavailable');
  }
}

export const requestPairingCode = () => call<PairingCode>('/api/sim/codes', 'POST');
export async function listDevices(): Promise<CollectorDevice[]> {
  return (await call<{ devices: CollectorDevice[] }>('/api/sim/devices', 'GET')).devices ?? [];
}
export const revokeDevice = (id: string) => call<{ revoked: boolean }>(`/api/sim/devices?id=${encodeURIComponent(id)}`, 'DELETE');

/** What to type on the Windows computer, with this app's address already in it. */
export const pairCommand = (code: string) => `xpeed-collector pair --server ${publicAppUrl()} --code ${code}`;
