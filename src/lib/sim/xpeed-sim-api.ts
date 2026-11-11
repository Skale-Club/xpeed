// The calls the Virtual > Xpeed Sim screen makes (server side: api/sim/codes and api/sim/devices).
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md.
import { getAccessToken } from '@/lib/auth/google';
import { publicAppUrl } from '@/lib/trips';

export interface SimDevice {
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

export type SimErrorReason = 'signin' | 'too_many' | 'not_found' | 'unavailable';
export class XpeedSimApiError extends Error {
  constructor(readonly reason: SimErrorReason) {
    super(reason);
    this.name = 'XpeedSimApiError';
  }
}

async function call<T>(path: string, method: 'GET' | 'POST' | 'DELETE'): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new XpeedSimApiError('signin');
  let response: Response;
  try {
    response = await fetch(`${publicAppUrl()}${path}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new XpeedSimApiError('unavailable');
  }
  if (response.status === 401) throw new XpeedSimApiError('signin');
  if (response.status === 429) throw new XpeedSimApiError('too_many');
  if (response.status === 404) throw new XpeedSimApiError('not_found');
  if (!response.ok) throw new XpeedSimApiError('unavailable');
  try {
    return (await response.json()) as T;
  } catch {
    throw new XpeedSimApiError('unavailable');
  }
}

export const requestPairingCode = () => call<PairingCode>('/api/sim/codes', 'POST');
export async function listDevices(): Promise<SimDevice[]> {
  return (await call<{ devices: SimDevice[] }>('/api/sim/devices', 'GET')).devices ?? [];
}
export const revokeDevice = (id: string) => call<{ revoked: boolean }>(`/api/sim/devices?id=${encodeURIComponent(id)}`, 'DELETE');

/**
 * The link that opens Xpeed Sim on this computer and proposes to connect it (Xpeed Sim asks the person first, naming the
 * server). Windows hands `xpeedsim:` links to Xpeed Sim once it is installed.
 */
export const pairLink = (code: string) => `xpeedsim://pair?server=${encodeURIComponent(publicAppUrl())}&code=${code}`;

/** What to type on the Windows computer, with this app's address already in it. */
export const pairCommand = (code: string) => `xpeed-sim pair --server ${publicAppUrl()} --code ${code}`;
