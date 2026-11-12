// The games Xpeed Sim reads and their covers, from Xpeed's own database (public.sim_games). Public: no sign-in,
// nothing personal. Xpeed Sim keeps a copy of each cover and fetches it again only when its hash changes.
//
// GET /api/sim/games               the list: key, title and the cover's type, size and hash.
// GET /api/sim/games/<key>/cover   one cover's image bytes (an ETag of its hash; If-None-Match answers 304).
import { openBackend } from '../_backend';
import { browserHeaders, reply } from './_shared';

const KEY = /^[a-z0-9]{1,32}$/;
const LIST_CACHE = 'public, max-age=300';
const COVER_CACHE = 'public, max-age=86400';

/** `/api/sim/games` -> {}, `/api/sim/games/<key>/cover` -> {key}; null for anything else. */
function route(pathname: string): { key?: string } | null {
  const parts = pathname.replace(/\/$/, '').split('/').slice(4);
  if (parts.length === 0) return {};
  if (parts.length === 2 && KEY.test(parts[0]) && parts[1] === 'cover') return { key: parts[0] };
  return null;
}

const failed = (error: unknown) => console.error(JSON.stringify({
  event: 'sim_games_failed',
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));

export default async function games(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: browserHeaders });
  const answer = (body: unknown, status = 200, extra: Record<string, string> = {}) => reply(body, status, { ...browserHeaders, ...extra });
  const where = route(new URL(req.url).pathname);
  if (!where) return answer({ error: 'not_found' }, 404);
  if (req.method !== 'GET') return answer({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  const backend = openBackend();
  if (!backend) return answer({ error: 'unavailable' }, 503);

  try {
    if (!where.key) {
      const rows = await backend.service.from('sim_games').select('key,title,cover_type,cover_sha256,cover_bytes,updated_at').order('sort_order');
      if (rows.error) throw rows.error;
      const list = (rows.data ?? []).map((row) => ({
        key: row.key,
        title: row.title,
        cover: { type: row.cover_type, sha256: row.cover_sha256, bytes: row.cover_bytes, path: `/api/sim/games/${row.key}/cover` },
        updatedAt: row.updated_at,
      }));
      return answer({ games: list }, 200, { 'Cache-Control': LIST_CACHE });
    }

    const row = await backend.service.from('sim_games').select('cover_base64,cover_type,cover_sha256').eq('key', where.key).maybeSingle();
    if (row.error) throw row.error;
    if (!row.data) return answer({ error: 'not_found' }, 404);
    const tag = `"${row.data.cover_sha256}"`;
    const headers = { ...browserHeaders, ETag: tag, 'Cache-Control': COVER_CACHE, 'X-Content-Type-Options': 'nosniff' };
    const asked = (req.headers.get('if-none-match') ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''));
    if (asked.includes(tag)) return new Response(null, { status: 304, headers });
    const bytes = Buffer.from(String(row.data.cover_base64), 'base64');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { ...headers, 'Content-Type': row.data.cover_type, 'Content-Length': String(bytes.length) },
    });
  } catch (error) {
    failed(error);
    return answer({ error: 'unavailable' }, 503);
  }
}
