import { corsHeaders } from './cors';
import { asIdentity, databaseConfigured, getPool, type VerifiedClaims } from './db';
import { identityFromRequest, type IdentityOptions } from './identity';
import {
  BUCKETS, DiskStore, FileError, checkBucket, checkPath, contentTypeOf, isActiveContent, openLink, signLink,
  type FileStore,
} from './files';

type Pool = ReturnType<typeof getPool>;
export interface StorageRouteOptions extends IdentityOptions {
  pool?: Pool;
  store?: FileStore;
  /** Signs download links. Without it, signing answers 503 and only authenticated downloads work. */
  secret?: string;
  origins?: string[];
}

const PREFIX = '/api/storage/';
const MAX_LINK_SECONDS = 7 * 24 * 3600;

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const failure = (error: unknown, headers: Record<string, string>) => {
  if (error instanceof FileError) return json(error.status, { data: null, error: { message: error.message, code: error.code, statusCode: String(error.status) } }, headers);
  console.error(JSON.stringify({ event: 'storage_failed', message: error instanceof Error ? error.message : 'unknown' }));
  return json(500, { data: null, error: { message: 'Storage is unavailable', code: 'unavailable', statusCode: '500' } }, headers);
};

/** `/api/storage/object/<bucket>/<a>/<b.ext>` -> bucket + path, decoded and checked. */
function objectTarget(pathname: string) {
  const parts = pathname.slice(PREFIX.length).split('/');
  if (parts[0] !== 'object' || parts.length < 3) throw new FileError(404, 'not_found');
  let decoded: string[];
  try { decoded = parts.slice(1).map(decodeURIComponent); } catch { throw new FileError(400, 'invalid_path'); }
  return { bucket: checkBucket(decoded[0]), path: checkPath(decoded.slice(1).join('/')) };
}

/**
 * Files for the app: upload, download, signed links and removal. Access follows the old bucket
 * policies: a person's own folder (first path segment = account id), admin-written public
 * assets, and server-only buckets that no browser may touch.
 */
/** 'off' when no folder is configured, otherwise whether it can be written (checked at most once a minute). */
let probed: { at: number; result: 'ok' | 'down' } | undefined;
export async function storageStatus(env: NodeJS.ProcessEnv = process.env): Promise<'ok' | 'down' | 'off'> {
  if (!env.STORAGE_DIR) return 'off';
  if (probed && Date.now() - probed.at < 60_000) return probed.result;
  probed = { at: Date.now(), result: (await new DiskStore(env.STORAGE_DIR).probe()) ? 'ok' : 'down' };
  return probed.result;
}

