// Starts the real bundled server (build/server/index.mjs) against an in-memory PostgreSQL.
// Run after `npm run build:server`; needs the isolated PGlite tools (see verify-db-foundation.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';

test('the server migrates its database on start and reports it in /api/health', async () => {
  const { PGlite } = await import(tools + 'pglite/dist/index.js');
  const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');
  const db = await PGlite.create();
  const sql = new PGLiteSocketServer({ db, port: 54420, host: '127.0.0.1' });
  await sql.start();
  const port = 18899;
  const files = mkdtempSync(resolve(tmpdir(), 'xpeed-boot-files-'));
  const child = spawn(process.execPath, ['build/server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54420/postgres',
      VITE_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test', FIREBASE_PROJECT_ID: 'skaleclub', STORAGE_DIR: files,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 240 && !health; attempt++) {
      if (child.exitCode !== null) assert.fail(`server exited early:\n${output}`);
      health = await fetch(base + '/api/health').then((r) => r.json(), () => undefined);
      if (!health) await new Promise((done) => setTimeout(done, 500));
    }
    assert.ok(health, `server never answered:\n${output}`);
    assert.equal(health.database, 'ok');
    assert.equal(health.storage, 'ok', 'the configured folder is writable');
    assert.match(output, /migrations_done/);
    // The identity project was registered, so a token for it can be accepted by the database.
    const projects = await db.query('SELECT project_id FROM public.google_auth_projects');
    assert.deepEqual(projects.rows.map((r) => r.project_id), ['skaleclub']);
    assert.equal((await fetch(base + '/api/account', { method: 'POST' })).status, 401);
    assert.equal((await fetch(base + '/api/account', { method: 'POST', headers: { authorization: 'Bearer nonsense' } })).status, 401);
    assert.equal((await fetch(base + '/api/account')).status, 405);
  } finally {
    child.kill();
    rmSync(files, { recursive: true, force: true });
    await sql.stop();
    await db.close();
  }
});
