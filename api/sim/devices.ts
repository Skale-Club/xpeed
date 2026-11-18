// GET /api/sim/devices: the computers paired to the signed-in account.
// DELETE /api/sim/devices?id=<uuid>: revokes one; its next upload is refused (401).
import { openBackend } from '../_backend';
import { bearer, browserHeaders, reply } from './_shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function devices(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  const answer = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
  if (!['GET', 'DELETE', 'PATCH'].includes(req.method)) return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET, DELETE, PATCH' });
  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503);
  const token = bearer(req);
  if (!token) return answer({ error: 'unauthorized' }, 401);
  try {
    const userId = await backend.userId(token);
    if (!userId) return answer({ error: 'unauthorized' }, 401);

    if (req.method === 'GET') {
      // As the person: row level security decides, and the key hash is not a column they may read.
      const db = await backend.asUser(token);
      const list = await db.from('sim_devices').select('id,name,created_at,last_seen_at,last_lap_at,revoked_at,companion_version,last_state,last_game,last_state_at,last_health,last_health_at,companion_coach_enabled').order('created_at', { ascending: false });
      if (list.error) throw list.error;
      return answer({ devices: list.data });
    }

    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!UUID.test(id)) return answer({ error: 'invalid_device' }, 400);
    if (req.method === 'PATCH') {
      const text = await req.text();
      if (text.length > 4096) return answer({ error: 'invalid_request' }, 400);
      let input: unknown;
      try { input = JSON.parse(text); } catch { return answer({ error: 'invalid_request' }, 400); }
      const body = input as { accountId?: unknown; enabled?: unknown } | null;
      if (!body || typeof body.accountId !== 'string' || typeof body.enabled !== 'boolean') return answer({ error: 'invalid_request' }, 400);
      if (body.accountId !== userId) return answer({ error: 'unauthorized' }, 401);
      const changed = await backend.service.from('sim_devices').update({ companion_coach_enabled: body.enabled })
        .eq('id', id).eq('user_id', userId).is('revoked_at', null).select('id');
      if (changed.error) throw changed.error;
      return changed.data?.length ? answer({ enabled: body.enabled }) : answer({ error: 'device_not_found' }, 404);
    }
    const revoked = await backend.service.from('sim_devices').update({ revoked_at: new Date().toISOString(), companion_coach_enabled: false })
      .eq('id', id).eq('user_id', userId).is('revoked_at', null).select('id');
    if (revoked.error) throw revoked.error;
    return revoked.data?.length ? answer({ revoked: true }) : answer({ error: 'device_not_found' }, 404);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sim_devices_failed', message: error instanceof Error ? error.message : 'unknown' }));
    return answer({ error: 'unavailable' }, 503);
  }
}
