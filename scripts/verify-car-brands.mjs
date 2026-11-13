// Uses a deliberately named, disposable local database only; never loads .env.
// TEST_CAR_BRANDS_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/xpeed_brands_test
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import sharp from 'sharp';
import { build } from 'esbuild';

const url = new URL(process.env.TEST_CAR_BRANDS_DATABASE_URL ?? 'http://invalid');
assert(['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/xpeed_brands_test', 'Use the disposable local xpeed_brands_test database');
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
let closePool;
try {
  await client.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role');
  await client.query(await readFile('supabase/migrations/20261113070000_car_brands.sql', 'utf8'));
  const seed = await readFile('supabase/migrations/20261113070100_car_brands_seed.sql', 'utf8');
  await client.query(seed);
  const manifest = JSON.parse(await readFile('docs/car-brands/catalog.json', 'utf8'));
  const rows = (await client.query('SELECT * FROM public.car_brands ORDER BY key')).rows;
  assert.equal(rows.length, manifest.count);
  for (const row of rows) {
    const bytes = Buffer.from(row.logo_base64, 'base64');
    assert.equal(bytes.length, row.logo_bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.logo_sha256);
    const expected = manifest.brands.find((b) => b.key === row.key);
    assert.equal(expected.sha256, row.logo_sha256);
    const image = await sharp(bytes).metadata();
    assert.equal(image.format, 'png');
    assert(image.width > 0 && image.height > 0 && image.width <= 256 && image.height <= 256);
  }
  await client.query("UPDATE public.car_brands SET aliases = array_append(aliases, 'Curated Toyota') WHERE key = 'toyota'");
  await client.query(seed);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM public.car_brands')).rows[0].n, rows.length);
  assert((await client.query("SELECT aliases FROM public.car_brands WHERE key = 'toyota'")).rows[0].aliases.includes('Curated Toyota'));
  await client.query("UPDATE public.car_brands SET aliases = array_remove(aliases, 'Curated Toyota') WHERE key = 'toyota'");
  for (const role of ['anon', 'authenticated']) {
    await client.query(`SET ROLE ${role}`);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.car_brands')).rows[0].n, rows.length);
    await assert.rejects(client.query("UPDATE public.car_brands SET name = 'changed' WHERE key = 'toyota'"), /permission denied/);
    await client.query('RESET ROLE');
  }
  process.env.DATABASE_URL = url.toString();
  process.env.DATABASE_SSL = 'false';
  process.env.DATA_BACKEND = 'own';
  const bundle = resolve('.codex-local/car-brands-check.mjs');
  const result = await build({ stdin: { contents: "export { default as handler } from './api/car-brands'; export { closePool } from './server/db';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false });
  await writeFile(bundle, result.outputFiles[0].contents);
  const api = await import(pathToFileURL(bundle).href);
  closePool = api.closePool;
  const list = await api.handler(new Request('http://localhost/api/car-brands'));
  assert.equal(list.status, 200);
  const brands = (await list.json()).brands;
  assert.equal(brands.length, rows.length);
  assert(!JSON.stringify(brands).includes('logo_base64'));
  const toyota = brands.find((b) => b.key === 'toyota');
  const image = await api.handler(new Request(`http://localhost${toyota.logo.path}`));
  assert.equal(image.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex'), toyota.logo.sha256);
  const cached = await api.handler(new Request(`http://localhost${toyota.logo.path}`, { headers: { 'If-None-Match': image.headers.get('etag') } }));
  assert.equal(cached.status, 304);
  console.log(`PASS: ${rows.length} PNGs decoded, dimensions/hashes/bytes match; seed repeat preserves curation; anon/auth read-only; real API list/logo/304 through own PostgreSQL adapter.`);
} finally {
  await closePool?.();
  await client.end();
}
