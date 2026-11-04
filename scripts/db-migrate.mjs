// npm run db:migrate: applies pending migrations to DATABASE_URL (any PostgreSQL).
import 'dotenv/config';
import pg from 'pg';
import { ensureIdentityProject, migrate } from '../db/migrate.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
await client.connect();
try {
  const result = await migrate(client, { log: (message) => console.log(message) });
  await ensureIdentityProject(client, process.env.FIREBASE_PROJECT_ID ?? process.env.VITE_FIREBASE_PROJECT_ID);
  console.log(`Done: ${result.applied.length} applied, ${result.adopted.length} adopted from the Supabase CLI history.`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { await client.end(); }
