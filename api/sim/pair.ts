// POST /api/sim/pair: Xpeed Sim trades a pairing code (made in the app) for its device key.
import { openBackend } from '../_backend';
import { clientIp, newDeviceKey, readCode, reply, sha256Hex, tooMany } from './_shared';

export default async function pair(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  // Eight characters of a 32-letter alphabet, valid ten minutes, once: guessing is stopped here, by address and overall.
  const wait = tooMany(`pair:${clientIp(req)}`, 10, 60_000) ?? tooMany('pair:all', 120, 60_000);
  if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });

  const text = await req.text();
  if (text.length > 2048) return reply({ error: 'invalid_request' }, 400);
  let input: { code?: unknown; device?: { name?: unknown } } | null;
  try { input = JSON.parse(text); } catch { return reply({ error: 'invalid_request' }, 400); }
  const code = readCode(input?.code);
  if (!code) return reply({ error: 'invalid_code' }, 404);
  const rawName = typeof input?.device?.name === 'string' ? input.device.name : '';
  const name = [...rawName].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 60) || 'Windows PC';

  const backend = openBackend();
  if (!backend) return reply({ error: 'unavailable' }, 503);
  const key = newDeviceKey();
  try {
    const result = await backend.service.rpc('sim_pair_device', { p_code_hash: sha256Hex(code), p_name: name, p_token_hash: sha256Hex(key) });
    if (result.error) throw result.error;
    const answer = result.data as { status?: string; device_id?: string } | null;
    if (answer?.status === 'ok' && answer.device_id) return reply({ token: key, deviceId: answer.device_id });
    if (answer?.status === 'device_limit') return reply({ error: 'device_limit' }, 409);
    return reply({ error: 'invalid_code' }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_pair_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return reply({ error: 'unavailable' }, 503);
  }
}
