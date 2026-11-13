// GET /api/sim/me: Xpeed Companion asks who its device key belongs to, so the app can show the account's email.
// The key is the same device key the laps use (Authorization: Bearer <key>); a missing, unknown or revoked key is 401.
import { openBackend } from '../_backend';
import { bearer, reply, sha256Hex, tooMany } from './_shared';

export default async function me(req: Request): Promise<Response> {
  if (req.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  const backend = openBackend();
  if (!backend) return reply({ error: 'unavailable' }, 503);
  const key = bearer(req);
  if (!key) return reply({ error: 'unauthorized' }, 401);

  try {
    const who = await backend.service.rpc('sim_authenticate_device', { p_token_hash: sha256Hex(key) });
    if (who.error) throw who.error;
    const device = who.data as { user_id?: string; device_id?: string } | null;
    if (!device?.user_id || !device.device_id) return reply({ error: 'unauthorized' }, 401);

    const wait = tooMany(`me:${device.device_id}`, 30, 60_000);
    if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });

    const account = await backend.service.from('app_accounts').select('email, full_name, phone').eq('id', device.user_id).maybeSingle();
    if (account.error) throw account.error;
    const named = await backend.service.from('sim_devices').select('name').eq('id', device.device_id).maybeSingle();
    if (named.error) throw named.error;
    const row = (account.data ?? {}) as { email?: string | null; full_name?: string | null; phone?: string | null };
    // The same order the connection poll uses: email, else name, else phone.
    const label = [row.email, row.full_name, row.phone].find((v) => typeof v === 'string' && v.trim() !== '') ?? '';
    return reply({ account: label, deviceName: (named.data as { name?: string } | null)?.name ?? '' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_me_failed', message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown' }));
    return reply({ error: 'unavailable' }, 503);
  }
}
