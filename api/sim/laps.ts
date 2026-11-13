// Laps of an account.
//
// POST   /api/sim/laps            Xpeed Companion (device key) sends one lap file (the .xlap.gz bytes, as on its disk).
// GET    /api/sim/laps            the signed-in person lists their laps, newest first.
// GET    /api/sim/laps/<id>/file  the signed-in person downloads one (the gzip bytes, as sent).
// DELETE /api/sim/laps/<id>       the signed-in person deletes one, the row and the stored file.
//
// An uploaded file is opened with the same strict reader the app uses; what that refuses is refused here.
import { openBackend } from '../_backend';
import { gunzipLap, LapFormatError, LAP_LIMITS, type LapFile } from '../../src/lib/sim/lap-file';
import { bearer, browserHeaders, lapIdentity, MAX_LAP_BYTES, MAX_LAPS_PER_ACCOUNT, reply, sha256Hex, tooMany } from './_shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'sim-laps';

const failed = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

/** `/api/sim/laps` -> {}, `/api/sim/laps/<id>` -> {id}, `/api/sim/laps/<id>/file` -> {id, file}; null for anything else. */
function route(pathname: string): { id?: string; file?: boolean } | null {
  const parts = pathname.replace(/\/$/, '').split('/').slice(4);
  if (parts.length === 0) return {};
  if (!UUID.test(parts[0])) return null;
  if (parts.length === 1) return { id: parts[0].toLowerCase() };
  if (parts.length === 2 && parts[1] === 'file') return { id: parts[0].toLowerCase(), file: true };
  return null;
}

type Answer = (body: unknown, status?: number, extra?: Record<string, string>) => Response;

export default async function laps(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders });
  const answer: Answer = (body, status = 200, extra = {}) => reply(body, status, { ...browserHeaders, ...extra });
  const where = route(new URL(req.url).pathname);
  if (!where) return answer({ error: 'not_found' }, 404);
  if (!where.id) {
    if (req.method === 'POST') return receive(req);
    if (req.method === 'GET') return list(req, answer);
    return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
  }
  if (where.file) {
    if (req.method !== 'GET') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    return download(req, where.id, answer);
  }
  if (req.method !== 'DELETE') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'DELETE' });
  return remove(req, where.id, answer);
}

/** Xpeed Companion sends a lap. Not a browser: no CORS headers. */
async function receive(req: Request): Promise<Response> {
  const backend = openBackend();
  if (!backend) return reply({ error: 'unavailable' }, 503);
  const key = bearer(req);
  if (!key) return reply({ error: 'unauthorized' }, 401);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_LAP_BYTES) return reply({ error: 'lap file is too big' }, 413);

  try {
    const who = await backend.service.rpc('sim_authenticate_device', { p_token_hash: sha256Hex(key) });
    if (who.error) throw who.error;
    const device = who.data as { user_id?: string; device_id?: string } | null;
    if (!device?.user_id || !device.device_id) return reply({ error: 'unauthorized' }, 401);
    const { user_id: userId, device_id: deviceId } = device;

    const wait = tooMany(`lap:${deviceId}`, 60, 60_000);
    if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return reply({ error: 'empty body' }, 400);
    if (bytes.length > MAX_LAP_BYTES) return reply({ error: 'lap file is too big' }, 413);

    let lap: LapFile;
    try {
      lap = await gunzipLap(bytes, { maxBytes: LAP_LIMITS.unpackedBytes });
    } catch (error) {
      if (error instanceof LapFormatError) return reply({ error: `not a valid lap file: ${error.message}`.slice(0, 200) }, 422);
      throw error;
    }
    const header = lap.header;
    const identity = lapIdentity(header);

    const known = await backend.service.from('sim_laps').select('id').eq('user_id', userId).eq('identity', identity).maybeSingle();
    if (known.error) throw known.error;
    if (known.data) return reply({ id: known.data.id, duplicate: true });

    const count = await backend.service.from('sim_laps').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count.error) throw count.error;
    if ((count.count ?? 0) >= MAX_LAPS_PER_ACCOUNT) return reply({ error: 'this account has reached the limit of laps kept on the server' }, 422);

    // The name comes from the identity, never from the request: one lap, one file.
    const path = `${userId}/${sha256Hex(identity).slice(0, 40)}.xlap.gz`;
    const stored = await backend.service.storage.from('sim-laps').upload(path, bytes, { contentType: 'application/gzip', upsert: true });
    if (stored.error) throw stored.error;

    const row = await backend.service.from('sim_laps').insert({
      user_id: userId, device_id: deviceId, identity, game: header.game, track_name: header.track.name, car_name: header.car.name,
      lap_number: header.lap.number, time_ms: header.lap.timeMs, valid: header.lap.valid, started_at: header.startedAt,
      sample_count: header.sampleCount, size_bytes: bytes.length, storage_path: path,
    }).select('id').single();
    if (row.error?.code === '23505') {
      // Another request stored the same lap a moment ago.
      const again = await backend.service.from('sim_laps').select('id').eq('user_id', userId).eq('identity', identity).maybeSingle();
      if (again.data) return reply({ id: again.data.id, duplicate: true });
    }
    if (row.error) throw row.error;
    await backend.service.from('sim_devices').update({ last_lap_at: new Date().toISOString() }).eq('id', deviceId);
    return reply({ id: row.data.id, duplicate: false }, 201);
  } catch (error) {
    failed('sim_lap_failed', error);
    return reply({ error: 'unavailable' }, 503);
  }
}

