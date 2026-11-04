// Applies supabase/migrations to any PostgreSQL server: the Coolify database
// in production, the Supabase project in development.
//
// - On a plain server it first installs db/compat.sql (roles, auth/storage stubs).
// - On a Supabase project that the Supabase CLI already migrated, it adopts that
//   history instead of running the files again.
// - Each file runs in its own transaction; a failure stops with the file's name.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Resolved from the working directory, not from this file: the server is bundled into
// build/server, and the image keeps these folders next to it. XPEED_ROOT overrides.
const root = () => resolve(process.env.XPEED_ROOT ?? process.cwd());
export const MIGRATIONS_DIR = resolve(root(), 'supabase/migrations');
const LOCK_KEY = 7_302_026; // arbitrary, shared by every process running migrations

/** `20260206193301_name.sql` -> `20260206193301` (the version Supabase records). */
export const versionOf = (file) => file.split('_')[0];

export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.sql')).sort();
}

async function exists(client, sql) {
  return (await client.query(sql)).rows[0]?.found === true;
}

/**
 * @param {import('pg').Client} client  a connected, dedicated connection
 * @param {{ dir?: string, log?: (message: string) => void }} [options]
 * @returns {Promise<{ applied: string[], adopted: string[], compat: boolean }>}
 */
export async function migrate(client, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    let compat = false;
    if (!(await exists(client, "SELECT to_regprocedure('auth.uid()') IS NOT NULL AS found"))) {
      log('Plain PostgreSQL detected: installing the compatibility layer');
      await client.query(readFileSync(resolve(root(), 'db/compat.sql'), 'utf8'));
      compat = true;
    }
    await client.query(`CREATE TABLE IF NOT EXISTS public.xpeed_schema_migrations (
      version text PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);

    const files = listMigrations(dir);
    const done = new Set((await client.query('SELECT name FROM public.xpeed_schema_migrations')).rows.map((r) => r.name));

    const adopted = [];
    if (done.size === 0 && await exists(client, "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS found")) {
      const known = new Set((await client.query('SELECT version FROM supabase_migrations.schema_migrations')).rows.map((r) => r.version));
      for (const name of files.filter((file) => known.has(versionOf(file)))) {
        await client.query('INSERT INTO public.xpeed_schema_migrations(version, name) VALUES($1, $2) ON CONFLICT DO NOTHING', [versionOf(name), name]);
        done.add(name); adopted.push(name);
      }
      if (adopted.length) log(`Adopted ${adopted.length} migrations already applied by the Supabase CLI`);
    }

    const applied = [];
    for (const name of files.filter((file) => !done.has(file))) {
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(resolve(dir, name), 'utf8'));
        await client.query('INSERT INTO public.xpeed_schema_migrations(version, name) VALUES($1, $2)', [versionOf(name), name]);
        await client.query('COMMIT');
      } catch (cause) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${name} failed: ${cause.message}`, { cause });
      }
      applied.push(name); log(`Applied ${name}`);
    }
    return { applied, adopted, compat };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

/** Registers the Google/Firebase project whose tokens this database accepts. */
export async function ensureIdentityProject(client, projectId) {
  if (!projectId) return;
  await client.query("INSERT INTO public.google_auth_projects(project_id, tenant_id) VALUES($1, '') ON CONFLICT DO NOTHING", [projectId]);
}
