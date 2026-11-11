// Xpeed Sim's server side (api/sim/*) on the app's own backend: real PostgreSQL via PGlite, a real
// file folder, real row level security. Pairing codes, device keys, lap upload, revoking.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-sim-'));
const filesRoot = mkdtempSync(resolve(temp, 'files-'));
const port = 55470;
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATA_BACKEND: 'own', DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', STORAGE_DIR: filesRoot,
  STORAGE_SECRET: 'test-secret', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
});

await build({
  entryPoints: {
    pair: 'api/sim/pair.ts', laps: 'api/sim/laps.ts', codes: 'api/sim/codes.ts', devices: 'api/sim/devices.ts', shared: 'api/sim/_shared.ts',
    lapfile: 'src/lib/sim/lap-file.ts', serverdb: 'server/db.ts', identity: 'server/identity.ts', dbroute: 'server/db-route.ts', account: 'server/account-route.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error',
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const pair = (await load('pair.mjs')).default, laps = (await load('laps.mjs')).default;
const codes = (await load('codes.mjs')).default, devices = (await load('devices.mjs')).default;
const { forgetLimits } = await load('shared.mjs');
const { getPool } = await load('serverdb.mjs');
const { gzipLap } = await load('lapfile.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createDbRoute } = await load('dbroute.mjs');
const { createAccountRoute } = await load('account.mjs');

const checks = [];
const check = async (name, test) => { forgetLimits(); await test(); checks.push(name); };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
// PGlite serves one connection at a time: the checks read the database through the app's own single-connection pool.
const direct = { query: (...args) => getPool().query(...args), end: async () => {} };

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

  const call = async (handler, path, { method = 'GET', bearer, body, headers = {}, ip = '10.0.0.1' } = {}) => {
    const raw = body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
    const response = await handler(new Request(`http://x${path}`, {
      method, headers: { 'x-real-ip': ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(raw === undefined || raw instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(raw === undefined ? {} : { body: raw }),
    }));
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json, headers: response.headers };
  };
  const newCode = async (who) => {
    forgetLimits(); // the helper is not what the per-hour limit check is about
    const r = await call(codes, '/api/sim/codes', { method: 'POST', bearer: who });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.code;
  };
  const pairWith = (code, name = 'RIG', ip) => call(pair, '/api/sim/pair', { method: 'POST', body: { code, device: { name } }, ip });
  const lapBytes = (number, overrides = {}) => gzipLap({
    header: {
      game: 'lmu', track: { name: 'Test Track', lengthM: 20 }, car: { name: 'Test Car' },
      lap: { number, timeMs: 1000, valid: true }, startedAt: '2026-11-10T12:00:00.000Z', sampleRateHz: 2, sampleCount: 3,
      channels: [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }], ...overrides,
    },
    data: { t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]) },
  });
  const upload = (key, body, extra = {}) => call(laps, '/api/sim/laps', { method: 'POST', bearer: key, body, headers: { 'content-type': 'application/gzip' }, ...extra });
  const deviceFor = async (who, name = 'RIG') => (await pairWith(await newCode(who), name)).body;

  await check('a signed-in person gets a pairing code; only its hash is stored', async () => {
    assert.equal((await call(codes, '/api/sim/codes', { method: 'POST' })).status, 401);
    assert.equal((await call(codes, '/api/sim/codes', { method: 'POST', bearer: 'not-a-token' })).status, 401);
    assert.equal((await call(codes, '/api/sim/codes', { method: 'GET', bearer: A })).status, 405);
    const r = await call(codes, '/api/sim/codes', { method: 'POST', bearer: A });
    assert.equal(r.status, 200);
    assert.match(r.body.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(new Date(r.body.expiresAt) > new Date(Date.now() + 9 * 60_000) && new Date(r.body.expiresAt) < new Date(Date.now() + 11 * 60_000));
    const rows = (await direct.query('SELECT code_hash FROM public.sim_pairing_codes WHERE user_id = $1', [ids.A])).rows;
    assert.ok(rows.some((row) => row.code_hash === sha(r.body.code.replace('-', ''))));
    assert.ok(rows.every((row) => !row.code_hash.includes(r.body.code.replace('-', ''))));
  });

  await check('a person may have five open codes, not more', async () => {
    await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
    for (let i = 0; i < 5; i++) assert.equal((await call(codes, '/api/sim/codes', { method: 'POST', bearer: B })).status, 200);
    const sixth = await call(codes, '/api/sim/codes', { method: 'POST', bearer: B });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error, 'too_many_open_codes');
    await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
  });

  await check('asking for codes is limited per hour', async () => {
    await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
    let last;
    for (let i = 0; i < 11; i++) {
      await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
      last = await call(codes, '/api/sim/codes', { method: 'POST', bearer: B });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'too_many_requests');
    await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
  });

  await check('pairing trades a code for a device key, once, and stores only the key hash', async () => {
    const code = await newCode(A);
    const typed = code.toLowerCase();
    const ok = await pairWith(typed, 'My Rig\u0007');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.token, /^xpd_[A-Za-z0-9_-]{43}$/);
    const device = (await direct.query('SELECT user_id, name, token_hash FROM public.sim_devices WHERE id = $1', [ok.body.deviceId])).rows[0];
    assert.equal(device.user_id, ids.A);
    assert.equal(device.name, 'My Rig', 'control characters are dropped');
    assert.equal(device.token_hash, sha(ok.body.token));
    assert.notEqual(device.token_hash, ok.body.token);
    assert.equal((await pairWith(code)).status, 404, 'the code works once');
  });

  await check('pairing refuses wrong, expired and malformed codes the same way', async () => {
    assert.equal((await pairWith('ZZZZ9999')).status, 404);
    assert.equal((await pairWith('')).status, 404);
    assert.equal((await call(pair, '/api/sim/pair', { method: 'POST', body: '{ not json' })).status, 400);
    assert.equal((await call(pair, '/api/sim/pair', { method: 'POST', body: { code: 12345678 } })).status, 404);
    assert.equal((await call(pair, '/api/sim/pair', { method: 'GET' })).status, 405);
    const code = await newCode(A);
    await direct.query("UPDATE public.sim_pairing_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1", [sha(code.replace('-', ''))]);
    assert.equal((await pairWith(code)).status, 404, 'an expired code');
  });

  await check('guessing codes is slowed down by address', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await pairWith('ABCD2345', 'RIG', '10.9.9.9');
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.notEqual((await pairWith('ABCD2345', 'RIG', '10.8.8.8')).status, 429, 'another address is not held back');
  });

  await check('a person with ten live devices cannot pair an eleventh', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    for (let i = 0; i < 10; i++) {
      await direct.query('DELETE FROM public.sim_pairing_codes WHERE user_id = $1', [ids.B]);
      assert.equal((await pairWith(await newCode(B), `PC ${i}`, `10.1.0.${i}`)).status, 200);
    }
    const code = await newCode(B);
    const refused = await pairWith(code);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'device_limit');
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    assert.equal((await pairWith(code)).status, 200, 'the code was not spent by the refusal');
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('a lap is checked, stored as the same bytes, and a repeat is recognized', async () => {
    const { token: key, deviceId } = await deviceFor(A);
    const bytes = await lapBytes(1);
    const first = await upload(key, bytes);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.duplicate, false);
    const row = (await direct.query('SELECT * FROM public.sim_laps WHERE id = $1', [first.body.id])).rows[0];
    assert.equal(row.user_id, ids.A);
    assert.equal(row.device_id, deviceId);
    assert.equal(row.identity, 'lmu|Test Track|Test Car|2026-11-10T12:00:00.000Z|1|1000|3');
    assert.deepEqual([row.game, row.track_name, row.car_name, row.lap_number, row.time_ms, row.valid, row.sample_count, row.size_bytes],
      ['lmu', 'Test Track', 'Test Car', 1, 1000, true, 3, bytes.length]);
    const file = resolve(filesRoot, 'sim-laps', row.storage_path);
    assert.ok(existsSync(file), 'the file is on the volume');
    assert.deepEqual(new Uint8Array(readFileSync(file)), bytes, 'exactly what was sent');
    assert.ok(row.storage_path.startsWith(`${ids.A}/`) && row.storage_path.endsWith('.xlap.gz'));

    const again = await upload(key, bytes);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { id: first.body.id, duplicate: true });
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1 AND identity = $2', [ids.A, row.identity])).rows[0].n, 1);
    assert.equal((await upload(key, await lapBytes(2))).status, 201, 'another lap is a new lap');
    const seen = (await direct.query('SELECT last_seen_at, last_lap_at FROM public.sim_devices WHERE id = $1', [deviceId])).rows[0];
    assert.ok(seen.last_seen_at && seen.last_lap_at, 'the device is marked as seen');
  });

  await check('the same lap from two accounts is two laps, each kept for its owner', async () => {
    const [a, b] = [await deviceFor(A, 'A rig'), await deviceFor(B, 'B rig')];
    const bytes = await lapBytes(7);
    const [ra, rb] = [await upload(a.token, bytes), await upload(b.token, bytes)];
    assert.deepEqual([ra.status, rb.status], [201, 201]);
    assert.notEqual(ra.body.id, rb.body.id);
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1 AND id <> $2', [ids.B, b.deviceId]);
  });

  await check('what is not a lap file is refused, and nothing is stored for it', async () => {
    const { token: key } = await deviceFor(A);
    const before = (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps')).rows[0].n;
    for (const body of [new TextEncoder().encode('definitely not a lap'), new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]), (await lapBytes(3)).slice(0, 30)]) {
      const r = await upload(key, body);
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.match(r.body.error, /not a valid lap file/);
    }
    assert.equal((await upload(key, new Uint8Array(0))).status, 400);
    assert.equal((await upload(key, new Uint8Array(16 * 1024 * 1024 + 1))).status, 413);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps')).rows[0].n, before);
  });

  await check('uploads need a live device key', async () => {
    const bytes = await lapBytes(9);
    assert.equal((await upload('', bytes)).status, 401);
    assert.equal((await upload('xpd_unknown', bytes)).status, 401);
    // A person's own sign-in token is not a device key.
    assert.equal((await upload(A, bytes)).status, 401);
    assert.equal((await call(laps, '/api/sim/laps', { method: 'GET' })).status, 405);
  });

  await check('uploads are limited per device', async () => {
    const { token: key } = await deviceFor(A);
    let last;
    for (let i = 0; i < 61; i++) last = await upload(key, new TextEncoder().encode('x'));
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
  });

  await check('a person lists their own devices (never the key) and cannot see anyone else\'s', async () => {
    const own = await call(devices, '/api/sim/devices', { bearer: A });
    assert.equal(own.status, 200);
    assert.ok(own.body.devices.length >= 3);
    for (const d of own.body.devices) {
      assert.deepEqual(Object.keys(d).sort(), ['created_at', 'id', 'last_lap_at', 'last_seen_at', 'name', 'revoked_at']);
    }
    const theirs = await call(devices, '/api/sim/devices', { bearer: B });
    assert.ok(theirs.body.devices.every((d) => !own.body.devices.some((o) => o.id === d.id)));
    assert.equal((await call(devices, '/api/sim/devices')).status, 401);
  });

  await check('row level security: a person reads their own laps and devices, never the key hash', async () => {
    const mine = await query(A, { table: 'sim_laps', action: 'select', select: 'identity' });
    assert.equal(mine.error, null, JSON.stringify(mine.error));
    assert.ok(mine.data.length >= 3 && mine.data.every((r) => typeof r.identity === 'string'));
    const own = await query(A, { table: 'sim_devices', action: 'select', select: 'id,name' });
    assert.equal(own.error, null);
    assert.ok(own.data.length >= 3);
    const hash = await query(A, { table: 'sim_devices', action: 'select', select: 'token_hash' });
    assert.ok(hash.error, 'the key hash is not a readable column');
    const codesTable = await query(A, { table: 'sim_pairing_codes', action: 'select', select: 'code_hash' });
    assert.ok(codesTable.error || codesTable.data.length === 0, 'codes are not readable by the person');
    const forged = await query(A, { table: 'sim_laps', action: 'insert', values: { user_id: ids.A, identity: 'x' }, returning: false });
    assert.ok(forged.error, 'a person cannot write laps themselves');
    const nobody = await query(null, { table: 'sim_laps', action: 'select', select: 'id' });
    assert.ok(nobody.error || nobody.data.length === 0);
    // B sees none of A's laps.
    const others = await query(B, { table: 'sim_laps', action: 'select', select: 'identity', filters: [{ column: 'user_id', op: 'eq', value: ids.A }] });
    assert.equal(others.error, null);
    assert.equal(others.data.length, 0);
  });

  await check('revoking a device stops its next upload; nobody can revoke someone else\'s', async () => {
    const { token: key, deviceId } = await deviceFor(A, 'To revoke');
    const bytes = await lapBytes(11);
    assert.equal((await upload(key, bytes)).status, 201);
    assert.equal((await call(devices, `/api/sim/devices?id=${deviceId}`, { method: 'DELETE', bearer: B })).status, 404);
    assert.equal((await call(devices, `/api/sim/devices?id=${deviceId}`, { method: 'DELETE' })).status, 401);
    assert.equal((await call(devices, '/api/sim/devices?id=not-a-uuid', { method: 'DELETE', bearer: A })).status, 400);
    const revoked = await call(devices, `/api/sim/devices?id=${deviceId}`, { method: 'DELETE', bearer: A });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal((await upload(key, await lapBytes(12))).status, 401, 'the revoked key is refused');
    assert.equal((await call(devices, `/api/sim/devices?id=${deviceId}`, { method: 'DELETE', bearer: A })).status, 404, 'already revoked');
    const listed = (await call(devices, '/api/sim/devices', { bearer: A })).body.devices.find((d) => d.id === deviceId);
    assert.ok(listed.revoked_at, 'it stays in the list, marked revoked');
    // Laps it already sent are kept.
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE device_id = $1', [deviceId])).rows[0].n, 1);
  });

  await check('the browser preflight is answered, and the Xpeed Sim endpoints are not open to every method', async () => {
    assert.equal((await call(codes, '/api/sim/codes', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(devices, '/api/sim/devices', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(devices, '/api/sim/devices', { method: 'POST', bearer: A, body: {} })).status, 405);
  });

  console.log(`${checks.length} sim checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await direct.end().catch(() => {});
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
