// Track layouts (.xtrk.gz) of an account. Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md.
//
// POST   /api/sim/tracks            Xpeed Companion (device key) sends one layout it built from the game's own files.
// GET    /api/sim/tracks            the signed-in person lists their layouts.
// GET    /api/sim/tracks/<id>/file  the signed-in person downloads one (the gzip bytes, as sent).
// DELETE /api/sim/tracks/<id>       the signed-in person deletes one.
//
// The file is opened with the same strict reader the app uses; what that refuses is refused here. One layout per
// account per game, track and layout (the reader's trackKey): sending the same track again replaces it.
import { createHash } from 'node:crypto';
import { openBackend } from '../_backend';
import { gunzipTrack, TrackFormatError, trackKey, type TrackFile } from '../../src/lib/sim/track-file';
import { bearer, browserHeaders, MAX_TRACK_BYTES, MAX_TRACKS_PER_ACCOUNT, reply, sha256Hex, tooMany } from './_shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'sim-tracks';

const failed = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

/** `/api/sim/tracks` -> {}, `/api/sim/tracks/<id>` -> {id}, `/api/sim/tracks/<id>/file` -> {id, file}; null for anything else. */
function route(pathname: string): { id?: string; file?: boolean } | null {
  const parts = pathname.replace(/\/$/, '').split('/').slice(4);
  if (parts.length === 0) return {};
  if (!UUID.test(parts[0])) return null;
  if (parts.length === 1) return { id: parts[0].toLowerCase() };
  if (parts.length === 2 && parts[1] === 'file') return { id: parts[0].toLowerCase(), file: true };
  return null;
}

export default async function tracks(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders });
  const answer = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders, ...extra });
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

type Answer = (body: unknown, status?: number, extra?: Record<string, string>) => Response;

