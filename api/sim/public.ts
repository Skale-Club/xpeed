// What a share link shows, with no sign-in. Read only, rate limited per address, and nothing that identifies a person beyond what
// their profile allows (a private profile shows no name, a hidden one shows nothing): never an e-mail, an account id or a file path.
//
//   GET /api/sim/public/share/<token>                    the lap or session summary
//   GET /api/sim/public/share/<token>/file/<lapId>       the lap file bytes, for a lap the link covers
//
// A token that is unknown, revoked or expired, and a lap the link does not cover, are all the same 404.
import { openBackend } from '../_backend';
import { browserHeaders, clientIp, reply, sha256Hex } from './_shared';
import { failed, UUID } from './_v1util';

/** What the generator makes: 32 random bytes in base64url. Anything else is not a token and never reaches the database. */
const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
/** Reads per address and minute (the summary and the file share it). */
export const PUBLIC_READS_PER_MINUTE = 120;

export default async function simPublic(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders(req) });
  const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders(req), ...extra });
  const problem = (error: string, status: number, extra: Record<string, string> = {}) => send({ error, retryable: status === 429 || status >= 500 }, status, extra);
  if (req.method !== 'GET') return problem('method_not_allowed', 405, { Allow: 'GET' });

  // after /api/sim/public: share/<token> or share/<token>/file/<lapId>
  const parts = new URL(req.url).pathname.replace(/\/$/, '').split('/').slice(4);
  const isSummary = parts.length === 2 && parts[0] === 'share';
  const isFile = parts.length === 4 && parts[0] === 'share' && parts[2] === 'file';
  if (!isSummary && !isFile) return problem('not_found', 404);

  const backend = openBackend();
  if (!backend) return problem('unavailable', 503);
  try {
    const hit = await backend.service.rpc('sim_rate_hit', { p_key: `public:${clientIp(req)}`, p_max: PUBLIC_READS_PER_MINUTE, p_window_seconds: 60 });
    if (hit.error) throw hit.error;
    if (Number(hit.data) > 0) return problem('too_many_requests', 429, { 'Retry-After': String(Number(hit.data)) });

    const token = parts[1];
    if (!TOKEN.test(token)) return problem('not_found', 404);
    const hash = sha256Hex(token);

    if (isSummary) {
      const view = await backend.service.rpc('sim_share_view', { p_token_hash: hash });
      if (view.error) throw view.error;
      return view.data ? send(view.data, 200, { 'Cache-Control': 'private, no-store' }) : problem('not_found', 404);
    }

    if (!UUID.test(parts[3])) return problem('not_found', 404);
    const path = await backend.service.rpc('sim_share_file_path', { p_token_hash: hash, p_lap: parts[3].toLowerCase() });
    if (path.error) throw path.error;
    if (typeof path.data !== 'string') return problem('not_found', 404);
    const file = await backend.service.storage.from('sim-laps').download(path.data);
    if (file.error || !file.data) {
      if ((file.error as { statusCode?: string } | null)?.statusCode === '404') return problem('not_found', 404);
      throw file.error ?? new Error('no file');
    }
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    // A lap file never changes once stored, so the browser may keep it; `private` keeps shared caches from serving it after a revoke.
    return new Response(bytes, {
      status: 200,
      headers: { ...browserHeaders(req), 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  } catch (error) {
    failed('sim_public_failed', error);
    return problem('unavailable', 503);
  }
}