/** The signed-in person behind the request, or a reply that says why not. */
async function person(req: Request, answer: Answer) {
  const backend = openBackend();
  if (!backend) return { refused: answer({ error: 'unavailable' }, 503) };
  const token = bearer(req);
  if (!token) return { refused: answer({ error: 'unauthorized' }, 401) };
  const userId = await backend.userId(token);
  if (!userId) return { refused: answer({ error: 'unauthorized' }, 401) };
  return { backend, token, userId };
}

interface LapRow {
  id: string; game: string; track_name: string; car_name: string; lap_number: number; time_ms: number; valid: boolean;
  started_at: string; sample_count: number; size_bytes: number; created_at: string; device_id: string | null;
}

async function list(req: Request, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    // As the person: row level security decides what they see.
    const db = await who.backend.asUser(who.token);
    const rows = await db.from('sim_laps')
      .select('id,game,track_name,car_name,lap_number,time_ms,valid,started_at,sample_count,size_bytes,created_at,device_id')
      .order('started_at', { ascending: false }).limit(MAX_LAPS_PER_ACCOUNT);
    if (rows.error) throw rows.error;
    const devices = await db.from('sim_devices').select('id,name');
    if (devices.error) throw devices.error;
    const names = new Map((devices.data as { id: string; name: string }[]).map((d) => [d.id, d.name]));
    return answer({
      laps: (rows.data as LapRow[]).map((r) => ({
        id: r.id, game: r.game, track: r.track_name, car: r.car_name, lapNumber: r.lap_number, timeMs: r.time_ms, valid: r.valid,
        startedAt: new Date(r.started_at).toISOString(), sampleCount: r.sample_count, sizeBytes: r.size_bytes,
        createdAt: new Date(r.created_at).toISOString(), deviceName: (r.device_id && names.get(r.device_id)) || null,
      })),
    });
  } catch (error) {
    failed('sim_laps_list_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

async function download(req: Request, id: string, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const row = await who.backend.service.from('sim_laps').select('storage_path').eq('id', id).eq('user_id', who.userId).maybeSingle();
    if (row.error) throw row.error;
    if (!row.data) return answer({ error: 'lap_not_found' }, 404);
    const file = await who.backend.service.storage.from(BUCKET).download(row.data.storage_path);
    if (file.error || !file.data) {
      if ((file.error as { statusCode?: string } | null)?.statusCode === '404') return answer({ error: 'lap_not_found' }, 404);
      throw file.error ?? new Error('no file');
    }
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    return new Response(bytes, {
      status: 200,
      headers: { ...browserHeaders, 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  } catch (error) {
    failed('sim_lap_download_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

async function remove(req: Request, id: string, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const gone = await who.backend.service.from('sim_laps').delete().eq('id', id).eq('user_id', who.userId).select('storage_path');
    if (gone.error) throw gone.error;
    const paths = (gone.data as { storage_path: string }[] | null ?? []).map((r) => r.storage_path);
    if (paths.length === 0) return answer({ error: 'lap_not_found' }, 404);
    // The row is what the app sees; a file left behind by a failure here is overwritten if the lap comes back.
    const removed = await who.backend.service.storage.from(BUCKET).remove(paths);
    if (removed.error) failed('sim_lap_file_remove_failed', removed.error);
    return new Response(null, { status: 204, headers: { ...browserHeaders, 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    failed('sim_lap_delete_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}
