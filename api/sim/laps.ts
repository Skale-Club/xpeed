// POST /api/sim/laps: Xpeed Companion sends one lap file (the .xlap.gz bytes, as on its disk).
// The file is opened with the same strict reader the app uses; what that refuses is refused here.
import { openBackend } from '../_backend';
import { gunzipLap, LapFormatError, LAP_LIMITS, type LapFile } from '../../src/lib/sim/lap-file';
import { bearer, lapIdentity, MAX_LAP_BYTES, MAX_LAPS_PER_ACCOUNT, reply, sha256Hex, tooMany } from './_shared';

export default async function laps(req: Request): Promise<Response> {
  if (req.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
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
    console.error(JSON.stringify({ event: 'sim_lap_failed', message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown' }));
    return reply({ error: 'unavailable' }, 503);
  }
}
