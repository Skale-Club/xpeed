// POST /api/sim/codes: a signed-in person asks for a pairing code to type into Xpeed Companion.
// The code is shown once; only its hash is kept. It works ten minutes and once.
import { openBackend } from '../_backend';
import { bearer, browserHeaders, newPairingCode, reply, sha256Hex, showCode, tooMany } from './_shared';

export default async function codes(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  const answer = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
  if (req.method !== 'POST') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503);
  const token = bearer(req);
  if (!token) return answer({ error: 'unauthorized' }, 401);
  try {
    const userId = await backend.userId(token);
    if (!userId) return answer({ error: 'unauthorized' }, 401);
    const wait = tooMany(`code:${userId}`, 10, 3_600_000);
    if (wait) return answer({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });
    const code = newPairingCode();
    const made = await backend.service.rpc('sim_create_pairing_code', { p_user_id: userId, p_code_hash: sha256Hex(code) });
    if (made.error) throw made.error;
    // null: five codes are already open. Wait for one to expire, or use one of them.
    if (!made.data) return answer({ error: 'too_many_open_codes' }, 429, { 'Retry-After': '60' });
    return answer({ code: showCode(code), expiresAt: made.data });
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_code_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return answer({ error: 'unavailable' }, 503);
  }
}
