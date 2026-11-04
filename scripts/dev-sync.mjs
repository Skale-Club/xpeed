// Runs before `npm run dev` (predev): makes the development database (Supabase)
// match production, so what you see locally is what is really there.
//
//   1. applies every pending migration to DATABASE_URL (the development database);
//   2. when PROD_DATABASE_URL is set, replaces the development data with an
//      anonymized copy of production. Production is only read, never written.
//
// Skip the data copy with `DEV_SYNC=off` or `npm run dev:fast`. Never blocks `npm run dev`
// when the database is not configured or unreachable: it says why and carries on.
import 'dotenv/config';
import pg from 'pg';
import { migrate } from '../db/migrate.mjs';
import { assertSafeTarget, pullAnonymized } from '../db/sync.mjs';

const env = process.env;
const say = (message) => console.log(`[dev-sync] ${message}`);
const list = (value) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const connect = async (connectionString, label) => {
  const client = new pg.Client({ connectionString, ssl: env.DATABASE_SSL === 'true' || /supabase\.(co|com)/.test(connectionString) ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 });
  try { await client.connect(); } catch (error) { throw new Error(`Cannot reach ${label}: ${error.message}`); }
  return client;
};

async function main() {
  if (env.DEV_SYNC === 'off' || process.argv.includes('--skip')) { say('skipped (DEV_SYNC=off)'); return; }
  if (!env.DATABASE_URL) {
    say('DATABASE_URL is not set, so the development database is left as it is. Put the Supabase connection string in .env to enable the sync.');
    return;
  }
  assertSafeTarget(env.DATABASE_URL, env.PROD_DATABASE_URL, env);

  const dev = await connect(env.DATABASE_URL, 'the development database (DATABASE_URL)');
  try {
    const result = await migrate(dev, { log: say });
    say(result.applied.length ? `schema up to date (${result.applied.length} migrations applied)` : 'schema already up to date');

    if (!env.PROD_DATABASE_URL) { say('PROD_DATABASE_URL is not set: keeping the current development data'); return; }
    const prod = await connect(env.PROD_DATABASE_URL, 'production (PROD_DATABASE_URL)');
    try {
      say('copying anonymized production data into the development database…');
      const summary = await pullAnonymized(prod, dev, { keepEmails: list(env.DEV_KEEP_EMAILS), keepPhones: list(env.DEV_KEEP_PHONES), log: say });
      const rows = Object.values(summary.tables).reduce((a, b) => a + b, 0);
      say(`done: ${rows} rows in ${Object.keys(summary.tables).length} tables; ${summary.keptAccounts} account(s) kept recognizable; not copied: ${summary.skipped.join(', ') || 'nothing'}`);
    } finally { await prod.end().catch(() => {}); }
  } finally { await dev.end().catch(() => {}); }
}

main().catch((error) => {
  // A broken sync must be loud, but it must not stop you from working.
  console.error(`[dev-sync] FAILED: ${error.message}`);
  console.error('[dev-sync] continuing with the development database as it is');
  if (env.DEV_SYNC_STRICT === 'true') process.exit(1);
});
