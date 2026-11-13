// Connect Xpeed Companion to an account without a code (a device authorization flow). Contract:
//   POST /api/sim/link                    the app starts a request with sha256 of its own device key (no auth)
//   GET  /api/sim/link/<id>               the signed-in person reads it
//   POST /api/sim/link/<id>/approve       the signed-in person connects the computer (creates the sim_devices row)
//   POST /api/sim/link/<id>/cancel        the signed-in person says no
//   POST /api/sim/link/<id>/poll          the app, with its device key as Bearer, asks how it stands
// The key never travels and is never stored: only its hash is, and approving makes it a normal device.
import { openBackend, type Backend } from '../_backend';
import { bearer, browserHeaders, clientIp, reply, sha256Hex, tooMany } from './_shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;

type Answer = (body: unknown, status?: number, extra?: Record<string, string>) => Response;

export default async function link(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders });
  const answer: Answer = (body, status = 200, extra = {}) => reply(body, status, { ...browserHeaders, ...extra });
  const parts = new URL(req.url).pathname.replace(/\/$/, '').split('/').slice(3); // after /api/sim
  if (parts[0] !== 'link' || parts.length > 3) return answer({ error: 'not_found' }, 404);
  const id = parts[1];
  const action = parts[2];

  if (id === undefined) {
    if (req.method !== 'POST') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
    return start(req, answer);
  }
  if (!UUID.test(id)) return answer({ error: 'not_found' }, 404);

  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503);
  const lower = id.toLowerCase();

  try {
    if (action === 'poll') {
      if (req.method !== 'POST') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      const wait = tooMany(`linkpoll:${clientIp(req)}`, 60, 60_000);
      if (wait) return answer({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });
      const key = bearer(req);
      if (!key) return answer({ error: 'not_found' }, 404);
      const polled = await backend.service.rpc('sim_link_poll', { p_id: lower, p_token_hash: sha256Hex(key) });
      if (polled.error) throw polled.error;
      const found = polled.data as { status?: string; account?: string } | null;
      if (!found?.status) return answer({ error: 'not_found' }, 404);
      return answer(found.status === 'approved' ? { status: 'approved', account: found.account ?? '' } : { status: found.status });
    }

    // Everything else is the signed-in person in the browser.
    const token = bearer(req);
    if (!token) return answer({ error: 'unauthorized' }, 401);
    const userId = await backend.userId(token);
    if (!userId) return answer({ error: 'unauthorized' }, 401);

    if (action === undefined) {
      if (req.method !== 'GET') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
      const read = await backend.service.rpc('sim_link_read', { p_id: lower });
      if (read.error) throw read.error;
      const row = read.data as { device_name?: string; status?: string; expires_at?: string } | null;
      if (!row?.status) return answer({ error: 'not_found' }, 404);
      return answer({ deviceName: row.device_name, status: row.status, expiresAt: row.expires_at });
    }
    if (action === 'approve' || action === 'cancel') {
      if (req.method !== 'POST') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
      return action === 'approve' ? await approve(backend, lower, userId, answer) : await cancel(backend, lower, answer);
    }
    return answer({ error: 'not_found' }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_link_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return answer({ error: 'unavailable' }, 503);
  }
}

async function start(req: Request, answer: Answer): Promise<Response> {
  const wait = tooMany(`link:${clientIp(req)}`, 10, 60_000) ?? tooMany('link:all', 120, 60_000);
  if (wait) return answer({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });
  const text = await req.text();
  if (text.length > 2048) return answer({ error: 'invalid_request' }, 400);
  let input: { device?: { name?: unknown }; tokenHash?: unknown } | null;
  try { input = JSON.parse(text); } catch { return answer({ error: 'invalid_request' }, 400); }
  const tokenHash = input?.tokenHash;
  if (typeof tokenHash !== 'string' || !HASH.test(tokenHash)) return answer({ error: 'invalid_request' }, 400);
  const rawName = typeof input?.device?.name === 'string' ? input.device.name : '';
  const name = [...rawName].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 60) || 'Windows PC';

  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503);
  try {
    const made = await backend.service.rpc('sim_link_create', { p_name: name, p_token_hash: tokenHash });
    if (made.error) throw made.error;
    const row = made.data as { status?: string; id?: string; expires_at?: string } | null;
    if (row?.status === 'ok' && row.id) return answer({ id: row.id, expiresAt: new Date(row.expires_at ?? Date.now() + 600_000).toISOString() }, 201);
    if (row?.status === 'exists') return answer({ error: 'invalid_request' }, 409);
    throw new Error('unexpected sim_link_create answer');
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_link_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return answer({ error: 'unavailable' }, 503);
  }
}

async function approve(backend: Backend, id: string, userId: string, answer: Answer): Promise<Response> {
  const result = await backend.service.rpc('sim_link_approve', { p_id: id, p_user_id: userId });
  if (result.error) throw result.error;
  const row = result.data as { status?: string; device_id?: string } | null;
  switch (row?.status) {
    case 'ok': return answer({ status: 'approved', deviceId: row.device_id });
    case 'device_limit': return answer({ error: 'device_limit' }, 409);
    case 'expired': return answer({ error: 'expired' }, 410);
    case 'already_decided': return answer({ error: 'already_decided' }, 409);
    default: return answer({ error: 'not_found' }, 404);
  }
}

async function cancel(backend: Backend, id: string, answer: Answer): Promise<Response> {
  const result = await backend.service.rpc('sim_link_cancel', { p_id: id });
  if (result.error) throw result.error;
  const row = result.data as { status?: string } | null;
  if (row?.status === 'ok') return answer({ status: 'cancelled' });
  if (row?.status === 'already_decided') return answer({ error: 'already_decided' }, 409);
  return answer({ error: 'not_found' }, 404);
}
