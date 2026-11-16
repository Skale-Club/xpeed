// Development migrations; production data copying requires explicit opt-in and a read-only role.
import 'dotenv/config';
import pg from 'pg';
import { runDevSync } from '../db/dev-sync.mjs';

const env = process.env;
const say = (message) => console.log(`[dev-sync] ${message}`);
const connect = async (connectionString, label) => {
  const client = new pg.Client({ connectionString, ssl: env.DATABASE_SSL === 'true' || /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 });
  try { await client.connect(); } catch {
    await client.end().catch(() => {});
    throw new Error(`Cannot reach ${label}`); // Never echo a connection string or server-supplied credentials.
  }
  return client;
};

runDevSync(process.argv.includes('--skip') ? { ...env, DEV_SYNC: 'off' } : env, { connect, log: say }).catch((error) => {
  console.error(`[dev-sync] FAILED: ${error.message}`);
  console.error('[dev-sync] continuing with the development database as it is');
  if (env.DEV_SYNC_STRICT === 'true') process.exitCode = 1;
});
