// Shared by the api/sim/* handlers (the Windows app's (Xpeed Companion) pairing and lap upload, and the person's own
// management of their devices). Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { LapHeader } from '../../src/lib/sim/lap-file';

export const MAX_LAP_BYTES = 16 * 1024 * 1024;
/// Laps one account may keep on the server.
export const MAX_LAPS_PER_ACCOUNT = 5000;
/// A track layout file (.xtrk.gz) as sent: the longest real tracks are a few MB, so this is plenty.
export const MAX_TRACK_BYTES = 32 * 1024 * 1024;
/// Track layouts one account may keep on the server (one per game, track and layout).
export const MAX_TRACKS_PER_ACCOUNT = 500;

export const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...extra },
  });

/** Same headers on every answer to a browser of the app; Xpeed Companion is not a browser and ignores them. */
export const browserHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

// No 0, O, 1 or I: a code read aloud or typed from a screen is not mistaken.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newPairingCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
export const showCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
/** `abcd-2345` as typed -> `ABCD2345`; null when it cannot be a code. */
export const readCode = (input: unknown): string | null => {
  if (typeof input !== 'string') return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{6,32}$/.test(code) ? code : null;
};

export const newDeviceKey = () => `xpd_${randomBytes(32).toString('base64url')}`;
export const bearer = (req: Request) => req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';

/** game|track|car|startedAt|lapNumber|timeMs|sampleCount: the identity the app keeps laps under on the device. */
export const lapIdentity = (h: LapHeader) =>
  [h.game, h.track.name, h.car.name, h.startedAt, h.lap.number, h.lap.timeMs, h.sampleCount].join('|');

// A small in-memory limiter. One server process answers for the whole app, so this is enough to stop
// someone guessing pairing codes or flooding uploads; a restart forgets it, which is harmless.
const hits = new Map<string, number[]>();
export function tooMany(key: string, max: number, windowMs: number, now = Date.now()): number | null {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= windowMs)) hits.delete(k);
  return null;
}
/** Tests: start every limiter from zero. */
export const forgetLimits = () => hits.clear();

export const clientIp = (req: Request) => req.headers.get('x-real-ip') ?? 'unknown';
