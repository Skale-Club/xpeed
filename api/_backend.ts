// Where the api/* handlers get their database and files. Until the cutover this is the Supabase
// project; with DATA_BACKEND=own it is the app's own PostgreSQL and file store. The handlers keep
// using the supabase-js calls they were written with (from(), rpc(), storage.from()).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyAppUser } from '../src/lib/verify-app-user';
import { asIdentity, getPool } from '../server/db';
import { verifyIdentity } from '../server/identity';
import { createServiceClient } from '../server/service-client';

export interface Backend {
  kind: 'own' | 'supabase';
  /** Server privileges: reads and writes any row and file, as the old service role did. */
  service: SupabaseClient;
  /** Acts as the signed-in person, so row level security applies. */
  asUser(token: string): Promise<SupabaseClient>;
  /** The account id behind a Google token, or null when the token is not valid for this app. */
  userId(token: string): Promise<string | null>;
  /** Supabase only: address and key, for the one raw storage read that bypasses its CDN. */
  supabase?: { url: string; key: string };
}

export function openBackend(env: NodeJS.ProcessEnv = process.env): Backend | null {
  if (env.DATA_BACKEND === 'own') {
    if (!env.DATABASE_URL) return null;
    let service: SupabaseClient | undefined;
    return {
      kind: 'own',
      get service() { return (service ??= createServiceClient({ caller: 'service' }) as unknown as SupabaseClient); },
      async asUser(token) {
        // An invalid token gets an anonymous client that sees nothing; handlers answer 401 from userId().
        return createServiceClient({ caller: await verifyIdentity(token) }) as unknown as SupabaseClient;
      },
      async userId(token) {
        const claims = await verifyIdentity(token);
        if (!claims) return null;
        const row = await asIdentity(claims, (c) => c.query('SELECT public.current_app_user_id() AS id'), getPool());
        return typeof row.rows[0]?.id === 'string' ? row.rows[0].id : null;
      },
    };
  }
  const url = env.VITE_SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth = { persistSession: false, autoRefreshToken: false };
  let service: SupabaseClient | undefined;
  return {
    kind: 'supabase',
    supabase: { url, key },
    // Created on first use, like the handlers did before: some never need the service role.
    get service() { return (service ??= createClient(url, key, { auth })); },
    asUser: async (token) => createClient(url, key, { global: { headers: { Authorization: `Bearer ${token}` } }, auth }),
    userId: (token) => verifyAppUser(url, key, token),
  };
}
