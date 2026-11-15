// First-party error tracking (docs/operations/alerts.md): the site's and Xpeed Companion's error reports, their scrubbing, grouping, rate limits,
// the admin-only Problems API, the daily retention job, and the disk numbers of /api/health. Real PostgreSQL via PGlite, real row level security,
// the real server for the routes. No third-party service is involved anywhere.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import { createServer as freePortServer } from 'node:net';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureIdentityProject, listMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.mjs';
import { edgeFunctions } from './esbuild-edge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');
const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');

mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-errors-'));
const filesRoot = mkdtempSync(resolve(temp, 'files-'));
const freePort = () => new Promise((ok, fail) => { const probe = freePortServer(); probe.once('error', fail); probe.listen(0, '127.0.0.1', () => { const { port: given } = probe.address(); probe.close(() => ok(given)); }); });
const port = await freePort();
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATA_BACKEND: 'own', DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', STORAGE_DIR: filesRoot,
  STORAGE_SECRET: 'test-secret', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
});

await build({
  entryPoints: {
    pair: 'api/sim/pair.ts', codes: 'api/sim/codes.ts', v1: 'api/sim/v1.ts', clienterrors: 'api/client-errors.ts', companionerrors: 'api/sim/companion-errors.ts',
    scrub: 'src/lib/error-scrub.ts', shared: 'api/sim/_shared.ts', webserver: 'server/index.ts', serverdb: 'server/db.ts', identity: 'server/identity.ts',
    account: 'server/account-route.ts', jobs: 'server/jobs.ts', health: 'server/health.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error', plugins: [edgeFunctions],
});
const load = (name, query = '') => import(pathToFileURL(resolve(temp, name)).href + query);
const pair = (await load('pair.mjs')).default, codes = (await load('codes.mjs')).default, v1 = (await load('v1.mjs')).default;
const clientErrors = (await load('clienterrors.mjs')).default, companionErrors = (await load('companionerrors.mjs')).default;
const scrub = await load('scrub.mjs');
const { createXpeedServer } = await load('webserver.mjs');
const { forgetLimits } = await load('shared.mjs');
const { getPool } = await load('serverdb.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createAccountRoute } = await load('account.mjs');
const { enabledJobs, runErrorRetention, ERROR_OCCURRENCE_DAYS, ERROR_RESOLVED_GROUP_DAYS } = await load('jobs.mjs');
const { diskUsage, DISK_ALARM_PERCENT } = await load('health.mjs');

const checks = [];
let resetState;
const check = async (name, test) => { forgetLimits(); if (resetState) await resetState(); await test(); checks.push(name); };
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
const direct = { query: (...args) => getPool().query(...args), end: async () => {} };
resetState = async () => { await direct.query('DELETE FROM public.sim_rate; DELETE FROM public.error_groups'); };
let webServer;
const sha = (text) => createHash('sha256').update(text).digest('hex');

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
  const accounts = createAccountRoute();
  const tokens = {}, ids = {};
  for (const [name, phone] of [['A', 1], ['B', 2], ['E', 5]]) {
    tokens[name] = await token(`uid-${name.toLowerCase()}`, { phone_number: `+1555000000${phone}` });
    const r = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${tokens[name]}` } }));
    assert.equal(r.status, 200);
    ids[name] = (await r.json()).id;
    await direct.query('UPDATE public.app_accounts SET email = $2, full_name = $3, phone = $4 WHERE id = $1', [ids[name], `${name.toLowerCase()}.secret@example.com`, `Secret Name ${name}`, `+1555000000${phone}`]);
  }
  const { A, B, E } = tokens;
  // The admin: privileged setup, the way the other SQL checks promote one.
  await direct.query('ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin_insert');
  await direct.query('ALTER TABLE public.car_profiles DISABLE TRIGGER set_car_profiles_user_id');
  await direct.query("INSERT INTO public.car_profiles(user_id, name, is_admin) VALUES ($1, 'Admin Car', true)", [ids.E]);
  await direct.query('ALTER TABLE public.car_profiles ENABLE TRIGGER set_car_profiles_user_id');
  await direct.query('ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin_insert');

  // ---------------------------------------------------------------- helpers
  const PRIVATE = ['a.secret@example.com', 'b.secret@example.com', 'e.secret@example.com', 'Secret Name', '+15550000001', 'uid-a', 'uid-e', ids.A, ids.B, ids.E];
  const raw = async (handler, path, { method = 'GET', bearer, body, headers = {}, ip = '10.0.0.1' } = {}) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return handler(new Request(`http://x${path}`, {
      method, headers: { 'x-real-ip': ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: payload }),
    }));
  };
  const call = async (handler, path, options) => {
    const response = await raw(handler, path, options);
    const text = await response.text();
    for (const secret of PRIVATE) assert.ok(!text.includes(secret), `${path} leaks ${secret}`);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json, headers: response.headers, text };
  };
  const site = (body, options = {}) => call(clientErrors, '/api/client-errors', { method: 'POST', body, ...options });
  const comp = (key, body, options = {}) => call(companionErrors, '/api/sim/companion-errors', { method: 'POST', bearer: key, body, ...options });
  const admin = (path, options = {}) => call(v1, `/api/sim/v1/admin/problems${path}`, { bearer: E, ...options });
  const GOOD = { message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at render (https://xpeed.test/assets/index-AbC123xy.js:10:2345)', route: '/virtual/sessions/:id', build: '6ae3b07a1c2d', at: new Date().toISOString() };
  const groups = async () => (await direct.query('SELECT * FROM public.error_groups ORDER BY first_seen, id')).rows;
  const occurrences = async () => (await direct.query('SELECT * FROM public.error_occurrences ORDER BY id')).rows;
  const newCode = async (who) => {
    forgetLimits();
    const r = await call(codes, '/api/sim/codes', { method: 'POST', bearer: who });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.code;
  };
  const deviceFor = async (who, name) => {
    const r = await call(pair, '/api/sim/pair', { method: 'POST', body: { code: await newCode(who), device: { name } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const CRASH = { version: '0.8.0', worker: 'uploader', message: 'uploader restarted 3 times in 10 minutes: boom', backtrace: '0: engine::run', os: 'windows x86_64', at: new Date().toISOString() };

  // ================================================================== scrubbing (the one module the browser and the server share)

  await check('scrub: e-mails, phone numbers, JWTs, bearer tokens, device keys, query strings, fragments, ids, IP addresses and home folders are removed from messages and stacks', async () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1aWQtYSIsInBob25lIjoiKzE1NTUifQ.c2lnbmF0dXJlLWJ5dGVz';
    const dirty = [
      'failed for maria.silva+test@example.com now',
      'call +1 (555) 000-0001 or 555-000-0001 or +5511987654321 or (11) 98765-4321',
      `token ${jwt} and Authorization: Bearer abc123def456ghi`,
      'key xpd_AbCdEfGhIjKlMnOp0123456789 and opaque 0123456789abcdef0123456789abcdef0123',
      'GET https://xpeed.test/virtual/drivers/maria?token=secret123&email=a@b.co#section failed',
      'lap 3f2a9c1e-1b2d-4c3e-9f4a-5b6c7d8e9f01 of 192.168.1.20',
      'crash in C:\\Users\\Vanildo\\.cargo\\registry\\x.rs and /home/maria/app.js and /Users/joao/a.js',
    ].join('\n');
    for (const text of [scrub.scrubText(dirty), scrub.scrubMessage(dirty), scrub.scrubStack(dirty)]) {
      for (const secret of ['maria.silva', '@example.com', '555-000-0001', '000-0001', '5511987654321', '98765-4321', 'eyJ', 'abc123def456ghi', 'xpd_AbCd', '0123456789abcdef', 'secret123', 'a@b.co', '#section',
        '3f2a9c1e', '192.168.1.20', 'Vanildo', 'maria/app', 'joao']) {
        assert.ok(!text.includes(secret), `${secret} survived: ${text}`);
      }
      assert.ok(!/[?]token/.test(text) && !text.includes('?'), 'no query string is left');
      for (const marker of ['[email]', '[phone]', '[token]', '[id]', '[ip]', '[user]']) assert.ok(text.includes(marker), `${marker} in ${text}`);
    }
    assert.equal(scrub.scrubText('see https://xpeed.test/virtual?lap=1&x=2'), 'see https://xpeed.test/virtual');
    assert.equal(scrub.scrubText(42), '', 'not a string: nothing');
  });

  await check('scrub: ordinary text, versions and line numbers stay, scrubbing twice changes nothing, and sizes are capped', async () => {
    for (const harmless of ['TypeError: Cannot read properties of undefined (reading \'map\')', 'Is it broken? yes it is', 'at f (https://xpeed.test/assets/index-AbC123xy.js:10:2345)', 'Windows 10.0.26200 build', 'v0.7.0-beta.1', 'Item #5 failed']) {
      assert.equal(scrub.scrubText(harmless), harmless);
    }
    const dirty = 'a@b.co +1 555 000 0001 https://x.test/p?q=1 C:\\Users\\Bob\\f.rs';
    const once = scrub.scrubText(dirty);
    assert.equal(scrub.scrubText(once), once, 'idempotent');
    assert.equal(scrub.scrubMessage('ab '.repeat(2000)).length, scrub.MAX_MESSAGE_CHARS);
    assert.ok(scrub.scrubStack(Array.from({ length: 200 }, (_, i) => `    at frame${i} (a.js:1:1)`).join('\n')).split('\n').length <= scrub.MAX_STACK_LINES);
    assert.ok(scrub.scrubStack('ab '.repeat(7000)).length <= scrub.MAX_STACK_CHARS);
    assert.equal(scrub.scrubMessage('line one\n\n   line   two'), 'line one line two', 'a message is one line');
    assert.equal(scrub.scrubLabel('evil@x.com <b>'), 'evilx.com b', 'a label keeps letters, digits and a few separators');
  });

  await check('scrub: a route is a pattern without its query string, fragment or ids, and the browser is a family and a major version, never the user-agent string', async () => {
    assert.equal(scrub.scrubRoute('/virtual/sessions/3f2a9c1e-1b2d-4c3e-9f4a-5b6c7d8e9f01?token=abc#x'), '/virtual/sessions/:id');
    assert.equal(scrub.scrubRoute('https://xpeed.skale.club/s/Zk39dkAq83jdkQ?utm=1'), '/s/:id');
    assert.equal(scrub.scrubRoute('/virtual/drivers/driver_k7f2q9'), '/virtual/drivers/:id');
    assert.equal(scrub.scrubRoute('/session/12345'), '/session/:id');
    assert.equal(scrub.scrubRoute('/virtual/sessions'), '/virtual/sessions');
    assert.equal(scrub.scrubRoute('/admin?x=maria@example.com'), '/admin');
    assert.equal(scrub.scrubRoute('not a path'), '/');
    assert.equal(scrub.scrubRoute(undefined), '/');
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    assert.equal(scrub.browserFamily(chrome), 'chrome/131 desktop');
    assert.equal(scrub.browserFamily(`${chrome} Edg/130.0.2849.5`), 'edge/130 desktop');
    assert.equal(scrub.browserFamily('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'), 'chrome/131 mobile');
    assert.equal(scrub.browserFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1'), 'safari/17 mobile');
    assert.equal(scrub.browserFamily('Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0'), 'firefox/122 desktop');
    assert.equal(scrub.browserFamily('curl/8.0'), 'other desktop');
    assert.ok(!scrub.browserFamily(chrome).includes('Windows') && !scrub.browserFamily(chrome).includes('537'));
  });

  await check('fingerprint: the same bug is one problem whatever the numbers, the line numbers and the build hash in the file name; a different bug is another', async () => {
    const stack = (file, line, name = 'render') => `TypeError: x\n    at ${name} (https://xpeed.test/assets/${file}.js:${line})`;
    const a = scrub.fingerprintOf('restarted 3 times', stack('index-AbC123xy', '10:2345'));
    assert.equal(scrub.fingerprintOf('restarted 5 times', stack('index-ZzZ999aaa', '77:12')), a, 'numbers and build hashes do not make a new problem');
    assert.notEqual(scrub.fingerprintOf('restarted 3 times', stack('index-AbC123xy', '10:2345', 'other')), a, 'another top frame');
    assert.notEqual(scrub.fingerprintOf('something else', stack('index-AbC123xy', '10:2345')), a, 'another message');
    assert.notEqual(scrub.fingerprintOf('restarted 3 times', stack('index-AbC123xy', '10:2345'), 'uploader'), a, 'another worker');
    assert.match(a, /^[0-9a-f]{14}$/);
  });

  // ================================================================== the site's endpoint

  await check('site: a report is stored scrubbed (an e-mail, a phone number, a token or a query string never reaches a table) with the server\'s own fingerprint', async () => {
    const dirty = {
      message: 'Cannot save for maria.silva@example.com, phone +1 555 000 0001, token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln',
      stack: 'Error: boom\n    at save (https://xpeed.test/assets/a.js:1:1?token=secret123)\n    at C:\\Users\\Vanildo\\x.js:2:2',
      route: '/virtual/drivers/maria?email=maria@example.com',
      build: '6ae3b07a1c2d', agent: 'evil@example.com', fingerprint: 'aaaaaaaaaaaaaa', at: new Date().toISOString(),
    };
    const r = await site(dirty, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' } });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    const [group] = await groups();
    const everything = JSON.stringify([await groups(), await occurrences()]);
    for (const secret of ['maria', 'example.com', '555 000', 'eyJ', 'secret123', 'Vanildo', 'evil@']) assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), `${secret} reached the database: ${everything}`);
    assert.equal(group.source, 'site');
    assert.equal(group.sample_route, '/virtual/drivers/:id');
    assert.equal(group.version, '6ae3b07a1c2d');
    assert.equal(group.agent, 'chrome/131 desktop', 'the browser family comes from the request header, not from the body');
    assert.notEqual(group.fingerprint, 'aaaaaaaaaaaaaa', 'the sender\'s fingerprint is ignored');
    assert.equal(group.fingerprint, scrub.fingerprintOf(group.sample_message, group.sample_stack));
    assert.deepEqual([Number(group.occurrences), group.affected_users, group.resolved_at], [1, 0, null]);
    const columns = (await direct.query("SELECT column_name FROM information_schema.columns WHERE table_name IN ('error_groups', 'error_occurrences', 'error_group_users')")).rows.map((c) => c.column_name);
    assert.ok(!columns.some((c) => /ip|email|phone|user_id|account/.test(c)), `no column for personal data: ${columns}`);
  });

  await check('site: the same problem is one group (count, last seen, one sample, occurrences kept), another message is another group, and a flood of one problem keeps only the newest 50 occurrences', async () => {
    await site(GOOD);
    await site({ ...GOOD, message: 'TypeError: x is undefined', build: '7bb8c18e2f3a' });
    await site({ ...GOOD, message: 'Network failure 500', stack: '' });
    let rows = await groups();
    assert.equal(rows.length, 2);
    const same = rows.find((g) => g.sample_message.startsWith('TypeError'));
    assert.deepEqual([Number(same.occurrences), same.version], [2, '7bb8c18e2f3a'], 'counted twice, newest build shown');
    assert.ok(same.last_seen >= same.first_seen);
    assert.equal((await occurrences()).filter((o) => o.group_id === same.id).length, 2);
    // Numbers in a message do not make a new problem.
    await site({ ...GOOD, message: 'Network failure 404', stack: '' });
    assert.equal((await groups()).length, 2);
    for (let i = 0; i < 55; i++) await site({ ...GOOD, message: 'Flood problem', stack: '' }, { ip: `10.1.${i}.1` });
    rows = await groups();
    const flood = rows.find((g) => g.sample_message === 'Flood problem');
    assert.equal(Number(flood.occurrences), 55);
    assert.equal((await occurrences()).filter((o) => o.group_id === flood.id).length, 50, 'the newest 50 occurrences are kept');
  });

  await check('site: the signed-in person is counted once, as a one-way hash that is never the account id; anonymous reports and a bad sign-in count nobody; the id is in no answer', async () => {
    await site(GOOD, { bearer: A });
    await site(GOOD, { bearer: A });
    await site(GOOD, { bearer: B });
    await site(GOOD);
    await site(GOOD, { bearer: 'not.a.token' });
    const [group] = await groups();
    assert.equal(Number(group.occurrences), 5);
    assert.equal(group.affected_users, 2, 'two different people, however many reports');
    const hashes = (await direct.query('SELECT user_hash FROM public.error_group_users ORDER BY user_hash')).rows.map((r) => r.user_hash);
    assert.deepEqual(hashes, [sha(`xpeed-errors:${ids.A}`), sha(`xpeed-errors:${ids.B}`)].sort());
    assert.ok(!hashes.includes(ids.A) && !hashes.includes(ids.B));
    const listed = await admin('?status=open');
    assert.equal(listed.body.problems[0].affectedUsers, 2);
    assert.ok(!listed.text.includes(sha(`xpeed-errors:${ids.A}`)), 'not even the hash is shown');
  });

  await check('site: it is strict (not JSON, not an object, empty or wrong-typed fields, 413 over 16 KB), a device key is not a sign-in, and the browser gets CORS headers only for the app\'s own origin', async () => {
    const bad = async (body, error, status = 400) => { const r = await site(body); assert.deepEqual([r.status, r.body], [status, { error, retryable: false }], JSON.stringify(body).slice(0, 80)); };
    await bad('not json', 'invalid_json');
    await bad('[1]', 'invalid_request');
    await bad({ stack: 'x' }, 'invalid_message');
    await bad({ message: '   ' }, 'invalid_message');
    await bad({ message: 42 }, 'invalid_message');
    await bad({ message: 'ok', stack: 42 }, 'invalid_stack');
    await bad({ message: 'ok', route: {} }, 'invalid_route');
    await bad({ message: 'ok', build: 'bad build!' }, 'invalid_build');
    await bad({ message: 'ok'.repeat(3000) }, 'invalid_message');
    const big = await site({ message: 'ok', stack: 'x'.repeat(20_000) });
    assert.deepEqual([big.status, big.body.error], [413, 'too_large']);
    assert.equal((await groups()).length, 0, 'a refused report writes nothing');
    const rig = await deviceFor(A, 'ERR PC');
    assert.equal((await site(GOOD, { bearer: rig.token })).status, 200, 'a device key is simply anonymous here');
    assert.equal((await groups())[0].affected_users, 0);
    const wrong = await call(clientErrors, '/api/client-errors', { method: 'GET' });
    assert.deepEqual([wrong.status, wrong.headers.get('allow')], [405, 'POST, OPTIONS']);
    const preflight = await raw(clientErrors, '/api/client-errors', { method: 'OPTIONS', headers: { origin: 'https://xpeed.test', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    const foreign = await raw(clientErrors, '/api/client-errors', { method: 'POST', body: GOOD, headers: { origin: 'https://evil.example' } });
    assert.notEqual(foreign.headers.get('access-control-allow-origin'), 'https://evil.example');
    await direct.query('DELETE FROM public.sim_devices');
  });

  await check('site: 60 reports a minute per IP address, counted in the database (so every server instance agrees); another address is not affected; the address is never stored', async () => {
    for (let i = 1; i <= 60; i++) assert.equal((await site({ ...GOOD, message: `Flood ${i} message ${'x'.repeat(i % 3)}` }, { ip: '203.0.113.9' })).status, 200, `report ${i}`);
    const refused = await site(GOOD, { ip: '203.0.113.9' });
    assert.deepEqual([refused.status, refused.body], [429, { error: 'too_many_requests', retryable: true }]);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1 && Number(refused.headers.get('retry-after')) <= 60);
    const before = Number((await direct.query('SELECT sum(occurrences) AS n FROM public.error_groups')).rows[0].n);
    assert.equal(before, 60, 'the refused one wrote nothing');
    assert.equal((await site(GOOD, { ip: '203.0.113.10' })).status, 200, 'another address');
    const second = (await load('clienterrors.mjs', '?instance=2')).default;
    assert.equal((await call(second, '/api/client-errors', { method: 'POST', body: GOOD, headers: { 'x-real-ip': '203.0.113.9' }, ip: '203.0.113.9' })).status, 429, 'another instance agrees');
    const keys = (await direct.query("SELECT key FROM public.sim_rate WHERE key LIKE 'ce:%'")).rows.map((r) => r.key);
    assert.ok(keys.length >= 2 && keys.every((k) => /^ce:[0-9a-f]{32}$/.test(k)), `hashed keys only: ${keys}`);
    assert.ok(!JSON.stringify(await groups()).includes('203.0.113'), 'the address is not in a report');
  });

  // ================================================================== the admin side

  await check('admin: only an admin lists or resolves problems (no sign-in 401, a device key 401, an ordinary person 403, an admin 200), and a person\'s 403 changes nothing', async () => {
    await site(GOOD);
    const [group] = await groups();
    const rig = await deviceFor(A, 'ADMIN KEY');
    for (const [path, options] of [['?status=open', {}], [`/${group.id}`, { method: 'POST', body: { resolved: true } }]]) {
      assert.deepEqual([(await admin(path, { ...options, bearer: undefined })).status, (await admin(path, { ...options, bearer: undefined })).body], [401, { error: 'unauthorized', retryable: false }], `no sign-in ${path}`);
      assert.equal((await admin(path, { ...options, bearer: rig.token })).status, 401, `device key ${path}`);
      const person = await admin(path, { ...options, bearer: A });
      assert.deepEqual([person.status, person.body], [403, { error: 'forbidden', retryable: false }], `ordinary person ${path}`);
    }
    assert.equal((await groups())[0].resolved_at, null, 'nothing was resolved by a person');
    assert.equal((await admin('?status=open')).status, 200);
    await direct.query('DELETE FROM public.sim_devices');
  });

  await check('admin: the list is newest first with count, last seen, version, source and the sample stack, filters by status and source, and carries no e-mail, id of a person or address', async () => {
    await site({ ...GOOD, message: 'Older site problem', stack: 'Error\n    at old (a.js:1:1)' });
    await direct.query("UPDATE public.error_groups SET last_seen = now() - interval '2 hours'");
    await site({ ...GOOD, message: 'Newer site problem' }, { bearer: A });
    const rig = await deviceFor(B, 'ERR PC 2');
    assert.equal((await comp(rig.token, CRASH)).status, 200);
    const all = await admin('?status=all');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.problems.map((p) => p.message.slice(0, 12)), ['uploader res', 'Newer site p', 'Older site p'], 'newest first');
    const newer = all.body.problems.find((p) => p.message === 'Newer site problem');
    assert.deepEqual(Object.keys(newer).sort(), ['affectedUsers', 'agent', 'count', 'fingerprint', 'firstSeen', 'id', 'last24h', 'lastSeen', 'message', 'reopenedCount', 'resolvedAt', 'route', 'source', 'stack', 'version', 'worker']);
    assert.deepEqual([newer.source, newer.count, newer.version, newer.affectedUsers, newer.last24h, newer.resolvedAt], ['site', 1, '6ae3b07a1c2d', 1, 1, null]);
    assert.match(newer.stack, /at render/);
    assert.deepEqual((await admin('?source=companion')).body.problems.map((p) => [p.source, p.worker, p.version, p.agent]), [['companion', 'uploader', '0.8.0', 'windows x86_64']]);
    assert.equal((await admin('?source=site')).body.problems.length, 2);
    assert.equal((await admin('?status=resolved')).body.problems.length, 0);
    assert.equal((await admin('?limit=1&status=all')).body.problems.length, 1);
    assert.deepEqual([(await admin('?status=weird')).body.error, (await admin('?source=weird')).body.error], ['invalid_status', 'invalid_source']);
    await direct.query('DELETE FROM public.sim_devices');
  });

  await check('admin: "mark resolved" hides a problem, and it reopens when it happens again after; a report of something that happened before it was resolved does not reopen it', async () => {
    await site(GOOD);
    const [group] = await groups();
    const resolved = await admin(`/${group.id}`, { method: 'POST', body: { resolved: true } });
    assert.deepEqual([resolved.status, resolved.body.id], [200, group.id]);
    assert.ok(Date.parse(resolved.body.resolvedAt) > 0);
    assert.equal((await admin('?status=open')).body.problems.length, 0, 'gone from the open list');
    assert.equal((await admin('?status=resolved')).body.problems.length, 1);
    // An occurrence from before the resolution (a browser that sent it late) leaves it resolved.
    await site({ ...GOOD, at: new Date(Date.now() - 3_600_000).toISOString() });
    let row = (await groups())[0];
    assert.notEqual(row.resolved_at, null, 'an old occurrence does not reopen it');
    assert.equal(Number(row.occurrences), 2, 'but it is counted');
    await direct.query("UPDATE public.error_groups SET resolved_at = now() - interval '1 minute'");
    await site(GOOD);
    row = (await groups())[0];
    assert.deepEqual([row.resolved_at, row.reopened_count, Number(row.occurrences)], [null, 1, 3], 'it happened again after: open again, and it says so');
    const listed = (await admin('?status=open')).body.problems[0];
    assert.deepEqual([listed.resolvedAt, listed.reopenedCount], [null, 1]);
    // Reopening by hand, and resolving again.
    assert.equal((await admin(`/${group.id}`, { method: 'POST', body: { resolved: true } })).status, 200);
    assert.equal((await admin(`/${group.id}`, { method: 'POST', body: { resolved: false } })).body.resolvedAt, null);
  });

  await check('admin: resolving is strict (a boolean and nothing else), an unknown problem is 404, and a malformed id is not a route', async () => {
    await site(GOOD);
    const [group] = await groups();
    for (const body of [{}, { resolved: 'yes' }, { resolved: true, extra: 1 }, [], 'x']) {
      const r = await admin(`/${group.id}`, { method: 'POST', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.deepEqual([(await admin('/10000000-0000-4000-8000-000000000001', { method: 'POST', body: { resolved: true } })).status], [404]);
    assert.equal((await admin('/not-a-uuid', { method: 'POST', body: { resolved: true } })).status, 404);
    assert.equal((await admin(`/${group.id}`)).status, 405);
    assert.equal((await groups())[0].resolved_at, null);
  });

  // ================================================================== Xpeed Companion's endpoint

  await check('companion: the device key decides (none, unknown, a person\'s sign-in or a revoked key are all 401) and a refused report writes nothing', async () => {
    const rig = await deviceFor(A, 'ERR PC 3');
    for (const key of ['', 'xpd_unknown', A]) {
      const r = await comp(key, CRASH);
      assert.deepEqual([r.status, r.body], [401, { error: 'unauthorized', retryable: false }], `key ${key.slice(0, 8) || '(none)'}`);
    }
    assert.deepEqual([(await comp(rig.token, CRASH)).status], [200]);
    await direct.query("UPDATE public.sim_devices SET revoked_at = now() WHERE id = $1", [rig.deviceId]);
    const revoked = await comp(rig.token, { ...CRASH, message: 'after revoke' });
    assert.deepEqual([revoked.status, revoked.body], [401, { error: 'unauthorized', retryable: false }], 'revoked: like an upload');
    assert.deepEqual((await groups()).map((g) => g.sample_message.slice(0, 8)), ['uploader'], 'only the first report was kept');
    assert.deepEqual([(await call(companionErrors, '/api/sim/companion-errors', { method: 'GET', bearer: rig.token })).status], [405]);
    await direct.query('DELETE FROM public.sim_devices');
  });

  await check('companion: a report is scrubbed again on the server (a Windows account name in a path), grouped by worker and message, counts the person once with the same hash as the site, and is strict about version and worker', async () => {
    const rig = await deviceFor(A, 'ERR PC 4');
    const dirty = { ...CRASH, message: 'panicked at C:\\Users\\Vanildo\\.cargo\\x.rs:10:5: mail a@b.co', backtrace: '0: C:\\Users\\Vanildo\\y.rs\n1: https://x.test/p?token=abc', worker: 'Game Readers' };
    assert.equal((await comp(rig.token, dirty)).status, 200);
    assert.equal((await comp(rig.token, { ...dirty, message: 'panicked at C:\\Users\\Other\\.cargo\\x.rs:99:1: mail c@d.co' })).status, 200);
    let rows = await groups();
    const everything = JSON.stringify([rows, await occurrences()]);
    for (const secret of ['Vanildo', 'Other', 'a@b.co', 'c@d.co', 'token=abc']) assert.ok(!everything.includes(secret), `${secret} reached the database`);
    assert.equal(rows.length, 1, 'the same crash from two paths is one problem');
    assert.deepEqual([rows[0].source, rows[0].worker, rows[0].version, rows[0].agent, Number(rows[0].occurrences), rows[0].affected_users, rows[0].sample_route],
      ['companion', 'game readers', '0.8.0', 'windows x86_64', 2, 1, null]);
    await site(GOOD, { bearer: A });
    assert.deepEqual((await direct.query('SELECT user_hash FROM public.error_group_users')).rows.map((r) => r.user_hash), [sha(`xpeed-errors:${ids.A}`), sha(`xpeed-errors:${ids.A}`)], 'the same one-way hash for the same person, in both sources');
    // Another worker is another problem.
    assert.equal((await comp(rig.token, { ...dirty, worker: 'uploader' })).status, 200);
    assert.equal((await groups()).filter((g) => g.source === 'companion').length, 2);
    const bad = async (body, error) => { const r = await comp(rig.token, body); assert.deepEqual([r.status, r.body], [400, { error, retryable: false }], JSON.stringify(body).slice(0, 70)); };
    await bad('nope', 'invalid_json');
    await bad({ ...CRASH, version: 'latest' }, 'invalid_version');
    await bad({ ...CRASH, version: undefined }, 'invalid_version');
    await bad({ ...CRASH, worker: 'bad<worker>' }, 'invalid_worker');
    await bad({ ...CRASH, worker: 7 }, 'invalid_worker');
    await bad({ ...CRASH, message: '' }, 'invalid_message');
    await bad({ ...CRASH, backtrace: 5 }, 'invalid_backtrace');
    await bad({ ...CRASH, os: 'x'.repeat(80) }, 'invalid_os');
    assert.equal((await comp(rig.token, { ...CRASH, newField: 'ignored from a newer Companion', message: 'newer companion' })).status, 200);
    const big = await comp(rig.token, { ...CRASH, backtrace: 'z'.repeat(20_000) });
    assert.deepEqual([big.status, big.body.error], [413, 'too_large']);
    await direct.query('DELETE FROM public.sim_devices');
  });

  await check('companion: 10 reports a minute per computer, counted in the database; another computer is not affected; a refused one writes nothing', async () => {
    const one = await deviceFor(A, 'ERR PC 5'), two = await deviceFor(B, 'ERR PC 6');
    for (let i = 1; i <= 10; i++) assert.equal((await comp(one.token, { ...CRASH, message: `failure ${i}` })).status, 200, `report ${i}`);
    const refused = await comp(one.token, CRASH);
    assert.deepEqual([refused.status, refused.body], [429, { error: 'too_many_requests', retryable: true }]);
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
    assert.equal(Number((await direct.query("SELECT sum(occurrences) AS n FROM public.error_groups")).rows[0].n), 10, 'the ten reports are one problem (numbers do not make a new one), and the eleventh wrote nothing');
    assert.equal((await comp(two.token, CRASH)).status, 200, 'another computer');
    const second = (await load('companionerrors.mjs', '?instance=2')).default;
    assert.equal((await call(second, '/api/sim/companion-errors', { method: 'POST', bearer: one.token, body: CRASH })).status, 429, 'another instance agrees');
    await direct.query('DELETE FROM public.sim_devices');
  });

  // ================================================================== storage: caps, retention, grants

  await check('storage: past the cap new problems are dropped (the answer is still ok) so a flood of made-up messages cannot grow the table, while known problems keep counting', async () => {
    const call2 = (n, fingerprint, max) => direct.query(
      "SELECT public.error_report_record('site', 'ce:cap', 100000, NULL, NULL, $1, $2, '', '/', '1', 'x', NULL, now(), $3) AS r", [fingerprint, `m${n}`, max]);
    assert.equal((await call2(1, 'fingerprint-aaaa', 2)).rows[0].r.status, 'ok');
    assert.equal((await call2(2, 'fingerprint-bbbb', 2)).rows[0].r.status, 'ok');
    assert.deepEqual((await call2(3, 'fingerprint-cccc', 2)).rows[0].r, { status: 'full' }, 'a third problem is dropped');
    assert.equal((await call2(1, 'fingerprint-aaaa', 2)).rows[0].r.isNew, false, 'a known one still counts');
    assert.equal((await groups()).length, 2);
    assert.equal(Number((await groups()).find((g) => g.fingerprint === 'fingerprint-aaaa').occurrences), 2);
    // The endpoint itself answers ok for a dropped problem (the page cannot do anything about it); its cap is 2000, the SQL cap above is the same code.
    assert.equal((await site({ ...GOOD, message: 'Still fine' })).status, 200);
  });

  await check('retention: the daily job deletes occurrences older than 30 days and resolved problems not seen for 90 days, keeps everything newer, and is scheduled with the other jobs', async () => {
    assert.deepEqual([ERROR_OCCURRENCE_DAYS, ERROR_RESOLVED_GROUP_DAYS], [30, 90]);
    await site({ ...GOOD, message: 'Old and open' });
    await site({ ...GOOD, message: 'Old and resolved' });
    await site({ ...GOOD, message: 'Fresh' });
    const rows = await groups();
    const id = (text) => rows.find((g) => g.sample_message === text).id;
    await direct.query("UPDATE public.error_occurrences SET received_at = now() - interval '31 days' WHERE group_id = $1", [id('Old and open')]);
    await direct.query("UPDATE public.error_occurrences SET received_at = now() - interval '29 days' WHERE group_id = $1", [id('Fresh')]);
    await direct.query("UPDATE public.error_occurrences SET received_at = now() - interval '100 days' WHERE group_id = $1", [id('Old and resolved')]);
    await direct.query("UPDATE public.error_groups SET resolved_at = now() - interval '95 days', last_seen = now() - interval '95 days' WHERE id = $1", [id('Old and resolved')]);
    const result = await runErrorRetention(direct);
    assert.deepEqual(result, { occurrencesDeleted: 2, groupsDeleted: 1 });
    const left = await groups();
    assert.deepEqual(left.map((g) => g.sample_message).sort(), ['Fresh', 'Old and open'], 'an old but still open problem stays, with its sample');
    assert.deepEqual((await occurrences()).map((o) => o.group_id), [id('Fresh')], 'only the occurrence of the last 30 days is left');
    // Through the job list: scheduled next to the others, and it runs through the database function.
    const job = enabledJobs(process.env).find((j) => j.name === 'error_retention');
    assert.ok(job, 'error_retention is one of the daily jobs');
    assert.deepEqual(await job.run(), { occurrencesDeleted: 0, groupsDeleted: 0 });
    assert.equal(enabledJobs({}, {}).find((j) => j.name === 'error_retention'), undefined, 'no database, no job');
    assert.deepEqual(enabledJobs({ DATABASE_URL: 'postgres://x' }, {}).map((j) => j.name), [], 'and only where the job is offered');
  });

  await check('storage: the migration is additive and idempotent, the tables are the server\'s alone (row level security, nothing for the browser roles) and so are the functions', async () => {
    const file = listMigrations(MIGRATIONS_DIR).find((name) => name.includes('error_tracking'));
    assert.ok(file && file > '20261113200000', 'the migration comes after the last one');
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
    await site(GOOD);
    const before = JSON.stringify(await groups());
    await direct.query(sql);
    await direct.query(sql);
    assert.equal(JSON.stringify(await groups()), before, 'applied again it changes nothing');
    assert.ok(!/\b(DROP|TRUNCATE)\b/i.test(sql.replace(/--.*$/gm, '')) && !/ALTER TABLE public\.sim_/i.test(sql), 'it only adds');
    for (const table of ['error_groups', 'error_group_users', 'error_occurrences']) {
      const rls = (await direct.query('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [`public.${table}`])).rows[0].relrowsecurity;
      assert.equal(rls, true, `${table}: row level security is on`);
      for (const role of ['anon', 'authenticated']) {
        const can = (await direct.query("SELECT has_table_privilege($1, $2, 'SELECT') OR has_table_privilege($1, $2, 'INSERT') AS ok", [role, `public.${table}`])).rows[0].ok;
        assert.equal(can, false, `${table}: ${role} has no access`);
      }
      assert.equal((await direct.query("SELECT has_table_privilege('service_role', $1, 'SELECT') AS ok", [`public.${table}`])).rows[0].ok, true);
    }
    for (const name of ['error_report_record', 'error_groups_list', 'error_group_set_resolved', 'error_retention']) {
      const grants = async (role) => (await direct.query("SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE p.proname = $2 AND p.pronamespace = 'public'::regnamespace", [role, name])).rows[0].ok;
      assert.deepEqual([await grants('anon'), await grants('authenticated'), await grants('service_role')], [false, false, true], `${name}: only the server runs it`);
    }
  });

  // ================================================================== the disk alarm

  await check('health: the disk of the files volume is reported as percentages only (no path, no byte count), computed like df, null where the files are not on this disk, and 85% is the alarm', async () => {
    assert.equal(DISK_ALARM_PERCENT, 85);
    const fake = (blocks, bavail) => async () => ({ blocks, bavail, bfree: bavail, bsize: 4096, type: 1, files: 1, ffree: 1 });
    assert.deepEqual(await diskUsage({ STORAGE_DIR: '/x' }, fake(1000, 250)), { usedPercent: 75, freePercent: 25 });
    assert.deepEqual(await diskUsage({ STORAGE_DIR: '/x' }, fake(1000, 0)), { usedPercent: 100, freePercent: 0 });
    assert.deepEqual(await diskUsage({ STORAGE_DIR: '/x' }, fake(3, 1)), { usedPercent: 66.7, freePercent: 33.3 });
    assert.equal(await diskUsage({ STORAGE_DIR: '/x' }, fake(0, 0)), null, 'an empty answer is nothing');
    assert.equal(await diskUsage({ STORAGE_DRIVER: 's3', STORAGE_DIR: '/x' }, fake(1000, 250)), null, 'the s3 driver: not this disk');
    assert.equal(await diskUsage({ STORAGE_DRIVER: 'nonsense' }, fake(1000, 250)), null, 'a bad configuration is never a throw');
    assert.equal(await diskUsage({ STORAGE_DIR: '/x' }, async () => { throw new Error('ENOENT: /secret/path'); }), null, 'an unreadable volume is null, not an error');
    const real = await diskUsage({ STORAGE_DIR: filesRoot });
    assert.ok(real && real.usedPercent >= 0 && real.usedPercent <= 100 && Math.abs(real.usedPercent + real.freePercent - 100) < 0.11, JSON.stringify(real));
  });

  await check('health: through the real server /api/health carries disk.usedPercent and freePercent and nothing else about the disk (no path), and stays 200 whatever the disk says', async () => {
    webServer = createXpeedServer({ staticRoot: temp, origin: 'https://xpeed.test' });
    await new Promise((done) => webServer.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${webServer.address().port}`;
    const response = await fetch(`${base}/api/health`);
    const text = await response.text();
    assert.equal(response.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.status, 'ok');
    assert.deepEqual(Object.keys(body.disk).sort(), ['freePercent', 'usedPercent']);
    assert.ok(typeof body.disk.usedPercent === 'number' && body.disk.usedPercent >= 0 && body.disk.usedPercent <= 100);
    assert.ok(!text.includes(filesRoot) && !text.includes('xpeed-errors-'), 'no path in the answer');
    assert.ok(!/bytes|blocks|bsize/i.test(JSON.stringify(body.disk)));
    // Both endpoints are routed by the real server, with their own small body limit.
    const stranger = await fetch(`${base}/api/sim/companion-errors`, { method: 'POST', body: JSON.stringify(CRASH) });
    assert.deepEqual([stranger.status, (await stranger.json()).error], [401, 'unauthorized']);
    const big = await fetch(`${base}/api/client-errors`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(40_000) });
    assert.equal(big.status, 413, 'a body over 32 KB is cut off while it is read');
    const ok = await fetch(`${base}/api/client-errors`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 Firefox/122.0' }, body: JSON.stringify(GOOD) });
    assert.deepEqual([ok.status, await ok.json()], [200, { ok: true }]);
    assert.equal((await groups())[0].agent, 'firefox/122 desktop');
    assert.equal((await fetch(`${base}/api/client-errors`)).status, 405);
    await new Promise((done) => (webServer.closeAllConnections?.(), webServer.close(done)));
    webServer = undefined;
  });

  await check('uptime workflow: it reads disk.usedPercent from /api/health, alarms above 85, fails the run so GitHub e-mails the owner (the hourly slot, or a manual run, for the disk; the hourly issue for a site that is down) and needs no secret', async () => {
    const yml = readFileSync(resolve(root, '.github/workflows/uptime.yml'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(yml, /\/api\/health"/, 'it asks the plain health endpoint, which carries the disk');
    assert.match(yml, /\.disk\.usedPercent/);
    assert.match(yml, /limit=85/);
    assert.match(yml, /p \+ 0 > t \+ 0/, 'above, not at, the limit');
    assert.match(yml, /Fail the run so GitHub e-mails the owner/);
    assert.match(yml, /\[ "\$fail" = false \] \|\| exit 1/, 'the run fails');
    assert.match(yml, /workflow_dispatch/);
    assert.match(yml, /-lt 5/, 'the disk fails the run in the first minutes of the hour only, so a full disk is not an e-mail every 5 minutes');
    assert.match(yml, /notify=true/, 'a site that is down fails the run when the issue is opened or commented on, an hour at most');
    assert.ok(!/secrets\./.test(yml), 'no secret');
    assert.ok(/if: always\(\)/.test(yml), 'the failing step runs even when an earlier step ended');
    const doc = readFileSync(resolve(root, 'docs/operations/alerts.md'), 'utf8');
    assert.match(doc, /85%/);
    assert.match(doc, /\/api\/client-errors/);
    assert.match(doc, /\/api\/sim\/companion-errors/);
  });

  console.log(`${checks.length} error tracking checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await new Promise((done) => (webServer ? (webServer.closeAllConnections?.(), webServer.close(done)) : done())).catch(() => {});
  await direct.end().catch(() => {});
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
