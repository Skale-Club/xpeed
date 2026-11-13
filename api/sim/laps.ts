// Laps of an account.
//
// POST   /api/sim/laps            Xpeed Companion (device key) sends one lap file (the .xlap.gz bytes, as on its disk).
// GET    /api/sim/laps            the signed-in person lists their laps, newest first.
// GET    /api/sim/laps/<id>/file  the signed-in person downloads one (the gzip bytes, as sent).
// DELETE /api/sim/laps/<id>       the signed-in person deletes one, the row and the stored file.
//
// An uploaded file is opened with the same strict reader the app uses; what that refuses is refused here.
// The signed-in side is also served, paged and filterable, under /api/sim/v1 (api/sim/v1.ts), which reuses download() and remove().
import { randomUUID } from 'node:crypto';
import { openBackend, type Backend } from '../_backend';
import { gunzipLap, LapFormatError, LAP_LIMITS, type LapFile } from '../../src/lib/sim/lap-file';
import { bearer, browserHeaders, lapIdentity, LAP_UPLOADS_PER_MINUTE, LEGACY_LIST_LIMIT, MAX_ACCOUNT_BYTES, MAX_LAP_BYTES, refuse, reply, sha256Hex } from './_shared';
import { authenticateDevice, rememberedDevice } from './_upload';
import { summarizeLap } from './_summary';
import { checkPlausibility, plausibilityJson } from './_plausibility';
import { forgetOverview } from './_v1cache';

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

export type Answer = (body: unknown, status?: number, extra?: Record<string, string>) => Response;

export default async function laps(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  const answer: Answer = (body, status = 200, extra = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
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
  if (!backend) return refuse({ error: 'unavailable' }, 503, true);
  const key = bearer(req);
  if (!key) return refuse({ error: 'unauthorized' }, 401, false);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_LAP_BYTES) return refuse({ error: 'lap file is too big' }, 413, false);

  // The path of a file that is stored but whose row is not in yet: if anything fails, it is removed in `finally`.
  let stored: string | null = null;
  try {
    // The server checked the key before it read the body; asked again only when this handler is called on its own.
    const device = rememberedDevice(req) ?? await authenticateDevice(backend, key);
    if (!device) return refuse({ error: 'unauthorized' }, 401, false);
    const { userId, deviceId } = device;

    // The count lives in the database: a restart does not forget it and every server instance shares it.
    const rate = await backend.service.rpc('sim_rate_hit', { p_key: `lap:${deviceId}`, p_max: LAP_UPLOADS_PER_MINUTE, p_window_seconds: 60 });
    if (rate.error) throw rate.error;
    const wait = Number(rate.data);
    if (wait > 0) return refuse({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(wait) });

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return refuse({ error: 'empty body' }, 400, false);
    if (bytes.length > MAX_LAP_BYTES) return refuse({ error: 'lap file is too big' }, 413, false);

    let lap: LapFile;
    try {
      lap = await gunzipLap(bytes, { maxBytes: LAP_LIMITS.unpackedBytes });
    } catch (error) {
      if (error instanceof LapFormatError) return refuse({ error: `not a valid lap file: ${error.message}`.slice(0, 200) }, 422, false);
      throw error;
    }
    const header = lap.header;
    const identity = lapIdentity(header);
    const summary = summarizeLap(lap);
    // Whether the file can be believed (docs/platform/API-V1.md): stored with the lap, in the same transaction. A lap that fails is kept, but ranks nowhere.
    const plausibility = checkPlausibility(lap);

    // Already here, or no room left: answered before the file is written.
    const admission = await backend.service.rpc('sim_lap_admission', { p_user_id: userId, p_identity: identity, p_size: bytes.length, p_max_bytes: MAX_ACCOUNT_BYTES });
    if (admission.error) throw admission.error;
    const admitted = admission.data as { status?: string; id?: string } | null;
    if (admitted?.status === 'duplicate' && admitted.id) return reply({ id: admitted.id, duplicate: true });
    if (admitted?.status === 'quota') return refuse({ error: 'quota' }, 422, false);

    // The name comes from the identity, never from the request: one lap, one file.
    const path = `${userId}/${sha256Hex(identity).slice(0, 40)}.xlap.gz`;
    await placeFile(backend, userId, path, bytes);
    stored = path;

    // The row, the catalog, the session, the personal best and the device's last-lap time: one transaction in the database.
    const ingested = await backend.service.rpc('sim_ingest_lap', {
      p_user_id: userId, p_device_id: deviceId, p_max_bytes: MAX_ACCOUNT_BYTES,
      p_lap: {
        identity, game: header.game, track_name: header.track.name, track_length_m: header.track.lengthM ?? null,
        car_name: header.car.name, car_class: header.car.class ?? null, lap_number: header.lap.number, time_ms: header.lap.timeMs,
        valid: header.lap.valid, started_at: header.startedAt, sample_count: header.sampleCount, size_bytes: bytes.length, storage_path: path,
        sector_ms: summary.sectorMs, top_speed_kmh: summary.topSpeedKmh, fuel_used_l: summary.fuelUsedL, in_lap: summary.inLap,
        out_lap: summary.outLap, format_version: summary.formatVersion, session_id: summary.session.id, session_kind: summary.session.kind,
        weather: summary.session.weather, air_temp_c: summary.session.airTempC, track_temp_c: summary.session.trackTempC,
        plausible: plausibility.plausible, plausibility: plausibilityJson(plausibility),
      },
    });
    if (ingested.error) throw ingested.error;
    const result = ingested.data as { status?: string; id?: string } | null;
    forgetOverview(userId);
    if (result?.status === 'created' && result.id) { stored = null; return reply({ id: result.id, duplicate: false }, 201); }
    // Another request stored the same lap a moment ago: its row owns the file.
    if (result?.status === 'duplicate' && result.id) { stored = null; return reply({ id: result.id, duplicate: true }); }
    if (result?.status === 'quota') return refuse({ error: 'quota' }, 422, false);
    throw new Error('unexpected sim_ingest_lap answer');
  } catch (error) {
    failed('sim_lap_failed', error);
    return refuse({ error: 'unavailable' }, 503, true);
  } finally {
    // A failure leaves nothing visible (no row: the transaction rolled back) and no file behind.
    if (stored) await discardFile(backend, stored);
  }
}

