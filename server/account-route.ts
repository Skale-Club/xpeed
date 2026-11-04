import { asIdentity, databaseConfigured, type getPool } from './db';
import { identityFromRequest, type IdentityOptions } from './identity';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

/**
 * POST /api/account: the signed-in person's Xpeed account, created on first
 * sign-in. Replaces the browser's direct call to the register_google_user RPC.
 */
export function createAccountRoute(options: IdentityOptions & { pool?: ReturnType<typeof getPool> } = {}) {
  return async function account(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    if (!options.pool && !databaseConfigured()) return json(503, { error: 'database_unavailable' });
    const claims = await identityFromRequest(request, options);
    if (!claims) return json(401, { error: 'unauthorized' });
    try {
      const row = await asIdentity(claims, (client) => client.query('SELECT public.register_google_user() AS account'), options.pool);
      return json(200, row.rows[0].account);
    } catch (error) {
      // 28000 = the database refused this identity (unknown project, wrong provider).
      if ((error as { code?: string }).code === '28000') return json(403, { error: 'identity_rejected' });
      console.error(JSON.stringify({ event: 'account_failed', message: error instanceof Error ? error.message : 'unknown' }));
      return json(500, { error: 'unavailable' });
    }
  };
}
