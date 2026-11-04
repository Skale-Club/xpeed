// The /api/db route against the real migrated schema and its row level security, on real
// PostgreSQL/WASM. No .env, network or remote credentials.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-api-'));
await build({
  entryPoints: { query: 'server/db-query.ts', route: 'server/db-route.ts', account: 'server/account-route.ts', storage: 'server/storage-route.ts', files: 'server/files.ts' },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose'], absWorkingDir: root, logLevel: 'error',
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const { createDbRoute } = await load('route.mjs');
const { createAccountRoute } = await load('account.mjs');
const { forgetSchema } = await load('query.mjs');
const { createStorageRoute } = await load('storage.mjs');
const { DiskStore, signLink } = await load('files.mjs');

const checks = [];
const check = async (name, test) => { await test(); checks.push(name); };
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 54430, host: '127.0.0.1' });
await server.start();
const url = 'postgres://postgres:postgres@127.0.0.1:54430/postgres';

try {
  const setup = new pg.Client({ connectionString: url });
  await setup.connect();
  await migrate(setup);
  await ensureIdentityProject(setup, 'skaleclub');
  await setup.end();
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  forgetSchema(pool);

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] });
  const token = (sub, extra = {}) => new SignJWT({ firebase: { sign_in_provider: 'phone' }, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/skaleclub').setAudience('skaleclub')
    .setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const identity = { projectId: 'skaleclub', keys, pool };
  const route = createDbRoute(identity);
  const accounts = createAccountRoute(identity);

  const A = await token('uid-a', { phone_number: '+15550000001' });
  const B = await token('uid-b', { phone_number: '+15550000002' });
  for (const t of [A, B]) {
    const r = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${t}` } }));
    assert.equal(r.status, 200);
  }
  const send = async (bearer, body, init = {}) => {
    const response = await route(new Request('http://x/api/db', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body), ...init,
    }));
    return { status: response.status, ...(await response.json()) };
  };
  const query = (bearer, body) => send(bearer, { kind: 'query', ...body });
  const ok = (result) => { assert.equal(result.status, 200); assert.equal(result.error, null, JSON.stringify(result.error)); return result; };

  // Fixtures through the API itself, as the app would do them.
  const car = async (bearer, name, extra = {}) =>
    ok(await query(bearer, { table: 'car_profiles', action: 'insert', values: { name, ...extra }, returning: true, select: 'id, name, user_id', shape: 'single' })).data;
  const carA1 = await car(A, 'Alpha');
  const carA2 = await car(A, 'Bravo');
  const carA3 = await car(A, 'Charlie');
  const carB = await car(B, 'Bravo');

  await check('insert returns the new row and the database assigns the owner', async () => {
    assert.equal(carA1.name, 'Alpha');
    assert.match(carA1.user_id, /^[0-9a-f-]{36}$/);
    assert.notEqual(carA1.user_id, carB.user_id);
  });
  await check('row level security: each person only sees and changes their own rows', async () => {
    const mine = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id, name', order: [{ column: 'name' }] })).data;
    assert.deepEqual(mine.map((r) => r.name), ['Alpha', 'Bravo', 'Charlie']);
    const theirs = ok(await query(B, { table: 'car_profiles', action: 'select', select: 'id' })).data;
    assert.deepEqual(theirs.map((r) => r.id), [carB.id]);
    // B tries to rename and delete A's car: no error, nothing changes.
    ok(await query(B, { table: 'car_profiles', action: 'update', values: { name: 'Hacked' }, filters: [{ column: 'id', op: 'eq', value: carA1.id }] }));
    ok(await query(B, { table: 'car_profiles', action: 'delete', filters: [{ column: 'id', op: 'eq', value: carA1.id }] }));
    assert.equal(ok(await query(A, { table: 'car_profiles', action: 'select', select: 'name', filters: [{ column: 'id', op: 'eq', value: carA1.id }], shape: 'single' })).data.name, 'Alpha');
    // Nobody signed in sees nothing.
    assert.deepEqual(ok(await query(null, { table: 'car_profiles', action: 'select', select: 'id' })).data, []);
  });
  await check('filters, ordering, windows and counts behave like PostgREST', async () => {
    const names = async (body) => ok(await query(A, { table: 'car_profiles', action: 'select', select: 'name', ...body })).data.map((r) => r.name);
    assert.deepEqual(await names({ filters: [{ column: 'name', op: 'in', value: [carA1.name, 'Charlie'] }], order: [{ column: 'name', ascending: false }] }), ['Charlie', 'Alpha']);
    assert.deepEqual(await names({ filters: [{ column: 'name', op: 'neq', value: 'Alpha' }], order: [{ column: 'name' }] }), ['Bravo', 'Charlie']);
    assert.deepEqual(await names({ filters: [{ column: 'name', op: 'like', value: 'B%' }] }), ['Bravo']);
    assert.deepEqual(await names({ filters: [{ column: 'name', op: 'ilike', value: 'c%' }] }), ['Charlie']);
    assert.deepEqual(await names({ filters: [{ column: 'notes', op: 'is', value: null }], order: [{ column: 'name' }], limit: 1, offset: 1 }), ['Bravo']);
    assert.deepEqual(await names({ filters: [{ column: 'id', op: 'in', value: [carA1.id, carA3.id] }], order: [{ column: 'name' }] }), ['Alpha', 'Charlie']);
    assert.deepEqual(await names({ filters: [{ column: 'id', op: 'in', value: [] }] }), []);
    const counted = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id', count: true, head: true }));
    assert.equal(counted.count, 3);
    assert.deepEqual(counted.data, []);
  });
  await check('the cursor expression the trip list uses (or with and) pages correctly', async () => {
    const [first] = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id, name, created_at', order: [{ column: 'name' }], limit: 1 })).data;
    const after = ok(await query(A, {
      table: 'car_profiles', action: 'select', select: 'name', order: [{ column: 'name' }],
      or: [`name.gt.${first.name},and(name.eq.${first.name},id.gt.${first.id})`],
    })).data.map((r) => r.name);
    assert.deepEqual(after, ['Bravo', 'Charlie']);
  });
  await check('single and maybeSingle report PGRST116 the way the app expects', async () => {
    const none = await query(A, { table: 'car_profiles', action: 'select', select: 'id', filters: [{ column: 'name', op: 'eq', value: 'Nope' }], shape: 'single' });
    assert.equal(none.error.code, 'PGRST116');
    assert.equal(none.data, null);
    const maybe = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id', filters: [{ column: 'name', op: 'eq', value: 'Nope' }], shape: 'maybe' }));
    assert.equal(maybe.data, null);
    const many = await query(A, { table: 'car_profiles', action: 'select', select: 'id', shape: 'maybe' });
    assert.equal(many.error.code, 'PGRST116');
  });
  await check('embedded relations work both ways (chat conversation <-> messages)', async () => {
    const conversation = ok(await query(A, { table: 'chat_conversations', action: 'insert', values: { title: 'Hello', car_profile_id: carA1.id }, returning: true, select: 'id', shape: 'single' })).data;
    ok(await query(A, { table: 'chat_messages', action: 'insert', values: [{ conversation_id: conversation.id, role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { conversation_id: conversation.id, role: 'assistant', parts: [] }] }));
    const message = ok(await query(A, { table: 'chat_messages', action: 'select', select: '*, chat_conversations(title)', filters: [{ column: 'role', op: 'eq', value: 'user' }], shape: 'single' })).data;
    assert.deepEqual(message.chat_conversations, { title: 'Hello' });
    assert.deepEqual(message.parts, [{ type: 'text', text: 'hi' }]);
    const parent = ok(await query(A, { table: 'chat_conversations', action: 'select', select: 'title, chat_messages(role)', shape: 'single' })).data;
    assert.deepEqual(parent.chat_messages.map((m) => m.role).sort(), ['assistant', 'user']);
    assert.equal(ok(await query(B, { table: 'chat_messages', action: 'select', select: 'id' })).data.length, 0);
  });
  await check('upsert updates on conflict, duplicates report the unique-violation code, update/delete need a filter', async () => {
    ok(await query(A, { table: 'car_profiles', action: 'upsert', values: { id: carA2.id, name: 'Bravo 2' }, onConflict: 'id' }));
    assert.equal(ok(await query(A, { table: 'car_profiles', action: 'select', select: 'name', filters: [{ column: 'id', op: 'eq', value: carA2.id }], shape: 'single' })).data.name, 'Bravo 2');
    // An update that hands the row back (the handlers rely on this for optimistic saves).
    const renamed = ok(await query(A, { table: 'car_profiles', action: 'update', values: { name: 'Bravo 3' }, filters: [{ column: 'id', op: 'eq', value: carA2.id }], returning: true, select: 'id, name, created_at', shape: 'single' }));
    assert.equal(renamed.data.name, 'Bravo 3');
    assert.ok(renamed.data.created_at);
    const duplicate = await query(A, { table: 'car_profiles', action: 'insert', values: { id: carA2.id, name: 'again' } });
    assert.equal(duplicate.error.code, '23505');
    assert.match((await query(A, { table: 'car_profiles', action: 'update', values: { name: 'x' } })).error.message, /needs a filter/);
    assert.match((await query(A, { table: 'car_profiles', action: 'delete' })).error.message, /needs a filter/);
    const removed = ok(await query(A, { table: 'car_profiles', action: 'delete', filters: [{ column: 'id', op: 'eq', value: carA3.id }], returning: true, select: 'name' }));
    assert.deepEqual(removed.data, [{ name: 'Charlie' }]);
  });
  await check('a failing single() undoes the write that came with it', async () => {
    const result = await query(A, { table: 'car_profiles', action: 'update', values: { name: 'Everyone' }, filters: [{ column: 'user_id', op: 'is', value: false }], returning: true, shape: 'single' });
    assert.ok(result.error);
    const names = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'name', order: [{ column: 'name' }] })).data.map((r) => r.name);
    assert.ok(!names.includes('Everyone'));
  });
  await check('functions are called by name with named arguments, as the signed-in person', async () => {
    const rpc = (bearer, name, args) => send(bearer, { kind: 'rpc', name, args });
    const me = ok(await rpc(A, 'current_app_user_id')).data;
    assert.equal(me, carA1.user_id);
    const register = ok(await rpc(A, 'register_google_user')).data;
    assert.equal(register.id, me);
    ok(await rpc(A, 'update_account_name', { p_name: 'Ana Test' }));
    assert.equal(ok(await rpc(A, 'register_google_user')).data.user_metadata.full_name, 'Ana Test');
    assert.equal(ok(await rpc(A, 'is_admin_user')).data, false);
    assert.equal(ok(await rpc(null, 'current_app_user_id')).data, null);
    assert.equal((await rpc(A, 'no_such_function')).error.code, 'PGRST202');
    assert.ok((await rpc(null, 'update_account_name', { p_name: 'Anon' })).error, 'anonymous callers cannot rename accounts');
  });
  await check('nothing the caller sends can become SQL or reach internal tables', async () => {
    const attempts = [
      { table: 'car_profiles"; DROP TABLE car_profiles; --', action: 'select' },
      { table: 'xpeed_schema_migrations', action: 'select' },
      { table: 'google_auth_identities', action: 'select', select: 'subject' },
      { table: 'car_profiles', action: 'select', select: 'name"; DROP TABLE car_profiles; --' },
      { table: 'car_profiles', action: 'select', select: 'id', filters: [{ column: 'name) OR (1=1', op: 'eq', value: 'x' }] },
      { table: 'car_profiles', action: 'select', select: 'id', order: [{ column: 'name; DROP TABLE car_profiles' }] },
      { table: 'car_profiles', action: 'insert', values: { 'name") VALUES (1); --': 'x' } },
    ];
    for (const attempt of attempts) {
      const result = await query(A, attempt);
      assert.ok(result.error, JSON.stringify(attempt));
      assert.notEqual(result.data?.length > 0, true, JSON.stringify(attempt));
    }
    // A hostile value is just a value.
    const hostile = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id', filters: [{ column: 'name', op: 'eq', value: "x' OR '1'='1" }] }));
    assert.deepEqual(hostile.data, []);
    // The same inside an or() expression: still only a value.
    const hostileOr = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id', or: ['name.eq.x) OR (1=1'] }));
    assert.deepEqual(hostileOr.data, []);
    const stillThere = ok(await query(A, { table: 'car_profiles', action: 'select', select: 'id' }));
    assert.ok(stillThere.data.length >= 2);
  });
  await check('tokens: a bad one is refused (not downgraded to anonymous); the wrong method and bad bodies are rejected', async () => {
    assert.equal((await query('garbage', { table: 'car_profiles', action: 'select' })).status, 401);
    const wrongMethod = await route(new Request('http://x/api/db', { method: 'GET' }));
    assert.equal(wrongMethod.status, 405);
    assert.equal((await send(A, { kind: 'nonsense' })).status, 400);
    assert.equal((await send(A, { kind: 'query', table: 'car_profiles', action: 'drop' })).status, 400);
    const notJson = await route(new Request('http://x/api/db', { method: 'POST', body: 'not json', headers: { authorization: `Bearer ${A}` } }));
    assert.equal(notJson.status, 400);
  });
  await check('CORS: the Capacitor app origin and localhost dev are allowed, other sites are not', async () => {
    const preflight = (origin) => route(new Request('http://x/api/db', { method: 'OPTIONS', headers: { origin } }));
    assert.equal((await preflight('https://localhost')).headers.get('access-control-allow-origin'), 'https://localhost');
    assert.equal((await preflight('http://localhost:8080')).headers.get('access-control-allow-origin'), 'http://localhost:8080');
    assert.equal((await preflight('https://evil.example')).headers.get('access-control-allow-origin'), null);
  });

  // ---------------------------------------------------------------- files
  const filesRoot = mkdtempSync(resolve(temp, 'files-'));
  const store = new DiskStore(filesRoot);
  const SECRET = 'test-storage-secret';
  const storage = createStorageRoute({ ...identity, store, secret: SECRET });
  const meId = async (bearer) => (await send(bearer, { kind: 'rpc', name: 'current_app_user_id' })).data;
  const idA = await meId(A), idB = await meId(B);
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const call = (method, path, { bearer, body, type, headers = {} } = {}) => storage(new Request(`http://x${path}`, {
    method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(type ? { 'content-type': type } : {}), ...headers }, body,
  }));
  const object = (bucket, path) => `/api/storage/object/${bucket}/${path}`;
  const upload = (bearer, bucket, path, body = JPEG, type = 'image/jpeg', query = '') => call('PUT', object(bucket, path) + query, { bearer, body, type });
  const code = async (response) => (await response.json()).error?.code;

  await check('files: people write only into their own folder, and only the buckets meant for browsers', async () => {
    assert.equal((await upload(A, 'car-photos', `${idA}/car.jpg`)).status, 200);
    assert.equal(await code(await upload(B, 'car-photos', `${idA}/intruder.jpg`)), 'forbidden');
    assert.equal(await code(await upload(A, 'car-photos', `${idB}/x.jpg`)), 'forbidden');
    assert.equal(await code(await upload(A, 'car-photos', 'loose.jpg')), 'forbidden');
    assert.equal(await code(await upload(A, 'trip-checkpoints', `${idA}/x.json`, new Uint8Array([123, 125]), 'application/json')), 'forbidden');
    assert.equal((await upload(null, 'car-photos', `${idA}/anon.jpg`)).status, 401);
    assert.equal((await upload('garbage', 'car-photos', `${idA}/bad.jpg`)).status, 401);
    assert.equal(await code(await upload(A, 'no-such-bucket', `${idA}/x.jpg`)), 'bucket_not_found');
    assert.deepEqual(readdirSync(resolve(filesRoot, 'car-photos', idA)).sort(), ['car.jpg']);
  });
  await check('files: type and size limits, empty files, and no silent overwrite', async () => {
    assert.equal(await code(await upload(A, 'car-photos', `${idA}/a.html`, new Uint8Array([60, 104]), 'text/html')), 'invalid_mime_type');
    assert.equal(await code(await upload(A, 'car-photos', `${idA}/big.jpg`, new Uint8Array(5 * 1024 * 1024 + 1))), 'too_large');
    assert.equal(await code(await upload(A, 'car-photos', `${idA}/empty.jpg`, new Uint8Array(0))), 'empty_file');
    assert.equal(await code(await upload(A, 'car-photos', `${idA}/car.jpg`)), 'already_exists');
    const next = new Uint8Array([0xff, 0xd8, 9, 9]);
    assert.equal((await upload(A, 'car-photos', `${idA}/car.jpg`, next, 'image/jpeg', '?upsert=true')).status, 200);
    assert.deepEqual(new Uint8Array(await (await call('GET', object('car-photos', `${idA}/car.jpg`), { bearer: A })).arrayBuffer()), next);
  });
  await check('files: path tricks never leave the bucket folder', async () => {
    const tricks = [`${idA}/../${idB}/x.jpg`, `${idA}/%2e%2e/${idB}/x.jpg`, `${idA}%2f..%2f..%2fx.jpg`, `${idA}/..%5c..%5cx.jpg`, `${idA}//x.jpg`, `/etc/passwd`, `${idA}/x%00.jpg`];
    for (const path of tricks) {
      const response = await upload(A, 'car-photos', path);
      assert.ok([400, 403, 404].includes(response.status), `${path} -> ${response.status}`);
    }
    // Nothing was written anywhere but the one legitimate file.
    const everything = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(resolve(dir, entry.name)); else everything.push(resolve(dir, entry.name).slice(filesRoot.length).split('\\').join('/'));
      }
    };
    walk(filesRoot);
    assert.deepEqual(everything, [`/car-photos/${idA}/car.jpg`]);
  });
  await check('files: downloads need the owner or a valid link, and are served as inert data', async () => {
    const mine = await call('GET', object('car-photos', `${idA}/car.jpg`), { bearer: A });
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('content-type'), 'image/jpeg');
    assert.equal(mine.headers.get('x-content-type-options'), 'nosniff');
    assert.match(mine.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await call('GET', object('car-photos', `${idA}/car.jpg`), { bearer: B })).status, 403);
    assert.equal((await call('GET', object('car-photos', `${idA}/car.jpg`))).status, 401);
    assert.equal((await call('GET', object('car-photos', `${idA}/missing.jpg`), { bearer: A })).status, 404);
    assert.equal((await call('GET', object('trip-checkpoints', `${idA}/x.json`), { bearer: A })).status, 403);
  });
  await check('files: signed links open for whoever holds them until they expire, and only for that file', async () => {
    const sign = (bearer, bucket, path, expiresIn) => call('POST', '/api/storage/sign', { bearer, body: JSON.stringify({ bucket, path, expiresIn }), type: 'application/json' });
    const signed = await (await sign(A, 'car-photos', `${idA}/car.jpg`, 600)).json();
    const link = signed.data.signedPath;
    assert.equal((await call('GET', link)).status, 200);
    assert.equal((await call('HEAD', link)).status, 200);
    assert.equal((await sign(B, 'car-photos', `${idA}/car.jpg`, 600)).status, 403);
    assert.equal((await sign(A, 'car-photos', `${idA}/nope.jpg`, 600)).status, 404);
    const token = new URL(`http://x${link}`).searchParams.get('token');
    const tampered = token.slice(0, -3) + (token.endsWith('AAA') ? 'BBB' : 'AAA');
    assert.equal((await call('GET', object('car-photos', `${idA}/car.jpg`) + `?token=${tampered}`)).status, 403);
    assert.equal((await call('GET', object('car-photos', `${idB}/other.jpg`) + `?token=${token}`)).status, 403);
    const expired = signLink(SECRET, { bucket: 'car-photos', path: `${idA}/car.jpg`, expires: Date.now() - 1000 });
    assert.equal((await call('GET', object('car-photos', `${idA}/car.jpg`) + `?token=${expired}`)).status, 403);
    const forged = signLink('some-other-secret', { bucket: 'car-photos', path: `${idA}/car.jpg`, expires: Date.now() + 60000 });
    assert.equal((await call('GET', object('car-photos', `${idA}/car.jpg`) + `?token=${forged}`)).status, 403);
    const unsigned = createStorageRoute({ ...identity, store, secret: '' });
    const noSecret = await unsigned(new Request('http://x/api/storage/sign', {
      method: 'POST', headers: { authorization: `Bearer ${A}`, 'content-type': 'application/json' }, body: JSON.stringify({ bucket: 'car-photos', path: `${idA}/car.jpg` }),
    }));
    assert.equal(noSecret.status, 503);
  });
  await check('files: ranges for video seeking, removal, and public assets', async () => {
    await store.put('session-photos', `${idA}/trip/clip.mp4`, new Uint8Array(100).map((_, i) => i), { upsert: false });
    const part = await call('GET', object('session-photos', `${idA}/trip/clip.mp4`), { bearer: A, headers: { range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/100');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    assert.equal((await call('GET', object('session-photos', `${idA}/trip/clip.mp4`), { bearer: A, headers: { range: 'bytes=500-' } })).status, 416);
    const remove = (bearer, bucket, paths) => call('POST', '/api/storage/remove', { bearer, body: JSON.stringify({ bucket, paths }), type: 'application/json' });
    assert.equal((await remove(B, 'car-photos', [`${idA}/car.jpg`])).status, 403);
    assert.equal((await remove(A, 'car-photos', [`${idA}/car.jpg`, `${idA}/never-existed.jpg`])).status, 200);
    assert.equal(await store.get('car-photos', `${idA}/car.jpg`), null);
    await store.put('brand-assets', 'logo.png', JPEG, { upsert: true });
    assert.equal((await call('GET', object('brand-assets', 'logo.png'))).status, 200);
    assert.equal(await code(await upload(A, 'brand-assets', 'logo.png', JPEG, 'image/jpeg', '?upsert=true')), 'forbidden');
    assert.equal((await upload(null, 'brand-assets', 'logo2.png')).status, 401);
  });
  await check('files: CORS allows the installed app and its uploads preflight', async () => {
    const preflight = await storage(new Request('http://x/api/storage/object/car-photos/a/b.jpg', { method: 'OPTIONS', headers: { origin: 'https://localhost' } }));
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://localhost');
    const stranger = await storage(new Request('http://x/api/storage/object/car-photos/a/b.jpg', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    assert.equal(stranger.headers.get('access-control-allow-origin'), null);
  });

  await pool.end();
  console.log(`${checks.length} data API checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
