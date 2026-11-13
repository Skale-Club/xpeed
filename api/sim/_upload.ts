// What happens to an upload (POST /api/sim/laps, POST /api/sim/tracks) before its body is read. The server buffers the
// body in memory, so an anonymous caller must not get that far: the device key is checked first, the declared size is
// compared with the limit, and only a few uploads are read at the same time.
import { openBackend, type Backend } from '../_backend';
import { bearer, MAX_LAP_BYTES, MAX_TRACK_BYTES, refuse, sha256Hex } from './_shared';

export interface DeviceAuth { userId: string; deviceId: string }

/** The device behind a key (the hash of it is what is stored), or null for a missing, unknown or revoked key. Throws when the database fails. */
export async function authenticateDevice(backend: Backend, key: string): Promise<DeviceAuth | null> {
  const who = await backend.service.rpc('sim_authenticate_device', { p_token_hash: sha256Hex(key) });
  if (who.error) throw who.error;
  const device = who.data as { user_id?: string; device_id?: string } | null;
  return device?.user_id && device.device_id ? { userId: device.user_id, deviceId: device.device_id } : null;
}

// The server already looked the device up before reading the body: the handler takes that answer instead of asking again.
// Keyed by the Request object, so nothing a client sends can fake it.
const admitted = new WeakMap<Request, DeviceAuth>();
export const rememberDevice = (req: Request, device: DeviceAuth) => { admitted.set(req, device); };
export const rememberedDevice = (req: Request) => admitted.get(req);

/** Lap and track uploads read at the same time, in total. */
export const MAX_CONCURRENT_UPLOADS = 4;
let active = 0;
/** Tests. */
export const uploadsInFlight = () => active;

function takeSlot(): (() => void) | null {
  if (active >= MAX_CONCURRENT_UPLOADS) return null;
  active++;
  let released = false;
  return () => { if (!released) { released = true; active--; } };
}

/** The size an upload body may declare, or null when this is not an upload. */
export function uploadLimit(method: string | undefined, pathname: string): number | null {
  if (method !== 'POST') return null;
  const path = pathname.replace(/\/$/, '');
  return path === '/api/sim/laps' ? MAX_LAP_BYTES : path === '/api/sim/tracks' ? MAX_TRACK_BYTES : null;
}

export type Admission = { refused: Response } | { device: DeviceAuth; release: () => void };

/** Decides, from the headers alone, whether an upload may be read. Every refusal says whether the same upload can work later. */
export async function admitUpload(headers: Headers, limit: number): Promise<Admission> {
  const key = bearer({ headers });
  if (!key) return { refused: refuse({ error: 'unauthorized' }, 401, false) };
  const backend = openBackend();
  if (!backend) return { refused: refuse({ error: 'unavailable' }, 503, true) };

  let device: DeviceAuth | null;
  try {
    device = await authenticateDevice(backend, key);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_upload_auth_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return { refused: refuse({ error: 'unavailable' }, 503, true) };
  }
  if (!device) return { refused: refuse({ error: 'unauthorized' }, 401, false) };

  // Strangers always get 401, never a hint about sizes; a known device is told its body is too big without sending it.
  const declared = Number(headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) return { refused: refuse({ error: 'too_large' }, 413, false) };

  // Only a known device can take a place, so strangers cannot fill them.
  const release = takeSlot();
  if (!release) return { refused: refuse({ error: 'busy' }, 503, true, { 'Retry-After': '5' }) };
  return { device, release };
}
