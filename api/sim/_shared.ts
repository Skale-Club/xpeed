// Shared by the api/sim/* handlers (the Windows app's (Xpeed Companion) pairing and lap upload, and the person's own
// management of their devices). Contract: docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { LapHeader } from '../../src/lib/sim/lap-file';
import { corsHeaders } from '../../server/cors';

export const MAX_LAP_BYTES = 16 * 1024 * 1024;
/// Laps one account may keep on the server.
export const MAX_LAPS_PER_ACCOUNT = 5000;
/// A track layout file (.xtrk.gz) as sent: the longest real tracks are a few MB, so this is plenty.
export const MAX_TRACK_BYTES = 32 * 1024 * 1024;
/// Track layouts one account may keep on the server (one per game, track and layout).
export const MAX_TRACKS_PER_ACCOUNT = 500;

/** How long a client is told to wait when a refusal (429, 503) did not say: a rate limit resets within the minute, an outage may not. */
const DEFAULT_RETRY_AFTER: Record<number, string> = { 429: '60', 503: '10' };

export const reply = (body: unknown, status = 200, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', ...extra };
  // Every 429 and 503 says when to come back, so a client never has to guess.
  const retry = DEFAULT_RETRY_AFTER[status];
  if (retry && !Object.keys(headers).some((name) => name.toLowerCase() === 'retry-after')) headers['Retry-After'] = retry;
  return new Response(JSON.stringify(body), { status, headers });
};

/** A refusal of an upload from Xpeed Companion: `retryable` tells it whether sending the same file again can work. */
export const refuse = (body: Record<string, unknown>, status: number, retryable: boolean, extra: Record<string, string> = {}) =>
  reply({ ...body, retryable }, status, extra);

/**
 * Headers for every answer to a browser of the app. The origin is echoed only when the app's own allowlist
 * (server/cors.ts) knows it, and the answer varies by Origin; Xpeed Companion is not a browser and ignores them.
 */
export const browserHeaders = (req: Request): Record<string, string> => {
  let own: string[] = [];
  try { if (process.env.PUBLIC_APP_URL) own = [new URL(process.env.PUBLIC_APP_URL).origin]; } catch { /* a bad address allows nothing extra */ }
  return corsHeaders(req, 'GET, POST, DELETE, OPTIONS', own);
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

/**
 * The 4 characters the connect page and Xpeed Companion both show, so the person can tell the request on screen is the one
 * their computer made: the first four bytes of sha256(id + tokenHash), each mapped onto the code alphabet (256 is a
 * multiple of 32, so every letter is equally likely). `id` is the request's uuid and `tokenHash` the sha256 hex of the
 * device key, both lowercase. Nothing is stored: the server derives it again whenever it is asked.
 */
export const verifyCode = (id: string, tokenHash: string) =>
  Array.from(createHash('sha256').update(id.toLowerCase() + tokenHash.toLowerCase()).digest().subarray(0, 4), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');

export const newDeviceKey = () => `xpd_${randomBytes(32).toString('base64url')}`;
export const bearer = (req: { headers: Headers }) => req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? '';

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