export function createStorageRoute(options: StorageRouteOptions = {}) {
  let store = options.store;
  const files = () => (store ??= new DiskStore(process.env.STORAGE_DIR ?? '/data/files'));
  const secret = () => options.secret ?? process.env.STORAGE_SECRET ?? '';
  const pool = () => options.pool ?? getPool();

  async function accountId(claims: VerifiedClaims): Promise<string | null> {
    const row = await asIdentity(claims, (c) => c.query('SELECT public.current_app_user_id() AS id'), pool());
    return row.rows[0]?.id ?? null;
  }
  async function isAdmin(claims: VerifiedClaims): Promise<boolean> {
    return (await asIdentity(claims, (c) => c.query('SELECT public.is_admin_user() AS admin'), pool())).rows[0]?.admin === true;
  }

  /** Throws unless this person may do `action` on the object. */
  async function authorize(claims: VerifiedClaims | null, bucket: string, path: string, action: 'read' | 'write') {
    const rule = BUCKETS[bucket];
    if (rule.access === 'server') throw new FileError(403, 'forbidden');
    if (rule.access === 'admin-write-public-read') {
      if (action === 'read') return;
      if (!claims) throw new FileError(401, 'unauthorized');
      if (!(await isAdmin(claims))) throw new FileError(403, 'forbidden');
      return;
    }
    if (!claims) throw new FileError(401, 'unauthorized');
    const owner = await accountId(claims);
    const parts = path.split('/');
    if (!owner || parts.length < 2 || parts[0] !== owner) throw new FileError(403, 'forbidden');
  }

  async function caller(request: Request, headers: Record<string, string>): Promise<{ claims: VerifiedClaims | null } | Response> {
    if (!request.headers.get('authorization')) return { claims: null };
    const claims = await identityFromRequest(request, options);
    return claims ? { claims } : json(401, { data: null, error: { message: 'Not signed in', code: 'unauthorized', statusCode: '401' } }, headers);
  }

  function serve(request: Request, bucket: string, path: string, bytes: Uint8Array, headers: Record<string, string>, cache: string) {
    const type = contentTypeOf(path);
    const base: Record<string, string> = {
      ...headers, 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff',
      // Uploaded files are data: never let one run script on our origin.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': type.startsWith('image/') || type.startsWith('video/') ? 'inline' : `attachment; filename="${path.split('/').pop()?.replace(/[^\w.-]/g, '_')}"`,
    };
    if (isActiveContent(type)) base['Content-Disposition'] = 'attachment';
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      const size = bytes.length;
      const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) } });
    }
    return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
  }

  return async function storage(request: Request): Promise<Response> {
    const cors = corsHeaders(request, 'GET, HEAD, PUT, POST, OPTIONS', options.origins);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!options.pool && !databaseConfigured()) return json(503, { data: null, error: { message: 'Storage is unavailable', code: 'unavailable', statusCode: '503' } }, cors);
    const url = new URL(request.url);
    try {
      // ---- download: a signed link, a public bucket, or the owner's token
      if (request.method === 'GET' || request.method === 'HEAD') {
        const { bucket, path } = objectTarget(url.pathname);
        const token = url.searchParams.get('token');
        if (token) {
          const claim = secret() ? openLink(secret(), token) : null;
          if (!claim || claim.bucket !== bucket || claim.path !== path) throw new FileError(403, 'invalid_link');
        } else {
          const who = await caller(request, cors);
          if (who instanceof Response) return who;
          await authorize(who.claims, bucket, path, 'read');
        }
        const bytes = await files().get(bucket, path);
        if (!bytes) throw new FileError(404, 'not_found', 'Object not found');
        const publicBucket = BUCKETS[bucket].access === 'admin-write-public-read';
        return serve(request, bucket, path, bytes, cors, publicBucket ? 'public, max-age=3600' : 'private, max-age=300');
      }

      const who = await caller(request, cors);
      if (who instanceof Response) return who;

      // ---- upload
      if (request.method === 'PUT') {
        const { bucket, path } = objectTarget(url.pathname);
        await authorize(who.claims, bucket, path, 'write');
        const rule = BUCKETS[bucket];
        const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        if (rule.mimes && !rule.mimes.includes(type)) throw new FileError(415, 'invalid_mime_type', `The ${bucket} bucket does not accept ${type || 'this file type'}`);
        const declared = Number(request.headers.get('content-length') ?? 0);
        if (declared > rule.maxBytes) throw new FileError(413, 'too_large', 'The object exceeded the maximum allowed size');
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length === 0) throw new FileError(400, 'empty_file');
        if (bytes.length > rule.maxBytes) throw new FileError(413, 'too_large', 'The object exceeded the maximum allowed size');
        await files().put(bucket, path, bytes, { upsert: url.searchParams.get('upsert') === 'true' });
        return json(200, { data: { path }, error: null }, cors);
      }

      if (request.method !== 'POST') return json(405, { data: null, error: { message: 'Method not allowed', code: 'method_not_allowed', statusCode: '405' } }, { ...cors, Allow: 'GET, HEAD, PUT, POST, OPTIONS' });
      let body: Record<string, unknown>;
      try { body = (await request.json()) as Record<string, unknown>; } catch { throw new FileError(400, 'invalid_json'); }
      if (!body || typeof body !== 'object') throw new FileError(400, 'invalid_request');

      // ---- signed link
      if (url.pathname === `${PREFIX}sign`) {
        const bucket = checkBucket(body.bucket); const path = checkPath(body.path);
        await authorize(who.claims, bucket, path, 'read');
        if (!secret()) throw new FileError(503, 'signing_unavailable');
        const seconds = Math.min(Math.max(Number(body.expiresIn) || 3600, 1), MAX_LINK_SECONDS);
        if (!(await files().get(bucket, path))) throw new FileError(404, 'not_found', 'Object not found');
        const token = signLink(secret(), { bucket, path, expires: Date.now() + seconds * 1000 });
        const signedPath = `${PREFIX}object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}?token=${token}`;
        return json(200, { data: { signedPath }, error: null }, cors);
      }

      // ---- remove
      if (url.pathname === `${PREFIX}remove`) {
        const bucket = checkBucket(body.bucket);
        if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > 100) throw new FileError(400, 'invalid_request');
        const paths = body.paths.map(checkPath);
        for (const path of paths) await authorize(who.claims, bucket, path, 'write');
        await files().remove(bucket, paths);
        return json(200, { data: paths.map((name) => ({ name })), error: null }, cors);
      }
      throw new FileError(404, 'not_found');
    } catch (error) {
      return failure(error, cors);
    }
  };
}
