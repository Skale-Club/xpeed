// The calls the Virtual > Xpeed Companion screens make (server side: api/sim/link and api/sim/devices).
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

export async function listDevices(): Promise<SimDevice[]> {
  return (await call<{ devices: SimDevice[] }>('/api/sim/devices', 'GET')).devices ?? [];
}
export const revokeDevice = (id: string) => call<{ revoked: boolean }>(`/api/sim/devices?id=${encodeURIComponent(id)}`, 'DELETE');

export type LinkStatus = 'pending' | 'approved' | 'cancelled' | 'expired';
export interface LinkRequest {
  deviceName: string;
  status: LinkStatus;
  expiresAt: string;
}
/** Why reading, approving or cancelling a connection request did not work. */
export type LinkFailure = 'expired' | 'device_limit' | 'already_decided' | 'not_found' | 'signin' | 'unavailable';
export class XpeedSimLinkError extends Error {
  constructor(readonly reason: LinkFailure) {
    super(reason);
    this.name = 'XpeedSimLinkError';
  }
}

async function linkCall<T>(id: string, action: '' | '/approve' | '/cancel'): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new XpeedSimLinkError('signin');
  let response: Response;
  try {
    response = await fetch(`${publicAppUrl()}/api/sim/link/${encodeURIComponent(id)}${action}`, {
      method: action ? 'POST' : 'GET', cache: 'no-store', headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new XpeedSimLinkError('unavailable');
  }
  if (response.status === 401) throw new XpeedSimLinkError('signin');
  if (response.status === 404) throw new XpeedSimLinkError('not_found');
  if (response.status === 410) throw new XpeedSimLinkError('expired');
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new XpeedSimLinkError(body?.error === 'device_limit' ? 'device_limit' : 'already_decided');
  }
  if (!response.ok) throw new XpeedSimLinkError('unavailable');
  try {
    return (await response.json()) as T;
  } catch {
    throw new XpeedSimLinkError('unavailable');
  }
}

/** The connection request Xpeed Companion made; its page is /sim/connect/<id>. */
export const readLinkRequest = (id: string) => linkCall<LinkRequest>(id, '');
export const approveLinkRequest = (id: string) => linkCall<{ status: 'approved'; deviceId: string }>(id, '/approve');
export const cancelLinkRequest = (id: string) => linkCall<{ status: 'cancelled' }>(id, '/cancel');