/**
 * Writes the lap file so that it is never half there: first under a staging name, then renamed to its final name in one step.
 * A failure takes the staging file with it. Finishing the rename before the row exists means a visible row always has its file.
 */
async function placeFile(backend: Backend, userId: string, path: string, bytes: Uint8Array): Promise<void> {
  const bucket = backend.service.storage.from(BUCKET);
  const staging = `${userId}/staging-${randomUUID()}.xlap.gz`;
  const put = await bucket.upload(staging, bytes, { contentType: 'application/gzip', upsert: false });
  if (put.error) throw put.error;
  try {
    let moved = await bucket.move(staging, path);
    // The lap was stored before (a file with no row, left by a crash): the new bytes replace it.
    if (moved.error && (moved.error as { statusCode?: string }).statusCode === '409') {
      await bucket.remove([path]);
      moved = await bucket.move(staging, path);
    }
    if (moved.error) throw moved.error;
  } catch (error) {
    await bucket.remove([staging]).catch(() => undefined);
    throw error;
  }
}

/** Removes a file whose row did not get in, unless a row now owns that path (a concurrent upload of the same lap). If unsure, leaves it: the sweeper decides. */
async function discardFile(backend: Backend, path: string): Promise<void> {
  try {
    const owner = await backend.service.from('sim_laps').select('id').eq('storage_path', path).limit(1);
    if (owner.error || (owner.data?.length ?? 0) > 0) return;
    const removed = await backend.service.storage.from(BUCKET).remove([path]);
    if (removed.error) failed('sim_lap_cleanup_failed', removed.error);
  } catch (error) {
    failed('sim_lap_cleanup_failed', error);
  }
}

/** The signed-in person behind the request, or a reply that says why not. */
export async function person(req: Request, answer: Answer) {
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
      .order('started_at', { ascending: false }).limit(LEGACY_LIST_LIMIT);
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

export async function download(req: Request, id: string, answer: Answer): Promise<Response> {
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
      headers: { ...browserHeaders(req), 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  } catch (error) {
    failed('sim_lap_download_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

export async function remove(req: Request, id: string, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const gone = await who.backend.service.from('sim_laps').delete().eq('id', id).eq('user_id', who.userId).select('storage_path');
    if (gone.error) throw gone.error;
    const paths = (gone.data as { storage_path: string }[] | null ?? []).map((r) => r.storage_path);
    if (paths.length === 0) return answer({ error: 'lap_not_found' }, 404);
    // The row is what the app sees; a file left behind by a failure here is overwritten if the lap comes back.
    // The database already corrected the session and the personal best (triggers on the delete).
    forgetOverview(who.userId);
    const removed = await who.backend.service.storage.from(BUCKET).remove(paths);
    if (removed.error) failed('sim_lap_file_remove_failed', removed.error);
    return new Response(null, { status: 204, headers: { ...browserHeaders(req), 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    failed('sim_lap_delete_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}
