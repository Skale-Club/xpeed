// GET /api/sim/reference?game=<game>&track=<track name>&car=<car name>[&variant=<track layout>]&kind=best|personal
//
// The reference lap Xpeed Companion draws its "delta to reference" from: the time the lap had reached at every 5 m, from the line to the end.
// Device key, like a lap upload (Authorization: Bearer <device key>); not a browser: no CORS headers.
//
//   kind=personal  the device owner's own fastest valid lap for that game, track and car.
//   kind=best      (default) the fastest lap on the public board as the owner sees it (the leaderboard's own rules: a private, hidden or
//                  blocked driver, and any lap that is invalid or failed the plausibility checks, is never on it), else the owner's personal best.
//
//   200 { kind: "best" | "personal", lapId, timeMs, driver: <display name | null: the owner's own lap>, recordedAt, stepM: 5, points: [ms at 0 m, at 5 m, ...] }
//   404 { error: "no_reference" }   304 when If-None-Match is the lap's ETag ("<lapId>").   Cache-Control: private, max-age=300.
//
// `kind` in the answer is the kind of the lap that came back: a best that fell back to the owner's personal best says "personal".
// Reference lookup uses the lap's raw game, track, variant and car. Older catalog rows
// lacked the variant, so the stored file's identity is checked before it can be served.
import { openBackend } from '../_backend';
import { gunzipLap, LapFormatError, LAP_LIMITS } from '../../src/lib/sim/lap-file';
import { bearer, refuse, reply, tooMany } from './_shared';
import { authenticateDevice } from './_upload';
import { referencePoints, STEP_M } from './_reference';

/** References one device may ask for in a minute. */
export const REFERENCES_PER_MINUTE = 30;
const BUCKET = 'sim-laps';
const GAME = /^[a-z][a-z0-9_]{0,31}$/;
const KINDS = ['best', 'personal'] as const;
const HEADERS = { 'Cache-Control': 'private, max-age=300' };

const failed = (error: unknown) => console.error(JSON.stringify({
  event: 'sim_reference_failed',
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

/** 1 to 120 characters, no control characters (the lap file's own rule for a name); null when it is not. */
const text = (value: string | null): string | null => {
  if (value === null || value.length === 0 || value.length > 120) return null;
  return [...value].every((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f) ? value : null;
};

/** Whether an If-None-Match header names this ETag (a list, weak validators and * included). */
const matches = (header: string | null, etag: string) =>
  header !== null && header.split(',').some((part) => { const tag = part.trim().replace(/^W\//, ''); return tag === etag || tag === '*'; });

interface Found { kind: 'best' | 'personal'; lapId: string; timeMs: number; recordedAt: string; driver: string | null; storagePath: string }

export default async function reference(req: Request): Promise<Response> {
  if (req.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  const key = bearer(req);
  if (!key) return refuse({ error: 'unauthorized' }, 401, false);
  const backend = openBackend();
  if (!backend) return refuse({ error: 'unavailable' }, 503, true);
  try {
    const device = await authenticateDevice(backend, key);
    if (!device) return refuse({ error: 'unauthorized' }, 401, false);

    const wait = tooMany(`reference:${device.deviceId}`, REFERENCES_PER_MINUTE, 60_000);
    if (wait !== null) return refuse({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(wait) });

    const params = new URL(req.url).searchParams;
    const game = params.get('game') ?? '';
    const track = text(params.get('track'));
    const car = text(params.get('car'));
    const variant = text(params.get('variant'));
    const kind = params.get('kind') || 'best';
    if (!GAME.test(game)) return refuse({ error: 'invalid_game' }, 400, false);
    if (!track) return refuse({ error: 'invalid_track' }, 400, false);
    if (!car) return refuse({ error: 'invalid_car' }, 400, false);
    if (params.get('variant') && !variant) return refuse({ error: 'invalid_variant' }, 400, false);
    if (!(KINDS as readonly string[]).includes(kind)) return refuse({ error: 'invalid_kind' }, 400, false);

    const picked = await backend.service.rpc('sim_reference_lap', {
      p_user: device.userId, p_game: game, p_track: track, p_car: car, p_kind: kind, p_variant: variant,
    });
    if (picked.error) throw picked.error;
    const found = picked.data as Found | null;
    if (!found?.lapId || !found.storagePath) return refuse({ error: 'no_reference' }, 404, false);

    const file = await backend.service.storage.from(BUCKET).download(found.storagePath);
    if (file.error || !file.data) {
      // A row whose file is gone is no reference; anything else is a failure to try again.
      if ((file.error as { statusCode?: string } | null)?.statusCode === '404') return refuse({ error: 'no_reference' }, 404, false);
      throw file.error ?? new Error('missing lap file');
    }
    let lap;
    try {
      lap = await gunzipLap(new Uint8Array(await file.data.arrayBuffer()), { maxBytes: LAP_LIMITS.unpackedBytes });
    } catch (error) {
      // A stored file that no longer opens is no reference (retrying will not change that).
      if (error instanceof LapFormatError) { failed(error); return refuse({ error: 'no_reference' }, 404, false); }
      throw error;
    }
    const normalize = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();
    if (lap.header.game !== game || normalize(lap.header.track.name) !== normalize(track)
      || normalize(lap.header.track.variant) !== normalize(variant) || normalize(lap.header.car.name) !== normalize(car)) {
      return refuse({ error: 'no_reference' }, 404, false);
    }
    const etag = `"${found.lapId}"`;
    if (matches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: { ETag: etag, ...HEADERS } });

    const points = referencePoints(lap.data.t, lap.data.dist, STEP_M);
    if (points.length < 2) return refuse({ error: 'no_reference' }, 404, false);

    return reply({
      kind: found.kind, lapId: found.lapId, timeMs: found.timeMs, driver: found.driver, recordedAt: found.recordedAt, stepM: STEP_M, points,
    }, 200, { ETag: etag, ...HEADERS });
  } catch (error) {
    failed(error);
    return refuse({ error: 'unavailable' }, 503, true);
  }
}
