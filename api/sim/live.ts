// The live relay between Xpeed Companion (the PC) and the phone view (a PWA page on the site), through this server.
//
//   POST /api/sim/live          device key (Authorization: Bearer <device key>), like the other Companion routes; not a browser: no CORS headers.
//                               { v: 1, seq, sentAt, game, dashboard, rows, model } (at most 64 KB) -> 200 { viewers }
//   GET  /api/sim/live/stream   the signed-in person (the web app's bearer token, as every signed-in /api/sim route): Server-Sent Events.
//   GET  /api/sim/live          the signed-in person: the latest frame (no older than 30 s) as JSON, else 204.
//
// Only the latest frame of each owner is kept, in this process's memory (api/sim/_live.ts); nothing is written to the database or storage and
// `model` is never read or logged. The page reads the stream with fetch (EventSource cannot send the Authorization header).
// Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md (2f), docs/platform/API-V1.md (Live dashboard relay).
import { openBackend, type Backend } from '../_backend';
import { bearer, browserHeaders, refuse, reply, sha256Hex, tooMany } from './_shared';
import { authenticateDevice, type DeviceAuth } from './_upload';
import { person } from './laps';
import { FRAME_TTL_MS, liveHub, MAX_LIVE_BYTES, readFrame } from './_live';

/** Frames one device may send in a second (the Companion sends about 10). */
export const LIVE_FRAMES_PER_SECOND = 25;
/** A stream is closed after this long; the page reconnects. */
export const STREAM_LIFETIME_MS = 30 * 60_000;
export const PING_EVERY_MS = 15_000;
/** The device behind a key is remembered this long, so a frame costs no database call (a revoked key works for at most this long). */
export const DEVICE_CACHE_MS = 30_000;

const failed = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

// Keyed by the hash of the key, never the key. Only successful lookups are kept.
const devices = new Map<string, { device: DeviceAuth; until: number }>();
/** Tests: forget the remembered devices. */
export const forgetLiveDevices = () => devices.clear();

async function deviceFor(backend: Backend, key: string): Promise<DeviceAuth | null> {
  const hash = sha256Hex(key);
  const t = Date.now();
  const known = devices.get(hash);
  if (known && known.until > t) return known.device;
  devices.delete(hash);
  const device = await authenticateDevice(backend, key);
  if (device) {
    if (devices.size >= 200) for (const [h, v] of devices) if (v.until <= t) devices.delete(h);
    if (devices.size >= 200) devices.clear();
    devices.set(hash, { device, until: t + DEVICE_CACHE_MS });
  }
  return device;
}

async function receive(req: Request): Promise<Response> {
  const key = bearer(req);
  if (!key) return refuse({ error: 'unauthorized' }, 401, false);
  const backend = openBackend();
  if (!backend) return refuse({ error: 'unavailable' }, 503, true);
  try {
    const device = await deviceFor(backend, key);
    if (!device) return refuse({ error: 'unauthorized' }, 401, false);

    const wait = tooMany(`live:${device.deviceId}`, LIVE_FRAMES_PER_SECOND, 1000);
    if (wait !== null) return refuse({ error: 'too_many_requests' }, 429, true, { 'Retry-After': String(wait) });

    const declared = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_LIVE_BYTES) return refuse({ error: 'too_large' }, 413, false);
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_LIVE_BYTES) return refuse({ error: 'too_large' }, 413, false);
    const read = readFrame(text);
    if (!read.ok) return refuse({ error: read.why }, 400, false);

    const done = liveHub.publish(device.userId, device.deviceId, read.value);
    if (!done) return refuse({ error: 'busy' }, 503, true, { 'Retry-After': '5' });
    return reply({ viewers: done.viewers });
  } catch (error) {
    failed('sim_live_failed', error);
    return refuse({ error: 'unavailable' }, 503, true);
  }
}

async function latest(req: Request, answer: (body: unknown, status?: number, extra?: Record<string, string>) => Response): Promise<Response> {
  if (!bearer(req)) return answer({ error: 'unauthorized' }, 401);
  try {
    const who = await person(req, answer);
    if (who.refused) return who.refused;
    const stored = liveHub.latest(who.userId, FRAME_TTL_MS);
    const headers = { 'Cache-Control': 'private, no-store', ...browserHeaders(req) };
    if (!stored) return new Response(null, { status: 204, headers });
    return new Response(stored.json, { status: 200, headers: { ...headers, 'Content-Type': 'application/json' } });
  } catch (error) {
    failed('sim_live_latest_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
}

const unref = (timer: unknown) => { (timer as { unref?: () => void })?.unref?.(); };

async function stream(req: Request, answer: (body: unknown, status?: number, extra?: Record<string, string>) => Response): Promise<Response> {
  if (!bearer(req)) return answer({ error: 'unauthorized' }, 401);
  let who;
  try {
    who = await person(req, answer);
  } catch (error) {
    failed('sim_live_stream_failed', error);
    return answer({ error: 'unavailable' }, 503);
  }
  if (who.refused) return who.refused;

  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let subscription: { close(): void } | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(ping);
    clearTimeout(lifetime);
    subscription?.close();
    req.signal.removeEventListener('abort', end);
    try { controller.close(); } catch { /* already closed or cancelled */ }
  };
  const write = (text: string) => {
    if (ended) return;
    try { controller.enqueue(encoder.encode(text)); } catch { end(); }
  };
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { end(); } }, new CountQueuingStrategy({ highWaterMark: 16 }));

  // The first bytes make the headers leave at once; `retry` tells the page how soon to reconnect.
  write('retry: 2000\n\n');
  subscription = liveHub.subscribe(who.userId, (event) => {
    // A phone that cannot keep up misses frames (only the latest matters); it never makes the server hold them.
    if (event.event === 'frame' && (controller.desiredSize ?? 1) <= 0) return;
    write(`event: ${event.event}\ndata: ${event.data}\n\n`);
  });
  if (!subscription) {
    ended = true;
    try { controller.close(); } catch { /* nothing to close */ }
    return answer({ error: 'too_many_streams' }, 429, { 'Retry-After': '5' });
  }
  if (req.signal.aborted) { end(); return new Response(null, { status: 499 }); }
  req.signal.addEventListener('abort', end, { once: true });
  ping = setInterval(() => write(': ping\n\n'), PING_EVERY_MS);
  lifetime = setTimeout(end, STREAM_LIFETIME_MS);
  unref(ping);
  unref(lifetime);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform and X-Accel-Buffering keep a reverse proxy from compressing or holding the events back.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      ...browserHeaders(req),
    },
  });
}

export default async function live(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/$/, '');
  const isStream = path === '/api/sim/live/stream';
  if (!isStream && path !== '/api/sim/live') return reply({ error: 'not_found' }, 404);
  const answer = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
  if (isStream) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
    if (req.method !== 'GET') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
    return stream(req, answer);
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  if (req.method === 'POST') return receive(req);
  if (req.method === 'GET') return latest(req, answer);
  return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
}
