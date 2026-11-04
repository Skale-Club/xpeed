import { databaseConfigured, getPool } from './db';
import { execute, type DbRequest } from './db-query';
import { identityFromRequest, type IdentityOptions } from './identity';

type Pool = ReturnType<typeof getPool>;

// The app is served from its own origin; the offline Android build runs from the Capacitor
// WebView and must reach the same API from there. Credentials are a bearer token, never cookies.
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);

function corsHeaders(request: Request, extra: string[] = []): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = origin && (APP_ORIGINS.has(origin) || extra.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin));
  return allowed
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin' }
    : { Vary: 'Origin' };
}
const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const ACTIONS = new Set(['select', 'insert', 'update', 'upsert', 'delete']);
const SHAPES = new Set(['many', 'single', 'maybe']);

/** Only the structure is checked here; names are checked against the real schema when the query is built. */
function parse(body: unknown): DbRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.shape !== undefined && !SHAPES.has(b.shape as string)) return null;
  if (b.kind === 'rpc') {
    if (typeof b.name !== 'string' || (b.args !== undefined && (typeof b.args !== 'object' || b.args === null || Array.isArray(b.args)))) return null;
    return b as unknown as DbRequest;
  }
  if (b.kind !== 'query' || typeof b.table !== 'string' || !ACTIONS.has(b.action as string)) return null;
  if (b.filters !== undefined && !Array.isArray(b.filters)) return null;
  if (b.or !== undefined && (!Array.isArray(b.or) || b.or.some((e) => typeof e !== 'string'))) return null;
  if (b.order !== undefined && !Array.isArray(b.order)) return null;
  return b as unknown as DbRequest;
}

/**
 * POST /api/db: table queries and function calls for the signed-in person, or for the public
 * (anon role) when no token is sent. A token that is sent but invalid is refused, not downgraded.
 */
export function createDbRoute(options: IdentityOptions & { pool?: Pool; origins?: string[] } = {}) {
  return async function db(request: Request): Promise<Response> {
    const cors = corsHeaders(request, options.origins);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { ...cors, Allow: 'POST, OPTIONS' });
    if (!options.pool && !databaseConfigured()) return json(503, { error: 'database_unavailable' }, cors);

    let caller = null;
    if (request.headers.get('authorization')) {
      caller = await identityFromRequest(request, options);
      if (!caller) return json(401, { error: 'unauthorized' }, cors);
    }
    let body: unknown;
    try { body = await request.json(); } catch { return json(400, { error: 'invalid_json' }, cors); }
    const parsed = parse(body);
    if (!parsed) return json(400, { error: 'invalid_request' }, cors);

    try {
      return json(200, await execute(options.pool ?? getPool(), caller, parsed), cors);
    } catch (error) {
      console.error(JSON.stringify({ event: 'db_route_failed', message: error instanceof Error ? error.message : 'unknown' }));
      return json(500, { error: 'unavailable' }, cors);
    }
  };
}
