// Uses only a fresh disposable local database. Never reads .env.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import pg from 'pg';
import sharp from 'sharp';

const address = new URL(process.env.TEST_VEHICLE_VISUALS_DATABASE_URL ?? 'http://invalid');
assert(['127.0.0.1','localhost'].includes(address.hostname) && address.pathname === '/xpeed_visuals_test', 'Use the disposable local xpeed_visuals_test database');
const client = new pg.Client({ connectionString: address.toString() });
await client.connect();
let closePool;
try {
  if (!process.argv.includes('--existing')) {
    await client.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role');
    for (const file of ['20261113070000_car_brands.sql','20261113070100_car_brands_seed.sql','20261113072000_vehicle_visuals.sql','20261113072100_vehicle_visuals_seed.sql']) await client.query(await readFile(`supabase/migrations/${file}`, 'utf8'));
  }
  const manifest = JSON.parse(await readFile('docs/vehicle-visuals/catalog.json', 'utf8'));
  assert.equal((await client.query('SELECT count(*)::int AS n FROM public.vehicle_visuals')).rows[0].n, manifest.visuals.length);
  assert.equal((await client.query("SELECT count(*)::int AS n FROM public.vehicle_visuals WHERE make='Toyota' AND model='Prius' AND 2010 BETWEEN year_from AND year_to")).rows[0].n, 0, 'Never label the 2012 model as a 2010 Prius');
  for (const visual of manifest.visuals) {
    const bytes = await readFile(`public${visual.modelPath}`);
    assert.equal(bytes.subarray(0,4).toString(), 'glTF');
    assert.equal(bytes.readUInt32LE(4), 2);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), visual.modelSha256);
    const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
    assert(!json.extensionsRequired?.includes('EXT_meshopt_compression'));
    assert(!json.buffers?.some((buffer) => buffer.uri));
    assert(!json.images?.some((image) => image.uri));
    assert(json.meshes.length > 0 && json.asset.extras.author);
    if (process.argv.includes('--posters')) {
      const poster = sharp(await readFile(`public${visual.posterPath}`));
      const metadata = await poster.metadata();
      assert.equal(metadata.format, 'png');
      assert(metadata.hasAlpha, 'Poster must preserve transparency');
      const { data, info } = await poster.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let transparent = 0, opaque = 0;
      for(let i=3;i<data.length;i+=4) { if(data[i]<16) transparent++; if(data[i]>200) opaque++; }
      assert(transparent/(info.width*info.height) > 0.1, 'Poster must have a genuinely transparent background');
      assert(opaque/(info.width*info.height) > 0.03, 'Poster must contain a rendered vehicle');
    }
  }
  const seed = await readFile('supabase/migrations/20261113072100_vehicle_visuals_seed.sql', 'utf8');
  await client.query(seed);
  for (const role of ['anon','authenticated']) {
    await client.query(`SET ROLE ${role}`);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM public.vehicle_visuals')).rows[0].n, manifest.visuals.length);
    await assert.rejects(client.query("UPDATE public.vehicle_visuals SET make='changed'"), /permission denied/);
    await client.query('RESET ROLE');
  }
  process.env.DATABASE_URL = address.toString(); process.env.DATA_BACKEND='own'; process.env.DATABASE_SSL='false';
  const bundled = await build({ stdin: { contents: "export { default as handler } from './api/vehicle-visuals'; export { closePool } from './server/db';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false });
  const path=resolve('.codex-local/visuals-check.mjs'); await writeFile(path,bundled.outputFiles[0].contents);
  const api=await import(pathToFileURL(path).href); closePool=api.closePool;
  const response=await api.handler(new Request('http://localhost/api/vehicle-visuals'));
  assert.equal(response.status,200);
  assert.equal((await response.json()).visuals.length,manifest.visuals.length);
  assert.equal((await api.handler(new Request('http://localhost/api/vehicle-visuals',{method:'POST'}))).status,405);
  assert.equal((await api.handler(new Request('http://localhost/api/vehicle-visuals/bad'))).status,404);
  console.log(`PASS: ${manifest.visuals.length} attributed GLBs, local assets/hashes, strict year matching, repeat seed, read-only roles and own-PostgreSQL metadata API${process.argv.includes('--posters')?', transparent PNG posters':''}.`);
} finally { await closePool?.(); await client.end(); }
