// Xpeed Sim's server side (api/sim/*) on the app's own backend: real PostgreSQL via PGlite, a real
// file folder, real row level security. Pairing codes, device keys, lap upload, revoking, track layouts.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { build } from 'esbuild';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureIdentityProject, migrate } from '../db/migrate.mjs';
import { edgeFunctions } from './esbuild-edge.mjs';

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
    pair: 'api/sim/pair.ts', laps: 'api/sim/laps.ts', codes: 'api/sim/codes.ts', devices: 'api/sim/devices.ts', link: 'api/sim/link.ts', tracks: 'api/sim/tracks.ts', me: 'api/sim/me.ts', games: 'api/sim/games.ts', shared: 'api/sim/_shared.ts', upload: 'api/sim/_upload.ts', health: 'server/health.ts', webserver: 'server/index.ts',
    lapfile: 'src/lib/sim/lap-file.ts', serverdb: 'server/db.ts', identity: 'server/identity.ts', dbroute: 'server/db-route.ts', account: 'server/account-route.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error', plugins: [edgeFunctions],
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const pair = (await load('pair.mjs')).default, laps = (await load('laps.mjs')).default;
const codes = (await load('codes.mjs')).default, devices = (await load('devices.mjs')).default;
const tracks = (await load('tracks.mjs')).default;
const link = (await load('link.mjs')).default;
const me = (await load('me.mjs')).default;
const games = (await load('games.mjs')).default;
const { uploadsInFlight } = await load('upload.mjs');
const { forgetDeepHealth } = await load('health.mjs');
const { createXpeedServer } = await load('webserver.mjs');
const { forgetLimits, reply: sharedReply } = await load('shared.mjs');
const { getPool, closePool } = await load('serverdb.mjs');
const { gzipLap } = await load('lapfile.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createDbRoute } = await load('dbroute.mjs');
const { createAccountRoute } = await load('account.mjs');

const checks = [];
// The in-memory limiters and the database's upload counters (sim_rate) both start from zero for every check.
const check = async (name, test) => { forgetLimits(); if (resetRates) await resetRates(); await test(); checks.push(name); };
let resetRates;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
// PGlite serves one connection at a time: the checks read the database through the app's own single-connection pool.
const direct = { query: (...args) => getPool().query(...args), end: async () => {} };
resetRates = () => direct.query('DELETE FROM public.sim_rate');
let webServer;

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

  // ---- Connecting without a code: the app makes its own key and sends only its hash; the person approves in the browser.
  const linkApi = (path, opts) => call(link, `/api/sim/link${path}`, opts);
  const newKey = () => `xpd_${randomBytes(32).toString('base64url')}`;
  const startLink = (key, name = 'RIG', ip) => linkApi('', { method: 'POST', body: { device: { name }, tokenHash: sha(key) }, ip });
  const pollLink = (id, key, ip) => linkApi(`/${id}/poll`, { method: 'POST', bearer: key, ip });

  await check('link: start, read, approve, poll returns approved with the account, and the key uploads a lap', async () => {
    await direct.query("UPDATE public.app_accounts SET email = 'ana@example.com' WHERE id = $1", [ids.A]);
    const key = newKey();
    const started = await startLink(key, 'My Rig\u0007');
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.match(started.body.id, /^[0-9a-f-]{36}$/);
    assert.ok(new Date(started.body.expiresAt) > new Date(Date.now() + 9 * 60_000) && new Date(started.body.expiresAt) < new Date(Date.now() + 11 * 60_000));
    const row = (await direct.query('SELECT token_hash, device_name FROM public.sim_link_requests WHERE id = $1', [started.body.id])).rows[0];
    assert.equal(row.token_hash, sha(key), 'only the hash is kept');
    assert.equal(row.device_name, 'My Rig');
    assert.equal((await pollLink(started.body.id, key)).body.status, 'pending');
    const read = await linkApi(`/${started.body.id}`, { bearer: A });
    assert.equal(read.status, 200);
    assert.deepEqual({ ...read.body, expiresAt: undefined, verifyCode: undefined }, { deviceName: 'My Rig', deviceNameFromComputer: true, status: 'pending', expiresAt: undefined, verifyCode: undefined });
    assert.equal(read.body.verifyCode, started.body.verifyCode);
    // No device exists yet: the key is not accepted for laps.
    assert.equal((await upload(key, await lapBytes(61))).status, 401);
    const approved = await linkApi(`/${started.body.id}/approve`, { method: 'POST', bearer: A });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    const device = (await direct.query('SELECT user_id, name, token_hash FROM public.sim_devices WHERE id = $1', [approved.body.deviceId])).rows[0];
    assert.deepEqual({ ...device }, { user_id: ids.A, name: 'My Rig', token_hash: sha(key) });
    const linked = (await direct.query('SELECT status, user_id, device_id, decided_at FROM public.sim_link_requests WHERE id = $1', [started.body.id])).rows[0];
    assert.equal(linked.status, 'approved');
    assert.equal(linked.user_id, ids.A);
    assert.equal(linked.device_id, approved.body.deviceId);
    assert.ok(linked.decided_at);
    const polled = await pollLink(started.body.id, key);
    assert.deepEqual(polled.body, { status: 'approved', account: 'ana@example.com' });
    assert.equal((await linkApi(`/${started.body.id}`, { bearer: A })).body.status, 'approved');
    const lap = await upload(key, await lapBytes(61));
    assert.equal(lap.status, 201, JSON.stringify(lap.body));
    assert.equal((await direct.query('SELECT user_id, device_id FROM public.sim_laps WHERE id = $1', [lap.body.id])).rows[0].user_id, ids.A);
    const twice = await linkApi(`/${started.body.id}/approve`, { method: 'POST', bearer: A });
    assert.equal(twice.status, 409, 'a request is decided once');
    assert.equal(twice.body.error, 'already_decided');
  });

  await check('link: the account answer falls back to the name when there is no email', async () => {
    await direct.query("UPDATE public.app_accounts SET email = NULL, full_name = 'Bia Souza' WHERE id = $1", [ids.B]);
    const key = newKey();
    const { body } = await startLink(key);
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    assert.equal((await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: B })).status, 200);
    assert.deepEqual((await pollLink(body.id, key)).body, { status: 'approved', account: 'Bia Souza' });
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('link: a poll with the wrong key, no key, or an unknown id is 404', async () => {
    const key = newKey();
    const { body } = await startLink(key);
    for (const wrong of [newKey(), 'x', '']) {
      const r = await pollLink(body.id, wrong);
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, { error: 'not_found' });
    }
    assert.equal((await pollLink('00000000-0000-4000-8000-000000000000', key)).status, 404);
    assert.equal((await pollLink('not-a-uuid', key)).status, 404);
    assert.equal((await pollLink(body.id, key)).status, 200);
    assert.equal((await linkApi(`/${body.id}/poll`, { method: 'GET', bearer: key })).status, 405);
  });

  await check('link: a request that is not approved in ten minutes expires, and cannot be approved', async () => {
    const key = newKey();
    const { body } = await startLink(key);
    await direct.query("UPDATE public.sim_link_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [body.id]);
    assert.deepEqual((await pollLink(body.id, key)).body, { status: 'expired' });
    assert.equal((await linkApi(`/${body.id}`, { bearer: A })).body.status, 'expired');
    const refused = await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: A });
    assert.equal(refused.status, 410);
    assert.equal(refused.body.error, 'expired');
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_devices WHERE token_hash = $1', [sha(key)])).rows[0].n, 0);
  });

  await check('link: cancel is told to the app, and a cancelled or approved request cannot be cancelled again', async () => {
    const key = newKey();
    const { body } = await startLink(key);
    const cancelled = await linkApi(`/${body.id}/cancel`, { method: 'POST', bearer: A });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body, { status: 'cancelled' });
    assert.deepEqual((await pollLink(body.id, key)).body, { status: 'cancelled' });
    assert.equal((await linkApi(`/${body.id}`, { bearer: A })).body.status, 'cancelled');
    assert.equal((await linkApi(`/${body.id}/cancel`, { method: 'POST', bearer: A })).status, 409);
    assert.equal((await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: A })).body.error, 'already_decided');
    assert.equal((await linkApi('/00000000-0000-4000-8000-000000000000/cancel', { method: 'POST', bearer: A })).status, 404);
    const second = (await startLink(newKey())).body;
    await linkApi(`/${second.id}/approve`, { method: 'POST', bearer: A });
    const late = await linkApi(`/${second.id}/cancel`, { method: 'POST', bearer: A });
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'already_decided');
  });

  await check('link: a person with ten live devices cannot approve an eleventh, and the request stays pending', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    for (let i = 0; i < 10; i++) {
      const { body } = await startLink(newKey(), `PC ${i}`, `10.2.0.${i}`);
      assert.equal((await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: B })).status, 200);
    }
    const key = newKey();
    const { body } = await startLink(key);
    const refused = await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: B });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'device_limit');
    assert.equal((await pollLink(body.id, key)).body.status, 'pending');
    await direct.query("UPDATE public.sim_devices SET revoked_at = now() WHERE user_id = $1 AND name = 'PC 0'", [ids.B]);
    assert.equal((await linkApi(`/${body.id}/approve`, { method: 'POST', bearer: B })).status, 200, 'a revoked device frees a place');
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('link: a key hash cannot be reused, and a bad start is refused', async () => {
    const key = newKey();
    const first = await startLink(key);
    assert.equal(first.status, 201);
    const again = await startLink(key);
    assert.equal(again.status, 409);
    assert.deepEqual(again.body, { error: 'invalid_request' });
    await linkApi(`/${first.body.id}/approve`, { method: 'POST', bearer: A });
    assert.equal((await startLink(key)).status, 409, 'the hash is a device now');
    for (const body of [{ device: { name: 'x' } }, { device: { name: 'x' }, tokenHash: 'ABC' }, { device: { name: 'x' }, tokenHash: 'A'.repeat(64) }, { device: { name: 'x' }, tokenHash: 12 }, null]) {
      assert.equal((await linkApi('', { method: 'POST', body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await linkApi('', { method: 'POST', body: '{ not json' })).status, 400);
    assert.equal((await linkApi('', { method: 'GET' })).status, 405);
    const unnamed = await startLink(newKey(), '   ', '10.3.3.3');
    assert.equal((await direct.query('SELECT device_name FROM public.sim_link_requests WHERE id = $1', [unnamed.body.id])).rows[0].device_name, 'Windows PC');
    const long = await startLink(newKey(), 'x'.repeat(100), '10.3.3.4');
    assert.equal((await direct.query('SELECT device_name FROM public.sim_link_requests WHERE id = $1', [long.body.id])).rows[0].device_name.length, 60);
  });

  await check('link: the start answer and the read carry the same 4-character verification code, derived from the id and the key hash', async () => {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    // The contract, written out independently of the server: sha256(id + tokenHash), first four bytes, each onto the alphabet.
    const expected = (id, tokenHash) => Array.from(createHash('sha256').update(id + tokenHash).digest().subarray(0, 4), (byte) => ALPHABET[byte % 32]).join('');
    const key = newKey();
    const started = await startLink(key, 'Look Alike');
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.verifyCode.length, 4);
    assert.match(started.body.verifyCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    assert.equal(started.body.verifyCode, expected(started.body.id, sha(key)));
    const read = await linkApi(`/${started.body.id}`, { bearer: A });
    assert.equal(read.body.verifyCode, started.body.verifyCode, 'the page shows what the app shows');
    assert.equal(read.body.deviceNameFromComputer, true);
    assert.equal(read.body.deviceName, 'Look Alike');
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = $1 AND column_name ILIKE $2', ['sim_link_requests', '%verify%'])).rows[0].n, 0, 'nothing new is stored');
    // Another request, another code (the same 4 characters twice in a row would be a 1 in a million chance).
    const other = await startLink(newKey(), 'Look Alike', '10.4.4.4');
    assert.notEqual(other.body.verifyCode, started.body.verifyCode);
    const gone = await linkApi('/00000000-0000-4000-8000-000000000000', { bearer: A });
    assert.equal(gone.body.verifyCode, undefined, 'an unknown request has no code to show');
  });

  await check('link: a cancel by another signed-in person works only while the request is pending, and the decider is kept', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    const pending = (await startLink(newKey(), 'Pending', '10.4.5.1')).body;
    assert.equal((await linkApi(`/${pending.id}`, { bearer: A })).status, 200, 'A reads it');
    const cancelled = await linkApi(`/${pending.id}/cancel`, { method: 'POST', bearer: B });
    assert.equal(cancelled.status, 200, 'B cancels it before it is approved');
    const row = (await direct.query('SELECT status, user_id FROM public.sim_link_requests WHERE id = $1', [pending.id])).rows[0];
    assert.deepEqual({ ...row }, { status: 'cancelled', user_id: ids.B });

    const key = newKey();
    const decided = (await startLink(key, 'Decided', '10.4.5.2')).body;
    assert.equal((await linkApi(`/${decided.id}/approve`, { method: 'POST', bearer: B })).status, 200);
    const late = await linkApi(`/${decided.id}/cancel`, { method: 'POST', bearer: A });
    assert.equal(late.status, 409, 'A cannot cancel what B approved');
    assert.equal(late.body.error, 'already_decided');
    const after = (await direct.query('SELECT status, user_id FROM public.sim_link_requests WHERE id = $1', [decided.id])).rows[0];
    assert.deepEqual({ ...after }, { status: 'approved', user_id: ids.B });
    assert.equal((await pollLink(decided.id, key)).body.status, 'approved');
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('link: reading, approving and cancelling need a signed-in person', async () => {
    const { body } = await startLink(newKey());
    for (const [path, method] of [[`/${body.id}`, 'GET'], [`/${body.id}/approve`, 'POST'], [`/${body.id}/cancel`, 'POST']]) {
      assert.equal((await linkApi(path, { method })).status, 401, `${method} ${path} without a token`);
      assert.equal((await linkApi(path, { method, bearer: 'not-a-token' })).status, 401, `${method} ${path} with a bad token`);
    }
    assert.equal((await direct.query('SELECT status FROM public.sim_link_requests WHERE id = $1', [body.id])).rows[0].status, 'pending');
    assert.equal((await linkApi(`/${body.id}`, { bearer: A })).status, 200);
    assert.equal((await linkApi('/00000000-0000-4000-8000-000000000000', { bearer: A })).status, 404);
    assert.equal((await linkApi(`/${body.id}/approve`, { method: 'GET', bearer: A })).status, 405);
    const options = await linkApi(`/${body.id}/approve`, { method: 'OPTIONS' });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get('access-control-allow-origin'), null, 'no Origin, nothing to echo');
  });

  await check('link: starting and polling are rate limited', async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await startLink(newKey(), 'RIG', '10.7.7.7');
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.equal((await startLink(newKey(), 'RIG', '10.7.7.8')).status, 201, 'another address is not held back');
    const key = newKey();
    const { body } = await startLink(key, 'RIG', '10.7.7.9');
    let poll;
    for (let i = 0; i < 61; i++) poll = await pollLink(body.id, key, '10.6.6.6');
    assert.equal(poll.status, 429);
    assert.equal((await pollLink(body.id, key, '10.6.6.7')).status, 200);
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
    assert.equal((await call(laps, '/api/sim/laps', { method: 'PUT' })).status, 405);
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

  await check('me: a paired device gets its account email and device name, the name when there is no email, never anything else', async () => {
    await direct.query("UPDATE public.app_accounts SET email = 'ana@example.com', full_name = 'Ana Lima' WHERE id = $1", [ids.A]);
    const a = await deviceFor(A, 'Ana PC');
    const got = await call(me, '/api/sim/me', { bearer: a.token });
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.deepEqual(got.body, { account: 'ana@example.com', deviceName: 'Ana PC' });
    await direct.query("UPDATE public.app_accounts SET email = NULL, full_name = 'Ana Lima' WHERE id = $1", [ids.A]);
    assert.equal((await call(me, '/api/sim/me', { bearer: a.token })).body.account, 'Ana Lima', 'the name is the fallback');
    await direct.query("UPDATE public.app_accounts SET email = '', full_name = '' WHERE id = $1", [ids.A]);
    assert.equal((await call(me, '/api/sim/me', { bearer: a.token })).body.account, '+15550000001', 'then the phone');
    await direct.query("UPDATE public.app_accounts SET email = 'ana@example.com' WHERE id = $1", [ids.A]);
    assert.equal((await call(me, '/api/sim/me', { method: 'POST', bearer: a.token })).status, 405);
  });

  await check('me: no key, an unknown key and a revoked key are 401', async () => {
    assert.deepEqual((await call(me, '/api/sim/me')).body, { error: 'unauthorized' });
    const unknown = await call(me, '/api/sim/me', { bearer: newKey() });
    assert.equal(unknown.status, 401);
    assert.deepEqual(unknown.body, { error: 'unauthorized' });
    const d = await deviceFor(B, 'To revoke');
    assert.equal((await call(me, '/api/sim/me', { bearer: d.token })).status, 200);
    await direct.query('UPDATE public.sim_devices SET revoked_at = now() WHERE id = $1', [d.deviceId]);
    const revoked = await call(me, '/api/sim/me', { bearer: d.token });
    assert.equal(revoked.status, 401);
    assert.deepEqual(revoked.body, { error: 'unauthorized' });
  });

  await check('me: asking is limited to 30 a minute per device', async () => {
    const d = await deviceFor(B, 'Chatty');
    for (let i = 0; i < 30; i++) assert.equal((await call(me, '/api/sim/me', { bearer: d.token })).status, 200);
    const last = await call(me, '/api/sim/me', { bearer: d.token });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  await check('the browser preflight is answered, and the Xpeed Sim endpoints are not open to every method', async () => {
    assert.equal((await call(codes, '/api/sim/codes', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(devices, '/api/sim/devices', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(devices, '/api/sim/devices', { method: 'POST', bearer: A, body: {} })).status, 405);
  });

  // ------------------------------------------------------------------ track layouts (api/sim/tracks)

  // The spec's own 564-byte test vector (FORMATO-DE-PISTA.md), with its header changed where a check needs another track.
  const golden = (() => {
    const page = readFileSync(resolve(root, 'docs/telemetria-virtual-2026-11-10/FORMATO-DE-PISTA.md'), 'utf8');
    const hex = /```\r?\n([0-9a-f]+)\r?\n```/.exec(page.slice(page.indexOf('Arquivo completo em hexadecimal')))?.[1];
    assert.ok(hex, 'the golden hex block is in the spec');
    return Buffer.from(hex, 'hex');
  })();
  const goldenHeader = JSON.parse(golden.subarray(12, 12 + golden.readUInt32LE(8)).toString('utf8'));
  /** The golden track, raw (not gzipped), with `track` merged into its header and, if given, one float of the data changed. */
  const rawTrack = (track = {}, { floatAt, value } = {}) => {
    const header = { ...goldenHeader, track: { ...goldenHeader.track, ...track } };
    for (const key of Object.keys(header.track)) if (header.track[key] === undefined) delete header.track[key];
    let text = Buffer.from(JSON.stringify(header), 'utf8');
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, ' ')]);
    const data = Buffer.from(golden.subarray(12 + golden.readUInt32LE(8)));
    if (floatAt !== undefined) data.writeFloatLE(value, floatAt);
    const pre = Buffer.alloc(12);
    golden.copy(pre, 0, 0, 8);
    pre.writeUInt32LE(text.length, 8);
    return Buffer.concat([pre, text, data]);
  };
  const trackBytes = (track, change) => new Uint8Array(gzipSync(rawTrack(track, change)));
  const sendTrack = (key, body, { type = 'application/gzip', ...extra } = {}) =>
    call(tracks, '/api/sim/tracks', { method: 'POST', bearer: key, body, headers: { 'content-type': type }, ...extra });
  const trackRows = async (userId) => (await direct.query('SELECT * FROM public.sim_tracks WHERE user_id = $1 ORDER BY created_at', [userId])).rows;
  await direct.query('DELETE FROM public.sim_tracks');
  // y of the second centre-line point: changes the bytes, not the track's identity.
  const moved = { floatAt: 4 * 4 + 1 * 4, value: 0.5 };
  // One computer sends every layout below (an account may pair ten).
  const rig = await deviceFor(A, 'Tracks');

  await check('a track layout is checked, stored as the same bytes, and listed for its owner', async () => {
    const { token: key, deviceId } = rig;
    const bytes = trackBytes();
    const first = await sendTrack(key, bytes);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(Object.keys(first.body).sort(), ['id', 'replaced']);
    assert.equal(first.body.replaced, false);
    const [row] = await trackRows(ids.A);
    assert.equal(row.id, first.body.id);
    assert.deepEqual([row.device_id, row.track_key, row.game, row.track_name, row.variant, row.title, row.length_m, row.size_bytes, row.sha256],
      [deviceId, 'ac|test track|gp', 'ac', 'Test Track', 'GP', null, 40, bytes.length, sha(Buffer.from(bytes))]);
    assert.ok(row.storage_path.startsWith(`${ids.A}/`) && row.storage_path.endsWith('.xtrk.gz'));
    assert.deepEqual(new Uint8Array(readFileSync(resolve(filesRoot, 'sim-tracks', row.storage_path))), bytes, 'exactly what was sent');

    const listed = await call(tracks, '/api/sim/tracks', { bearer: A });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.tracks.length, 1);
    const [item] = listed.body.tracks;
    assert.deepEqual(Object.keys(item).sort(), ['game', 'id', 'lengthM', 'size', 'title', 'trackName', 'updatedAt', 'variant']);
    assert.deepEqual({ ...item, updatedAt: undefined },
      { id: first.body.id, game: 'ac', trackName: 'Test Track', variant: 'GP', title: null, lengthM: 40, size: bytes.length, updatedAt: undefined });
    assert.equal(new Date(item.updatedAt).toISOString(), item.updatedAt, 'an ISO time');
    assert.equal((await call(tracks, '/api/sim/tracks', { bearer: B })).body.tracks.length, 0, 'B sees none of A\'s');
  });

  await check('the same track sent again replaces the first, whatever the case of its names; another layout is another track', async () => {
    const { token: key } = rig;
    const [before] = await trackRows(ids.A);
    const changed = trackBytes({ name: '  test TRACK ', variant: 'gp', title: 'The Test Track' }, moved);
    const again = await sendTrack(key, changed);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual(again.body, { id: before.id, replaced: true });
    const rows = await trackRows(ids.A);
    assert.equal(rows.length, 1, 'still one row');
    assert.deepEqual([rows[0].track_name, rows[0].variant, rows[0].title, rows[0].sha256, rows[0].storage_path],
      ['  test TRACK ', 'gp', 'The Test Track', sha(Buffer.from(changed)), before.storage_path]);
    assert.ok(new Date(rows[0].updated_at) >= new Date(before.updated_at));
    assert.deepEqual(new Uint8Array(readFileSync(resolve(filesRoot, 'sim-tracks', rows[0].storage_path))), changed, 'the new bytes replace the old');

    const other = await sendTrack(key, trackBytes({ variant: 'Short' }));
    assert.equal(other.status, 201);
    assert.equal(other.body.replaced, false);
    assert.notEqual(other.body.id, before.id);
    const none = await sendTrack(key, trackBytes({ variant: undefined }));
    assert.equal(none.body.replaced, false, 'no layout is a layout of its own');
    assert.equal((await trackRows(ids.A)).length, 3);
    const fromB = await sendTrack((await deviceFor(B, 'B tracks')).token, trackBytes());
    assert.deepEqual([fromB.status, fromB.body.replaced], [201, false], 'the same track on another account is that account\'s own');
  });

  await check('what is not a track layout is refused with the reader\'s code, and nothing is stored for it', async () => {
    const { token: key } = rig;
    const before = (await direct.query('SELECT count(*)::int AS n FROM public.sim_tracks')).rows[0].n;
    const files = readdirSync(resolve(filesRoot, 'sim-tracks', ids.A)).length;
    const bad = Buffer.from(rawTrack());
    bad.write('XTRQ', 0, 'latin1');
    const wrongWidth = rawTrack({}, { floatAt: 4 * 16, value: -1 });
    for (const [body, code] of [
      [new TextEncoder().encode('not gzip at all'), 'bad_gzip'],
      [new Uint8Array(gzipSync(bad)), 'bad_magic'],
      [new Uint8Array(gzipSync(rawTrack().subarray(0, 100))), 'bad_length'],
      [new Uint8Array(gzipSync(wrongWidth)), 'bad_data'],
    ]) {
      const r = await sendTrack(key, body);
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.error, 'bad_track');
      assert.equal(r.body.code, code);
    }
    // A small file that unzips to more than the reader allows is stopped while it is read.
    const bomb = await sendTrack(key, new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1))));
    assert.deepEqual([bomb.status, bomb.body.error], [413, 'too_large']);
    const empty = await sendTrack(key, new Uint8Array(0));
    assert.deepEqual([empty.status, empty.body.error], [400, 'empty_body']);
    const big = await sendTrack(key, new Uint8Array(32 * 1024 * 1024 + 1));
    assert.deepEqual([big.status, big.body.error], [413, 'too_large']);
    assert.equal((await sendTrack(key, trackBytes(), { type: 'application/json' })).status, 415);
    assert.equal((await sendTrack(key, trackBytes(), { type: 'text/plain' })).status, 415);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_tracks')).rows[0].n, before);
    assert.equal(readdirSync(resolve(filesRoot, 'sim-tracks', ids.A)).length, files, 'no file was written');
  });

  await check('sending a track needs a live device key; listing and downloading need the person\'s sign-in', async () => {
    const bytes = trackBytes();
    assert.equal((await sendTrack('', bytes)).status, 401);
    assert.equal((await sendTrack('xpd_unknown', bytes)).status, 401);
    assert.equal((await sendTrack(A, bytes)).status, 401, 'a sign-in token is not a device key');
    const { token: key } = rig;
    assert.equal((await call(tracks, '/api/sim/tracks', { bearer: key })).status, 401, 'a device key cannot read anything');
    assert.equal((await call(tracks, '/api/sim/tracks')).status, 401);
    const [row] = await trackRows(ids.A);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/file`, { bearer: key })).status, 401);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'DELETE', bearer: key })).status, 401);
  });

  await check('an account keeps at most 500 layouts; a track it already has can still be replaced', async () => {
    const { token: key } = rig;
    const have = (await trackRows(ids.A)).length;
    await direct.query(`INSERT INTO public.sim_tracks (user_id, track_key, game, track_name, size_bytes, sha256, storage_path)
      SELECT $1::uuid, 'ac|filler ' || n || '|', 'ac', 'filler ' || n, 1, 'x', $1::text || '/filler' || n FROM generate_series(1, $2::int) AS n`, [ids.A, 500 - have]);
    const refused = await sendTrack(key, trackBytes({ name: 'One Too Many' }));
    assert.deepEqual([refused.status, refused.body.error], [422, 'too_many']);
    const replaced = await sendTrack(key, trackBytes());
    assert.deepEqual([replaced.status, replaced.body.replaced], [201, true]);
    await direct.query("DELETE FROM public.sim_tracks WHERE user_id = $1 AND track_name LIKE 'filler %'", [ids.A]);
  });

  await check('a person downloads their own layout as the stored bytes, and nobody else\'s', async () => {
    const [row] = await trackRows(ids.A);
    const response = await tracks(new Request(`http://x/api/sim/tracks/${row.id}/file`, { headers: { authorization: `Bearer ${A}` } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*');
    const body = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual(body, new Uint8Array(readFileSync(resolve(filesRoot, 'sim-tracks', row.storage_path))));
    assert.equal(sha(Buffer.from(body)), row.sha256);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/file`, { bearer: B })).status, 404, 'another account\'s layout is not found');
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/file`)).status, 401);
    assert.equal((await call(tracks, '/api/sim/tracks/00000000-0000-4000-8000-000000000000/file', { bearer: A })).status, 404);
    assert.equal((await call(tracks, '/api/sim/tracks/not-a-uuid/file', { bearer: A })).status, 404);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/other`, { bearer: A })).status, 404);
  });

  await check('a person deletes their own layout (row and file), and nobody else\'s', async () => {
    const rows = await trackRows(ids.A);
    const row = rows.find((r) => r.variant === 'Short');
    const file = resolve(filesRoot, 'sim-tracks', row.storage_path);
    assert.ok(existsSync(file));
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'DELETE', bearer: B })).status, 404);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'DELETE' })).status, 401);
    const gone = await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'DELETE', bearer: A });
    assert.equal(gone.status, 204);
    assert.equal(gone.body, null, 'no body');
    assert.ok(!existsSync(file), 'the file is gone too');
    assert.equal((await trackRows(ids.A)).length, rows.length - 1);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'DELETE', bearer: A })).status, 404, 'already deleted');
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/file`, { bearer: A })).status, 404);
    assert.ok(!(await call(tracks, '/api/sim/tracks', { bearer: A })).body.tracks.some((t) => t.id === row.id));
  });

  await check('row level security: a person reads their own layouts and cannot write them', async () => {
    const mine = await query(A, { table: 'sim_tracks', action: 'select', select: 'track_key' });
    assert.equal(mine.error, null, JSON.stringify(mine.error));
    assert.ok(mine.data.length >= 1);
    const others = await query(B, { table: 'sim_tracks', action: 'select', select: 'id', filters: [{ column: 'user_id', op: 'eq', value: ids.A }] });
    assert.equal(others.error, null);
    assert.equal(others.data.length, 0);
    const forged = await query(A, { table: 'sim_tracks', action: 'insert', values: { user_id: ids.A, track_key: 'x', game: 'ac', track_name: 'x', size_bytes: 1, sha256: 'x', storage_path: 'x' }, returning: false });
    assert.ok(forged.error, 'a person cannot write layouts themselves');
    const count = (await trackRows(ids.A)).length;
    await query(A, { table: 'sim_tracks', action: 'delete', filters: [{ column: 'user_id', op: 'eq', value: ids.A }], returning: false });
    assert.equal((await trackRows(ids.A)).length, count, 'nor delete them behind the server');
    const nobody = await query(null, { table: 'sim_tracks', action: 'select', select: 'id' });
    assert.ok(nobody.error || nobody.data.length === 0);
  });

  await check('track uploads are limited per device, and the endpoints answer only their methods', async () => {
    const { token: key } = rig;
    let last;
    for (let i = 0; i < 21; i++) last = await sendTrack(key, new TextEncoder().encode('x'));
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.equal((await call(tracks, '/api/sim/tracks', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(tracks, '/api/sim/tracks', { method: 'PUT', bearer: A })).status, 405);
    const [row] = await trackRows(ids.A);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}`, { method: 'GET', bearer: A })).status, 405);
    assert.equal((await call(tracks, `/api/sim/tracks/${row.id}/file`, { method: 'DELETE', bearer: A })).status, 405);
  });

  // ------------------------------------------------------------------ reading laps back (GET/DELETE /api/sim/laps)
  const lapRows = async (userId) => (await direct.query('SELECT * FROM public.sim_laps WHERE user_id = $1 ORDER BY started_at DESC', [userId])).rows;
  await check('laps read: the device upload still works, and a person lists only their own laps, newest first, with the contract fields', async () => {
    await direct.query('DELETE FROM public.sim_laps WHERE user_id IN ($1, $2)', [ids.A, ids.B]);
    await direct.query('DELETE FROM public.sim_devices WHERE user_id IN ($1, $2)', [ids.A, ids.B]);
    const dev = await deviceFor(A, 'READ RIG');
    const devB = await deviceFor(B, 'B RIG');
    const older = await upload(dev.token, await lapBytes(1, { startedAt: '2026-11-01T10:00:00.000Z' }));
    const newer = await upload(dev.token, await lapBytes(2, { startedAt: '2026-11-05T10:00:00.000Z', lap: { number: 2, timeMs: 83456, valid: false } }));
    assert.equal(older.status, 201);
    assert.equal(newer.status, 201);
    assert.equal((await upload(devB.token, await lapBytes(3))).status, 201);

    const listed = await call(laps, '/api/sim/laps', { bearer: A });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.laps.length, 2, 'only A\'s laps');
    assert.deepEqual(listed.body.laps.map((l) => l.id), [newer.body.id, older.body.id], 'newest startedAt first');
    const [first] = listed.body.laps;
    assert.deepEqual(Object.keys(first).sort(), ['car', 'createdAt', 'deviceName', 'game', 'id', 'lapNumber', 'sampleCount', 'sizeBytes', 'startedAt', 'timeMs', 'track', 'valid']);
    assert.equal(first.game, 'lmu');
    assert.equal(first.track, 'Test Track');
    assert.equal(first.car, 'Test Car');
    assert.equal(first.lapNumber, 2);
    assert.equal(first.timeMs, 83456);
    assert.equal(first.valid, false);
    assert.equal(first.startedAt, '2026-11-05T10:00:00.000Z');
    assert.equal(first.sampleCount, 3);
    assert.equal(first.deviceName, 'READ RIG');
    assert.ok(!Number.isNaN(Date.parse(first.createdAt)));
    assert.equal(first.sizeBytes, (await lapRows(ids.A)).find((r) => r.id === newer.body.id).size_bytes);
    assert.equal((await call(laps, '/api/sim/laps', { bearer: B })).body.laps.length, 1);

    // A removed device leaves the lap with no device name.
    await direct.query('DELETE FROM public.sim_devices WHERE id = $1', [(await direct.query('SELECT device_id FROM public.sim_laps WHERE id = $1', [older.body.id])).rows[0].device_id]);
    const after = await call(laps, '/api/sim/laps', { bearer: A });
    assert.deepEqual(after.body.laps.map((l) => l.deviceName), [null, null]);
  });

  await check('laps read: a person downloads their own lap exactly as uploaded, cached for good', async () => {
    const bytes = await lapBytes(11, { startedAt: '2026-11-06T10:00:00.000Z' });
    const sent = await upload((await deviceFor(A, 'FILE RIG')).token, bytes);
    assert.equal(sent.status, 201);
    const response = await laps(new Request(`http://x/api/sim/laps/${sent.body.id}/file`, { headers: { authorization: `Bearer ${A}` } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(bytes), 'the stored bytes, as sent');
  });

  await check('laps read: nobody lists, downloads or deletes another person\'s lap, and sign-in is required', async () => {
    const [mine] = await lapRows(ids.A);
    const file = resolve(filesRoot, 'sim-laps', mine.storage_path);
    assert.equal((await call(laps, '/api/sim/laps')).status, 401);
    assert.equal((await call(laps, '/api/sim/laps', { bearer: 'not-a-token' })).status, 401);
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}/file`)).status, 401);
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}`, { method: 'DELETE' })).status, 401);
    const { token: key } = await deviceFor(A, 'KEY RIG');
    assert.equal((await call(laps, '/api/sim/laps', { bearer: key })).status, 401, 'a device key cannot read');
    assert.ok(!(await call(laps, '/api/sim/laps', { bearer: B })).body.laps.some((l) => l.id === mine.id));
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}/file`, { bearer: B })).status, 404);
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}`, { method: 'DELETE', bearer: B })).status, 404);
    assert.equal((await call(laps, '/api/sim/laps/00000000-0000-4000-8000-000000000000/file', { bearer: A })).status, 404);
    assert.equal((await call(laps, '/api/sim/laps/not-a-uuid/file', { bearer: A })).status, 404);
    assert.equal((await lapRows(ids.A)).some((r) => r.id === mine.id), true, 'B deleted nothing');
    assert.equal(existsSync(file), true);
  });

  await check('laps read: a person deletes their own lap; the row and the stored file are gone', async () => {
    const [mine] = await lapRows(ids.A);
    const file = resolve(filesRoot, 'sim-laps', mine.storage_path);
    assert.equal(existsSync(file), true);
    const gone = await call(laps, `/api/sim/laps/${mine.id}`, { method: 'DELETE', bearer: A });
    assert.equal(gone.status, 204);
    assert.equal((await lapRows(ids.A)).some((r) => r.id === mine.id), false);
    assert.equal(existsSync(file), false);
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}/file`, { bearer: A })).status, 404);
    assert.equal((await call(laps, `/api/sim/laps/${mine.id}`, { method: 'DELETE', bearer: A })).status, 404, 'already deleted');
    assert.ok(!(await call(laps, '/api/sim/laps', { bearer: A })).body.laps.some((l) => l.id === mine.id));
  });

  await check('laps read: the endpoint answers only its methods, with CORS for the browser', async () => {
    const [row] = await lapRows(ids.A);
    assert.equal((await call(laps, '/api/sim/laps', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call(laps, `/api/sim/laps/${row.id}`, { method: 'GET', bearer: A })).status, 405);
    assert.equal((await call(laps, `/api/sim/laps/${row.id}/file`, { method: 'DELETE', bearer: A })).status, 405);
    assert.equal((await call(laps, '/api/sim/laps', { bearer: A, headers: { origin: 'https://xpeed.test' } })).headers.get('access-control-allow-origin'), 'https://xpeed.test');
  });

  // ---- Phase 0 safety: what the real HTTP server does with an upload before it reads the body, CORS, deep health, retry hints.
  webServer = createXpeedServer({ staticRoot: temp, origin: 'https://xpeed.test' });
  const web = webServer;
  await new Promise((done) => web.listen(0, '127.0.0.1', done));
  const webPort = web.address().port;
  const parseJson = (buffer) => { try { return JSON.parse(buffer.toString('utf8')); } catch { return null; } };
  /** Starts an upload that declares `length` bytes and sends only the first 16: the rest is up to the caller. */
  const startUpload = (path, key, length, { type = 'application/gzip' } = {}) => {
    const req = httpRequest({
      host: '127.0.0.1', port: webPort, method: 'POST', path,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': type, 'content-length': String(length) },
    });
    const response = new Promise((done, fail) => {
      req.on('response', (res) => {
        const parts = [];
        res.on('data', (part) => parts.push(part));
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: parseJson(Buffer.concat(parts)) }));
        res.on('error', fail);
      });
      req.on('error', fail);
    });
    req.write(Buffer.alloc(16));
    return { req, response };
  };
  /** The answer, or a failure when it takes longer than `ms`: a server that waited for the body would not answer in time. */
  const within = (promise, ms = 3000) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error(`no answer within ${ms} ms`)), ms))]);
  const get = async (path, init) => {
    const r = await fetch(`http://127.0.0.1:${webPort}${path}`, init);
    return { status: r.status, headers: r.headers, body: parseJson(Buffer.from(await r.arrayBuffer())) };
  };
  const postLap = async (key, bytes) => {
    const r = await fetch(`http://127.0.0.1:${webPort}/api/sim/laps`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' }, body: bytes });
    return { status: r.status, headers: r.headers, body: parseJson(Buffer.from(await r.arrayBuffer())) };
  };

  await check('an upload without a key is refused before the body is read', async () => {
    // 20 MB are declared and 16 bytes sent: a server that waited for the body would hang until its timeout.
    for (const path of ['/api/sim/laps', '/api/sim/tracks']) {
      const started = Date.now();
      const r = await within(startUpload(path, '', 20 * 1024 * 1024).response);
      assert.equal(r.status, 401, path);
      assert.deepEqual(r.body, { error: 'unauthorized', retryable: false });
      assert.ok(Date.now() - started < 2000, `${path} was refused fast`);
    }
    // A key that is not a device key is refused the same way, and so is a person's own sign-in token.
    for (const key of ['xpd_not_a_device', A]) {
      const r = await within(startUpload('/api/sim/laps', key, 20 * 1024 * 1024).response);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'unauthorized');
    }
    assert.equal(uploadsInFlight(), 0, 'a refusal takes no place');
  });

  await check('an oversized content-length gets 413 before the body is read', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    const { token: key } = await deviceFor(B);
    for (const [path, length] of [['/api/sim/laps', 16 * 1024 * 1024 + 1], ['/api/sim/laps', 40 * 1024 * 1024], ['/api/sim/tracks', 32 * 1024 * 1024 + 1]]) {
      const started = Date.now();
      const r = await within(startUpload(path, key, length).response);
      assert.equal(r.status, 413, `${path} ${length}`);
      assert.deepEqual(r.body, { error: 'too_large', retryable: false });
      assert.ok(Date.now() - started < 2000);
    }
    assert.equal(uploadsInFlight(), 0);
    // The limit itself is fine: a real lap of a normal size goes through the same door.
    assert.equal((await postLap(key, await lapBytes(70))).status, 201);
  });

  await check('at most 4 uploads are read at once: the fifth gets 503 busy with Retry-After, and works when the others finish', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    const { token: key } = await deviceFor(B);
    const held = Array.from({ length: 4 }, () => startUpload('/api/sim/laps', key, 1000));
    for (let i = 0; i < 100 && uploadsInFlight() < 4; i++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(uploadsInFlight(), 4, 'four places are taken');
    const fifth = await within(postLap(key, await lapBytes(71)));
    assert.equal(fifth.status, 503);
    assert.deepEqual(fifth.body, { error: 'busy', retryable: true });
    assert.equal(fifth.headers.get('retry-after'), '5');
    // A track upload shares the same four places; a stranger cannot take one, and is not told "busy".
    assert.equal((await within(startUpload('/api/sim/tracks', key, 1000).response)).status, 503);
    assert.equal((await within(startUpload('/api/sim/laps', 'xpd_stranger', 1000).response)).status, 401);
    // The others finish (garbage, so each is refused as not a lap file), the places come back and the fifth works.
    for (const { req } of held) req.end(Buffer.alloc(984));
    const answers = await within(Promise.all(held.map((h) => h.response)), 10_000);
    for (const r of answers) { assert.equal(r.status, 422); assert.equal(r.body.retryable, false); }
    assert.equal(uploadsInFlight(), 0, 'every place is free again');
    const retried = await postLap(key, await lapBytes(71));
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('a failed upload says whether it can be retried, and a handler called on its own still asks who the key belongs to', async () => {
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
    const { token: key } = await deviceFor(B);
    const refused = await postLap(key, new TextEncoder().encode('definitely not a lap'));
    assert.equal(refused.status, 422);
    assert.equal(refused.body.retryable, false);
    assert.match(refused.body.error, /not a valid lap file/, 'the error codes are as they were');
    const empty = await fetch(`http://127.0.0.1:${webPort}/api/sim/laps`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' } });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).retryable, false);
    const track = await fetch(`http://127.0.0.1:${webPort}/api/sim/tracks`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(track.status, 415);
    assert.deepEqual(await track.json(), { error: 'unsupported_media_type', retryable: false });
    const bad = await fetch(`http://127.0.0.1:${webPort}/api/sim/tracks`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' }, body: gzipSync('not a track') });
    assert.equal(bad.status, 422);
    const badBody = await bad.json();
    assert.equal(badBody.error, 'bad_track');
    assert.equal(badBody.retryable, false);
    // Rate limited: retryable, with Retry-After.
    let limited;
    for (let i = 0; i < 61; i++) limited = await postLap(key, new TextEncoder().encode('x'));
    assert.equal(limited.status, 429);
    assert.equal(limited.body.retryable, true);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    // Called on its own, without the server in front, the handler still asks who the key belongs to.
    forgetLimits();
    await resetRates();
    assert.equal((await upload('xpd_unknown', await lapBytes(72))).status, 401);
    assert.equal((await upload(key, await lapBytes(72))).status, 201);
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  await check('CORS: the allow-origin header is never *, an allowed origin is echoed, an unknown one gets none, and answers vary by Origin', async () => {
    const handlers = [['codes', codes, '/api/sim/codes', 'POST'], ['devices', devices, '/api/sim/devices', 'GET'], ['laps', laps, '/api/sim/laps', 'GET'],
      ['tracks', tracks, '/api/sim/tracks', 'GET'], ['link', link, '/api/sim/link', 'POST'], ['games', games, '/api/sim/games', 'GET']];
    for (const [name, handler, path, method] of handlers) {
      for (const verb of ['OPTIONS', method]) {
        const own = await call(handler, path, { method: verb, headers: { origin: 'https://xpeed.test' } });
        assert.equal(own.headers.get('access-control-allow-origin'), 'https://xpeed.test', `${name} ${verb} echoes the app's origin`);
        assert.match(own.headers.get('vary') ?? '', /origin/i, `${name} ${verb} varies by Origin`);
        const local = await call(handler, path, { method: verb, headers: { origin: 'http://localhost:5173' } });
        assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173', `${name} ${verb} lets local development in`);
        for (const origin of ['https://evil.example', 'https://xpeed.test.evil.example', 'null', undefined]) {
          const other = await call(handler, path, { method: verb, headers: origin ? { origin } : {} });
          assert.equal(other.headers.get('access-control-allow-origin'), null, `${name} ${verb} ${origin}`);
          assert.match(other.headers.get('vary') ?? '', /origin/i);
        }
      }
    }
    // Nothing answers * anywhere, whatever the outcome (an error, a success, a download).
    const [lap] = (await call(laps, '/api/sim/laps', { bearer: A })).body.laps;
    assert.ok(lap, 'the account has a lap to download');
    const outcomes = [
      await call(laps, '/api/sim/laps', { headers: { origin: 'https://xpeed.test' } }),
      await call(laps, `/api/sim/laps/${lap.id}/file`, { bearer: A, headers: { origin: 'https://xpeed.test' } }),
      await call(laps, `/api/sim/laps/${lap.id}`, { method: 'PUT', bearer: A, headers: { origin: 'https://evil.example' } }),
    ];
    for (const r of outcomes) assert.notEqual(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(outcomes[1].headers.get('access-control-allow-origin'), 'https://xpeed.test');
  });

  await check('GET /api/health/deep is 200 when the database and the storage answer, and 503 when either fails', async () => {
    const storageDir = process.env.STORAGE_DIR, databaseUrl = process.env.DATABASE_URL;
    try {
      forgetDeepHealth();
      const fine = await get('/api/health/deep');
      assert.equal(fine.status, 200);
      assert.deepEqual(fine.body, { ok: true, version: process.env.SOURCE_COMMIT ?? 'local' });
      assert.equal(fine.headers.get('cache-control'), 'no-store');
      assert.equal((await get('/api/health/deep', { method: 'POST' })).status, 405);

      // The storage cannot be written: its folder is a place under a plain file.
      const { writeFileSync } = await import('node:fs');
      const blocker = resolve(temp, 'not-a-folder');
      writeFileSync(blocker, 'x');
      process.env.STORAGE_DIR = resolve(blocker, 'files');
      forgetDeepHealth();
      const noStorage = await get('/api/health/deep');
      assert.equal(noStorage.status, 503);
      assert.deepEqual(noStorage.body, { ok: false, database: 'ok', storage: 'down' });
      assert.equal((await get('/api/health')).status, 200, 'the plain health check never fails on a blip');
      process.env.STORAGE_DIR = storageDir;

      // The database does not answer: a pool pointed at a port nobody listens on.
      process.env.DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:1/postgres';
      await closePool();
      forgetDeepHealth();
      const noDatabase = await get('/api/health/deep');
      assert.equal(noDatabase.status, 503);
      assert.deepEqual(noDatabase.body, { ok: false, database: 'down', storage: 'ok' });
      const plain = await get('/api/health');
      assert.equal(plain.status, 200, 'the plain health check still answers 200 and reports the database as down');
      assert.equal(plain.body.database, 'down');
    } finally {
      process.env.STORAGE_DIR = storageDir;
      process.env.DATABASE_URL = databaseUrl;
      await closePool();
      forgetDeepHealth();
    }
    const back = await get('/api/health/deep');
    assert.equal(back.status, 200, JSON.stringify(back.body));
  });

  await check('every 429 and 503 from api/sim carries Retry-After', async () => {
    assert.equal(sharedReply({}, 503).headers.get('retry-after'), '10');
    assert.equal(sharedReply({}, 429).headers.get('retry-after'), '60');
    assert.equal(sharedReply({}, 503, { 'Retry-After': '5' }).headers.get('retry-after'), '5', 'one that was given stays');
    assert.equal(sharedReply({}, 429, { 'retry-after': '7' }).headers.get('retry-after'), '7');
    assert.equal(sharedReply({}, 200).headers.get('retry-after'), null);
    // The handlers' own "unavailable": the backend is not configured.
    const backend = process.env.DATA_BACKEND;
    delete process.env.DATA_BACKEND;
    try {
      const refusals = [
        await call(codes, '/api/sim/codes', { method: 'POST', bearer: A }), await call(devices, '/api/sim/devices', { bearer: A }),
        await call(laps, '/api/sim/laps', { bearer: A }), await upload('xpd_x', new Uint8Array(1)), await call(tracks, '/api/sim/tracks', { bearer: A }),
        await call(tracks, '/api/sim/tracks', { method: 'POST', bearer: 'xpd_x', body: new Uint8Array(1), headers: { 'content-type': 'application/gzip' } }),
        await call(link, '/api/sim/link', { method: 'POST', body: { device: { name: 'x' }, tokenHash: sha(newKey()) } }),
        await call(link, '/api/sim/link/00000000-0000-4000-8000-000000000000', { bearer: A }),
        await call(me, '/api/sim/me', { bearer: 'xpd_x' }), await pairWith('ABCD2345'), await call(games, '/api/sim/games'),
      ];
      for (const r of refusals) {
        assert.equal(r.status, 503);
        assert.ok(Number(r.headers.get('retry-after')) >= 1, 'a 503 says when to come back');
      }
    } finally {
      process.env.DATA_BACKEND = backend;
    }
    // The 429s of the handlers (codes per hour, pairing guesses, uploads) say it too: see the checks above that read Retry-After.
    let last;
    for (let i = 0; i < 11; i++) last = await pairWith('ABCD2345', 'RIG', '10.5.5.5');
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
  });

  // The real Xpeed Sim against these handlers, when its program is given (XPEED_SIM_EXE=...\xpeed-sim.exe): it pairs,
  // then `upload` sends a lap and the layouts of its `tracks` outbox, once.
  if (process.env.XPEED_SIM_EXE) await check('Xpeed Sim itself pairs and sends a lap and a track layout, each once', async () => {
    const { createServer } = await import('node:http');
    const { execFile } = await import('node:child_process');
    const web = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const path = req.url.split('?')[0];
      const handler = path === '/api/sim/pair' ? pair : path === '/api/sim/laps' ? laps : path.startsWith('/api/sim/tracks') ? tracks : null;
      if (!handler) { res.writeHead(404).end('{"error":"not_found"}'); return; }
      const headers = { ...req.headers, 'x-real-ip': '10.7.7.7' };
      const response = await handler(new Request(`http://x${req.url}`, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise((done) => web.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${web.address().port}`;
    const home = mkdtempSync(resolve(temp, 'sim-home-'));
    const lapsDir = mkdtempSync(resolve(temp, 'sim-laps-'));
    const run = (...args) => new Promise((done, fail) => execFile(process.env.XPEED_SIM_EXE, args, { env: { ...process.env, XPEED_SIM_HOME: home } },
      (error, stdout, stderr) => (error ? fail(new Error(`${args[0]}: ${error.message}\n${stdout}\n${stderr}`)) : done(stdout))));
    try {
      await direct.query('DELETE FROM public.sim_devices WHERE user_id = $1', [ids.B]);
      await run('pair', '--server', base, '--code', await newCode(B), '--name', 'E2E');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(resolve(lapsDir, 'e2e.xlap.gz'), await lapBytes(42));
      mkdirSync(resolve(lapsDir, 'tracks'));
      const layout = trackBytes({ name: 'E2E Ring', variant: undefined });
      writeFileSync(resolve(lapsDir, 'tracks', 'ac_e2e-ring_00000000.xtrk.gz'), layout);
      const said = await run('upload', lapsDir);
      assert.match(said, /Track layouts: sent 1/, said);
      const [row] = (await direct.query("SELECT * FROM public.sim_tracks WHERE user_id = $1 AND track_key = 'ac|e2e ring|'", [ids.B])).rows;
      assert.ok(row, 'the layout is on the server');
      assert.deepEqual(new Uint8Array(readFileSync(resolve(filesRoot, 'sim-tracks', row.storage_path))), layout);
      assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1 AND lap_number = 42', [ids.B])).rows[0].n, 1);
      const again = await run('upload', lapsDir);
      assert.doesNotMatch(again, /Track layouts: sent 1/, 'sent once');
      assert.equal((await direct.query('SELECT updated_at FROM public.sim_tracks WHERE id = $1', [row.id])).rows[0].updated_at.getTime(), row.updated_at.getTime());
    } finally {
      await new Promise((done) => web.close(done));
    }
  });

  console.log(`${checks.length} sim checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await new Promise((done) => (webServer ? (webServer.closeAllConnections?.(), webServer.close(done)) : done())).catch(() => {});
  await direct.end().catch(() => {});
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