/** Xpeed Companion sends a layout. Not a browser: no CORS headers, like /api/sim/laps. */
async function receive(req: Request): Promise<Response> {
  const backend = openBackend();
  if (!backend) return reply({ error: 'unavailable' }, 503);
  const key = bearer(req);
  if (!key) return reply({ error: 'unauthorized' }, 401);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_TRACK_BYTES) return reply({ error: 'too_large' }, 413);
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/gzip') return reply({ error: 'unsupported_media_type' }, 415);

  try {
    const who = await backend.service.rpc('sim_authenticate_device', { p_token_hash: sha256Hex(key) });
    if (who.error) throw who.error;
    const device = who.data as { user_id?: string; device_id?: string } | null;
    if (!device?.user_id || !device.device_id) return reply({ error: 'unauthorized' }, 401);
    const { user_id: userId, device_id: deviceId } = device;

    // A computer sends a layout once per track (and again when the game's files change): a few a minute is plenty.
    const wait = tooMany(`track:${deviceId}`, 20, 60_000);
    if (wait) return reply({ error: 'too_many_requests' }, 429, { 'Retry-After': String(wait) });

    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return reply({ error: 'empty_body' }, 400);
    if (bytes.length > MAX_TRACK_BYTES) return reply({ error: 'too_large' }, 413);

    let track: TrackFile;
    try {
      // The reader caps the unzipped size itself (TRACK_LIMITS.unpackedBytes) while it reads.
      track = await gunzipTrack(bytes);
    } catch (error) {
      if (error instanceof TrackFormatError) {
        if (error.code === 'too_large') return reply({ error: 'too_large', message: error.message.slice(0, 200) }, 413);
        return reply({ error: 'bad_track', code: error.code, message: error.message.slice(0, 200) }, 422);
      }
      throw error;
    }
    const identity = trackKey(track);
    const { game, track: about } = track.header;
    const fields = {
      device_id: deviceId, game, track_name: about.name, variant: about.variant ?? null, title: about.title ?? null,
      length_m: about.lengthM ?? null, size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    // The name comes from the track key, never from the request: one track, one file, replaced in place.
    const path = `${userId}/${sha256Hex(identity).slice(0, 40)}.xtrk.gz`;

    const replace = async (id: string) => {
      const stored = await backend.service.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/gzip', upsert: true });
      if (stored.error) throw stored.error;
      const row = await backend.service.from('sim_tracks').update({ ...fields, storage_path: path, updated_at: new Date().toISOString() })
        .eq('id', id).eq('user_id', userId).select('id');
      if (row.error) throw row.error;
      return reply({ id, replaced: true }, 201);
    };

    const known = await backend.service.from('sim_tracks').select('id').eq('user_id', userId).eq('track_key', identity).maybeSingle();
    if (known.error) throw known.error;
    if (known.data) return await replace(known.data.id);

    const count = await backend.service.from('sim_tracks').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    if (count.error) throw count.error;
    if ((count.count ?? 0) >= MAX_TRACKS_PER_ACCOUNT) return reply({ error: 'too_many' }, 422);

    const stored = await backend.service.storage.from(BUCKET).upload(path, bytes, { contentType: 'application/gzip', upsert: true });
    if (stored.error) throw stored.error;
    const row = await backend.service.from('sim_tracks').insert({ user_id: userId, track_key: identity, ...fields, storage_path: path })
      .select('id').single();
    if (row.error?.code === '23505') {
      // Another request stored the same track a moment ago: this one replaces it.
      const again = await backend.service.from('sim_tracks').select('id').eq('user_id', userId).eq('track_key', identity).maybeSingle();
      if (again.data) return await replace(again.data.id);
    }
    if (row.error) throw row.error;
    return reply({ id: row.data.id, replaced: false }, 201);
  } catch (error) {
    failed('sim_track_failed', error);
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

interface TrackRow {
  id: string; game: string; track_name: string; variant: string | null; title: string | null;
  length_m: number | string | null; size_bytes: number; updated_at: string;
}

async function list(req: Request, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    // As the person: row level security decides what they see.
    const db = await who.backend.asUser(who.token);
    const rows = await db.from('sim_tracks').select('id,game,track_name,variant,title,length_m,size_bytes,updated_at')
      .order('updated_at', { ascending: false });
    if (rows.error) throw rows.error;
    return answer({
      tracks: (rows.data as TrackRow[]).map((r) => ({
        id: r.id, game: r.game, trackName: r.track_name, variant: r.variant ?? null, title: r.title ?? null,
        lengthM: r.length_m === null || r.length_m === undefined ? null : Number(r.length_m),
        size: r.size_bytes, updatedAt: new Date(r.updated_at).toISOString(),
      })),
    });
  } catch (error) {
    failed('sim_tracks_list_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

async function download(req: Request, id: string, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const row = await who.backend.service.from('sim_tracks').select('storage_path').eq('id', id).eq('user_id', who.userId).maybeSingle();
    if (row.error) throw row.error;
    if (!row.data) return answer({ error: 'track_not_found' }, 404);
    const file = await who.backend.service.storage.from(BUCKET).download(row.data.storage_path);
    if (file.error || !file.data) {
      if ((file.error as { statusCode?: string } | null)?.statusCode === '404') return answer({ error: 'track_not_found' }, 404);
      throw file.error ?? new Error('no file');
    }
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    return new Response(bytes, {
      status: 200,
      headers: { ...browserHeaders, 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    failed('sim_track_download_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

async function remove(req: Request, id: string, answer: Answer): Promise<Response> {
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const gone = await who.backend.service.from('sim_tracks').delete().eq('id', id).eq('user_id', who.userId).select('storage_path');
    if (gone.error) throw gone.error;
    const paths = (gone.data as { storage_path: string }[] | null ?? []).map((r) => r.storage_path);
    if (paths.length === 0) return answer({ error: 'track_not_found' }, 404);
    // The row is what the app sees; a file left behind by a failure here is overwritten if the track comes back.
    const removed = await who.backend.service.storage.from(BUCKET).remove(paths);
    if (removed.error) failed('sim_track_file_remove_failed', removed.error);
    return new Response(null, { status: 204, headers: { ...browserHeaders, 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    failed('sim_track_delete_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}
