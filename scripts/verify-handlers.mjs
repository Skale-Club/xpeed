// The api/* handlers (fuel, vehicle care, trip checkpoints, shared media, problem sync) running on
// the app's own backend (DATA_BACKEND=own): real PostgreSQL via PGlite, a real file folder, real
// row level security. No .env, network or remote credentials.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureIdentityProject, migrate } from '../db/migrate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');
const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');

mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-handlers-'));
const filesRoot = mkdtempSync(resolve(temp, 'files-'));
const port = 54450;
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATA_BACKEND: 'own', DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', STORAGE_DIR: filesRoot,
  STORAGE_SECRET: 'test-secret', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
});

await build({
  entryPoints: {
    care: 'api/vehicle-care.ts', fuel: 'api/fuel.ts', trips: 'api/trip-checkpoints.ts', media: 'api/shared-media.ts', problems: 'api/sync-problems.ts',
    identity: 'server/identity.ts', dbroute: 'server/db-route.ts', account: 'server/account-route.ts', recording: 'src/lib/recording-identity.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error',
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const care = (await load('care.mjs')).default, fuel = (await load('fuel.mjs')).default, trips = (await load('trips.mjs')).default;
const media = (await load('media.mjs')).default, problems = (await load('problems.mjs')).default;
const { useKeysForTesting } = await load('identity.mjs');
const { createDbRoute } = await load('dbroute.mjs');
const { createAccountRoute } = await load('account.mjs');
const { recordedSessionId } = await load('recording.mjs');

const checks = [];
const check = async (name, test) => { await test(); checks.push(name); };
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

try {
  const setup = new pg.Client({ connectionString: databaseUrl });
  await setup.connect();
  await migrate(setup);
  await ensureIdentityProject(setup, 'skaleclub');
  await setup.end();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  useKeysForTesting(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] }));
  const token = (sub, extra = {}) => new SignJWT({ firebase: { sign_in_provider: 'phone' }, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/skaleclub').setAudience('skaleclub')
    .setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const A = await token('uid-a', { phone_number: '+15550000001' }), B = await token('uid-b', { phone_number: '+15550000002' });

  const accounts = createAccountRoute();
  const ids = {};
  for (const [name, t] of [['A', A], ['B', B]]) {
    const r = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${t}` } }));
    assert.equal(r.status, 200);
    ids[name] = (await r.json()).id;
  }
  const dbRoute = createDbRoute();
  const query = async (bearer, body) => (await (await dbRoute(new Request('http://x/api/db', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ kind: 'query', ...body }),
  }))).json());
  const car = async (bearer, name) => {
    const r = await query(bearer, { table: 'car_profiles', action: 'insert', values: { name }, returning: true, select: 'id', shape: 'single' });
    assert.equal(r.error, null, JSON.stringify(r.error));
    return r.data.id;
  };
  const carA = await car(A, 'Prius'), carB = await car(B, 'Civic');
  const call = async (handler, path, { method = 'GET', bearer, body, headers = {} } = {}) => {
    const response = await handler(new Request(`http://x${path}`, {
      method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  await check('handlers: no token, a bad token and another person\'s car are all refused', async () => {
    for (const [handler, path] of [[care, '/api/vehicle-care'], [fuel, '/api/fuel'], [trips, '/api/trip-checkpoints']]) {
      assert.equal((await call(handler, `${path}?carId=${carA}`)).status, 401, path);
      assert.equal((await call(handler, `${path}?carId=${carA}`, { bearer: 'garbage' })).status, 401, path);
      assert.equal((await call(handler, `${path}?carId=${carA}`, { bearer: B })).status, 404, `${path} other person's car`);
    }
    assert.equal((await call(problems, '/api/sync-problems', { method: 'POST', body: {} })).status, 401);
  });

  await check('vehicle care: reads defaults, saves once, refuses a stale revision', async () => {
    const first = await call(care, `/api/vehicle-care?carId=${carA}`, { bearer: A });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, null);
    const state = { ...first.body.state, odometerKm: 120000, oilDueKm: 125000, enabled: true };
    const saved = await call(care, `/api/vehicle-care?carId=${carA}`, { method: 'PUT', bearer: A, body: { state, revision: null } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.state.oilDueKm, 125000);
    assert.ok(saved.body.revision);
    const stale = await call(care, `/api/vehicle-care?carId=${carA}`, { method: 'PUT', bearer: A, body: { state, revision: null } });
    assert.equal(stale.status, 409);
    const again = await call(care, `/api/vehicle-care?carId=${carA}`, { method: 'PUT', bearer: A, body: { state: { ...state, oilDueKm: 130000 }, revision: saved.body.revision } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal((await call(care, `/api/vehicle-care?carId=${carA}`, { bearer: A })).body.state.oilDueKm, 130000);
  });

  await check('fuel: records are files; the same intent is replayed, a different one conflicts, delete removes', async () => {
    const entry = { kind: 'fill', at: new Date(Date.now() - 3600_000).toISOString(), litres: 40, pricePerLitre: 5, totalPaid: 200, currency: 'USD', odometerKm: 1000, fullTank: true, source: 'receipt', region: '', sourceUrl: '', note: '' };
    const intent = '11111111-2222-4333-8444-555555555555';
    const created = await call(fuel, `/api/fuel?carId=${carA}`, { method: 'POST', bearer: A, body: entry, headers: { 'idempotency-key': intent } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.id, intent);
    assert.equal(created.body.pricePerLitre, 5);
    const replay = await call(fuel, `/api/fuel?carId=${carA}`, { method: 'POST', bearer: A, body: entry, headers: { 'idempotency-key': intent } });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, intent);
    const conflict = await call(fuel, `/api/fuel?carId=${carA}`, { method: 'POST', bearer: A, body: { ...entry, litres: 41, totalPaid: 205 }, headers: { 'idempotency-key': intent } });
    assert.equal(conflict.status, 409);
    assert.equal((await call(fuel, `/api/fuel?carId=${carA}`, { method: 'POST', bearer: A, body: { ...entry, litres: -1 } })).status, 400);
    const listed = await call(fuel, `/api/fuel?carId=${carA}`, { bearer: A });
    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body.entries ?? listed.body.items ?? listed.body).map?.((e) => e.id), [intent]);
    assert.equal((await call(fuel, `/api/fuel?carId=${carA}&id=${intent}`, { method: 'DELETE', bearer: A })).status, 200);
    assert.deepEqual((await call(fuel, `/api/fuel?carId=${carA}`, { bearer: A })).body.entries ?? [], []);
  });

  let tripId;
  await check('trip checkpoints: samples are stored in folders, listed, rebuilt, and finalized into a saved trip', async () => {
    const startedAt = Date.now() - 600_000;
    tripId = await recordedSessionId(ids.A, carA, `trip-${startedAt}`);
    const post = (body, bearer = A) => call(trips, `/api/trip-checkpoints?carId=${carA}&id=${tripId}`, { method: 'POST', bearer, body });
    const columns = ['Engine RPM', 'Coolant'];
    const sample = (t) => ({ t, values: { 'Engine RPM': 800 + t, Coolant: 90 } });
    assert.equal((await post({ startedAt, offset: 0, columns, samples: [sample(0), sample(1), sample(2)] })).body.accepted, 3);
    assert.equal((await post({ startedAt, offset: 0, columns, samples: [sample(0), sample(1), sample(2)] })).body.accepted, 3, 'the same batch twice is accepted once');
    assert.equal((await post({ startedAt, offset: 0, columns, samples: [sample(0), { t: 1, values: { 'Engine RPM': 1 } }] })).status, 409);
    assert.equal((await post({ startedAt: startedAt + 1, offset: 0, columns, samples: [sample(0)] })).status, 400, 'another recording identity is refused');
    assert.equal((await post({ startedAt, offset: 0, columns, samples: [sample(0)] }, B)).status, 404);
    const listed = await call(trips, `/api/trip-checkpoints?carId=${carA}`, { bearer: A });
    assert.deepEqual(listed.body.items.map((i) => i.id), [tripId]);
    const rebuilt = await call(trips, `/api/trip-checkpoints?carId=${carA}&id=${tripId}`, { bearer: A });
    assert.equal(rebuilt.body.trip.samples.length, 3);
    assert.equal((await post({ startedAt, offset: 3, columns, samples: [sample(3)], endedAt: startedAt + 4000, totalSamples: 4 })).status, 200);
    const finalized = await post({ action: 'finalize' });
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    assert.equal(finalized.body.sessionId, tripId);
    const saved = await query(A, { table: 'sessions', action: 'select', select: 'id, source_filename, row_count', filters: [{ column: 'id', op: 'eq', value: tripId }], shape: 'single' });
    assert.equal(saved.error, null, JSON.stringify(saved.error));
    assert.equal(saved.data.id, tripId);
    // The person who recorded it owns it; the other person cannot see it.
    assert.equal((await query(B, { table: 'sessions', action: 'select', select: 'id', filters: [{ column: 'id', op: 'eq', value: tripId }] })).data.length, 0);
    // Once saved, the recording's temporary folder is cleaned up on the next listing.
    assert.deepEqual((await call(trips, `/api/trip-checkpoints?carId=${carA}`, { bearer: A })).body.items, []);
  });

  await check('shared media: a public link answers without a token, an unknown or foreign one does not', async () => {
    const link = await query(A, { table: 'shared_reports', action: 'insert', values: { session_id: tripId }, returning: true, select: 'id', shape: 'single' });
    assert.equal(link.error, null, JSON.stringify(link.error));
    const open = await call(media, `/api/shared-media?id=${link.data.id}`);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.deepEqual(open.body.items ?? [], []);
    assert.equal((await call(media, '/api/shared-media?id=99999999-9999-4999-8999-999999999999')).status, 404);
    assert.equal((await call(media, `/api/shared-media?id=${link.data.id}`, { method: 'POST', body: { ids: [] }, bearer: B })).status, 404);
    assert.equal((await call(media, `/api/shared-media?id=${link.data.id}`, { method: 'POST', body: { ids: [] } })).status, 401);
  });

  await check('problem sync: the person\'s own jobs, nobody else\'s', async () => {
    const mine = await call(problems, '/api/sync-problems', { method: 'POST', bearer: A, body: {} });
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal((await call(problems, '/api/sync-problems', { method: 'POST', bearer: A, body: { sessionId: 'not-a-uuid' } })).status, 400);
    assert.equal((await call(problems, '/api/sync-problems', { method: 'POST', bearer: B, body: {} })).status, 200);
  });

  await check('deleting a saved trip leaves a mark, so the phone cannot bring it back (accounts that exist only as app_accounts)', async () => {
    assert.equal((await query(A, { table: 'session_deletions', action: 'select', select: 'recording_id', filters: [{ column: 'recording_id', op: 'eq', value: tripId }] })).data.length, 0);
    const removed = await query(A, { table: 'sessions', action: 'delete', filters: [{ column: 'id', op: 'eq', value: tripId }], returning: true, select: 'id' });
    assert.equal(removed.error, null, JSON.stringify(removed.error));
    assert.equal(removed.data.length, 1, 'the owner can delete their trip');
    const mark = await query(A, { table: 'session_deletions', action: 'select', select: 'recording_id, car_profile_id', filters: [{ column: 'recording_id', op: 'eq', value: tripId }] });
    assert.equal(mark.error, null, JSON.stringify(mark.error));
    assert.equal(mark.data.length, 1, 'the deletion is remembered');
    assert.equal(mark.data[0].car_profile_id, carA);
    assert.equal((await query(B, { table: 'session_deletions', action: 'select', select: 'recording_id', filters: [{ column: 'recording_id', op: 'eq', value: tripId }] })).data.length, 0, 'nobody else sees it');
  });

  console.log(`${checks.length} handler checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
