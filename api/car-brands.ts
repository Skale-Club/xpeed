// Public read-only catalog of vehicle makes and their logos, stored in Xpeed's database.
// GET /api/car-brands lists metadata; GET /api/car-brands/<key>/logo serves PNG bytes.
import { openBackend } from './_backend';

const KEY = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const LIST_CACHE = 'public, max-age=300';
const LOGO_CACHE = 'public, max-age=86400';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'if-none-match', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers, ...extra },
});

function route(pathname: string): { key?: string } | null {
  const parts = pathname.split('/');
  if ((parts.length === 3 || (parts.length === 4 && parts[3] === '')) && parts[1] === 'api' && parts[2] === 'car-brands') return {};
  if (parts.length === 5 && parts[1] === 'api' && parts[2] === 'car-brands' && KEY.test(parts[3]) && parts[4] === 'logo') return { key: parts[3] };
  return null;
}

export default async function carBrands(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const where = route(new URL(req.url).pathname);
  if (!where) return json({ error: 'not_found' }, 404);
  if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET' });
  const backend = openBackend();
  if (!backend) return json({ error: 'unavailable' }, 503);

  try {
    if (!where.key) {
      const result = await backend.service.from('car_brands').select('key,name,aliases,logo_type,logo_sha256,logo_bytes,source_url').order('name');
      if (result.error) throw result.error;
      const brands = (result.data ?? []).map((row) => ({
        key: row.key,
        name: row.name,
        aliases: row.aliases,
        logo: { type: row.logo_type, sha256: row.logo_sha256, bytes: row.logo_bytes, path: `/api/car-brands/${row.key}/logo` },
        sourceUrl: row.source_url,
      }));
      return json({ brands }, 200, { 'Cache-Control': LIST_CACHE });
    }

    const result = await backend.service.from('car_brands').select('logo_base64,logo_type,logo_sha256').eq('key', where.key).maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return json({ error: 'not_found' }, 404);
    const tag = `"${result.data.logo_sha256}"`;
    const imageHeaders = { ...headers, ETag: tag, 'Cache-Control': LOGO_CACHE, 'X-Content-Type-Options': 'nosniff' };
    const asked = (req.headers.get('if-none-match') ?? '').split(',').map((value) => value.trim().replace(/^W\//, ''));
    if (asked.includes(tag)) return new Response(null, { status: 304, headers: imageHeaders });
    const bytes = Buffer.from(String(result.data.logo_base64), 'base64');
    return new Response(new Uint8Array(bytes), { status: 200, headers: { ...imageHeaders, 'Content-Type': result.data.logo_type, 'Content-Length': String(bytes.length) } });
  } catch {
    return json({ error: 'unavailable' }, 503);
  }
}
