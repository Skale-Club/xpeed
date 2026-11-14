// Phase 2, the social side of the racing data (docs/platform/API-V1.md, docs/platform/PRIVACY-MODEL.md) on the app's own backend:
// real PostgreSQL via PGlite, a real file folder, real row level security. Profiles (public by default, three visibilities), friends,
// share links, plausibility of laps, leaderboards, reports and moderation, and the export and delete rights.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureIdentityProject, listMigrations, migrate, MIGRATIONS_DIR } from '../db/migrate.mjs';
import { edgeFunctions } from './esbuild-edge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');
const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');

mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-sim-social-'));
const filesRoot = mkdtempSync(resolve(temp, 'files-'));
const port = 55481, upgradePort = 55482;
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATA_BACKEND: 'own', DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', STORAGE_DIR: filesRoot,
  STORAGE_SECRET: 'test-secret', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
});

await build({
  entryPoints: {
    pair: 'api/sim/pair.ts', laps: 'api/sim/laps.ts', codes: 'api/sim/codes.ts', tracks: 'api/sim/tracks.ts', v1: 'api/sim/v1.ts', publicshare: 'api/sim/public.ts',
    plausibility: 'api/sim/_plausibility.ts', social: 'api/sim/_social.ts', shared: 'api/sim/_shared.ts', backend: 'api/_backend.ts', webserver: 'server/index.ts',
    lapfile: 'src/lib/sim/lap-file.ts', serverdb: 'server/db.ts', identity: 'server/identity.ts', account: 'server/account-route.ts', jobs: 'server/jobs.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error', plugins: [edgeFunctions],
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const pair = (await load('pair.mjs')).default, laps = (await load('laps.mjs')).default;
const codes = (await load('codes.mjs')).default, v1 = (await load('v1.mjs')).default, simPublic = (await load('publicshare.mjs')).default;
const { checkPlausibility, PLAUSIBILITY, CHECKS, recheckLaps } = await load('plausibility.mjs');
const { runPlausibilityRecheck, enabledJobs } = await load('jobs.mjs');
const { RESERVED_HANDLES, readHandle, readDisplayName } = await load('social.mjs');
const { createXpeedServer } = await load('webserver.mjs');
const { forgetLimits } = await load('shared.mjs');
const { getPool } = await load('serverdb.mjs');
const { gzipLap, gunzipLap } = await load('lapfile.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createAccountRoute } = await load('account.mjs');
const { openBackend } = await load('backend.mjs');

const checks = [];
let resetRates;
const check = async (name, test) => {
  forgetLimits();
  if (resetRates) await resetRates();
  await resetSocial();
  await test();
  checks.push(name);
};
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
const upgradeDb = await PGlite.create();
const upgradeServer = new PGLiteSocketServer({ db: upgradeDb, port: upgradePort, host: '127.0.0.1' });
await upgradeServer.start();
const direct = { query: (...args) => getPool().query(...args), end: async () => {} };
resetRates = () => direct.query('DELETE FROM public.sim_rate');
/** Every check starts from the same social state: no friendships, reports or shares, every profile public and visible. */
const resetSocial = async () => {
  if (!ready) return;
  await direct.query('DELETE FROM public.sim_friendships; DELETE FROM public.sim_reports; DELETE FROM public.sim_shares; DELETE FROM public.sim_handle_changes');
  await direct.query("UPDATE public.sim_profiles SET visibility = 'public', hidden = false");
  await direct.query('UPDATE public.sim_laps SET hidden = false WHERE hidden');
};
let ready = false, webServer;

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
  const tokens = {}, ids = {}, secrets = [];
  // A: the main driver. B: A's friend. C: a stranger. D: a driver whose laps are implausible. E: a moderator. F: the person who erases their data.
  const people = { A: 'Ana Realname', B: 'Bruno Realname', C: 'Carla Realname', D: 'Davi Realname', E: 'Elisa Realname', F: 'Fabio Realname' };
  let n = 0;
  for (const [name, fullName] of Object.entries(people)) {
    n++;
    const phone = `+1555000000${n}`;
    tokens[name] = await token(`uid-${name.toLowerCase()}`, { phone_number: phone });
    const r = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${tokens[name]}` } }));
    assert.equal(r.status, 200);
    ids[name] = (await r.json()).id;
    const email = `${name.toLowerCase()}.secret@example.com`;
    await direct.query('UPDATE public.app_accounts SET email = $2, full_name = $3, phone = $4 WHERE id = $1', [ids[name], email, fullName, phone]);
    secrets.push(email, `${name.toLowerCase()}.secret`, fullName, phone, `uid-${name.toLowerCase()}`, ids[name]);
  }
  const { A, B, C, D, E, F } = tokens;
  // The moderator: privileged setup, the way the other SQL checks promote an admin.
  await direct.query('ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin_insert');
  await direct.query('ALTER TABLE public.car_profiles DISABLE TRIGGER set_car_profiles_user_id');
  await direct.query("INSERT INTO public.car_profiles(user_id, name, is_admin) VALUES ($1, 'Moderator Car', true)", [ids.E]);
  await direct.query('ALTER TABLE public.car_profiles ENABLE TRIGGER set_car_profiles_user_id');
  await direct.query('ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin_insert');

  // ---------------------------------------------------------------- helpers

  /** What no answer may ever contain: the e-mail, phone, real name, sign-in subject or account id of anyone. Every response of the suite is scanned. */
  let scanned = 0;
  const FORBIDDEN_KEYS = /"(email|phone|fullName|full_name|user_id|userId|accountId|token_hash|tokenHash|storage_path|storagePath)"\s*:/;
  const scan = (text, where) => {
    scanned++;
    for (const secret of secrets) assert.ok(!text.includes(secret), `${where} leaks ${secret}`);
    assert.ok(!/@example\.com/.test(text), `${where} has an e-mail address`);
    assert.ok(!FORBIDDEN_KEYS.test(text), `${where} has a private key: ${text.match(FORBIDDEN_KEYS)?.[0]}`);
  };
  const raw = async (handler, path, { method = 'GET', bearer, body, headers = {}, ip = '10.0.0.1' } = {}) => {
    const payload = body === undefined ? undefined : body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
    return handler(new Request(`http://x${path}`, {
      method, headers: { 'x-real-ip': ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(payload === undefined || payload instanceof Uint8Array ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: payload }),
    }));
  };
  const call = async (handler, path, options) => {
    const response = await raw(handler, path, options);
    const text = await response.text();
    scan(text, `${options?.method ?? 'GET'} ${path}`);
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: json, headers: response.headers, text };
  };
  const as = (who) => (path, options = {}) => call(v1, `/api/sim/v1${path}`, { bearer: tokens[who], ...options });
  const api = { A: as('A'), B: as('B'), C: as('C'), D: as('D'), E: as('E'), F: as('F') };
  const pub = (path, options) => call(simPublic, `/api/sim/public${path}`, options);
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const profileOf = async (who) => (await api[who]('/profile')).body.profile;
  const setVisibility = async (who, visibility) => assert.equal((await api[who]('/profile', { method: 'PATCH', body: { visibility } })).status, 200);
  const befriend = async (a, b) => {
    const handle = (await profileOf(b)).handle, mine = (await profileOf(a)).handle;
    assert.equal((await api[a]('/friends/requests', { method: 'POST', body: { handle } })).status, 201);
    assert.equal((await api[b](`/friends/requests/${mine}/accept`, { method: 'POST' })).status, 200);
  };
  const problem = (r, status, error) => assert.deepEqual([r.status, r.body], [status, { error, retryable: status === 429 || status >= 500 }], JSON.stringify(r.body));

  const newCode = async (who) => {
    forgetLimits();
    const r = await call(codes, '/api/sim/codes', { method: 'POST', bearer: who });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.code;
  };
  const deviceFor = async (who, name = 'RIG') => {
    const r = await call(pair, '/api/sim/pair', { method: 'POST', body: { code: await newCode(who), device: { name } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const upload = (key, body) => call(laps, '/api/sim/laps', { method: 'POST', bearer: key, body, headers: { 'content-type': 'application/gzip' } });

  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  const nextStart = () => new Date(clock += 7 * 60_000).toISOString();
  let lapNumber = 0;
  /**
   * One lap file that is plausible unless told otherwise: the clock, the distance and the sectors match timeMs and the track, the
   * speed is steady, and the header's sample rate matches the number of samples. The options bend one thing at a time.
   */
  const makeLap = ({ number = ++lapNumber, timeMs = 90_000, valid = true, startedAt = nextStart(), track = 'Test Track', car = 'Test Car', game = 'lmu', trackLength = 5000,
    rate = 2, headerRate, count, sectorsMs, tScale = 1, distScale = 1, speed, speedAt, noSpeed = false, noLength = false, tweakT, ...header } = {}) => {
    const samples = count ?? Math.round(rate * timeMs / 1000) + 1;
    const t = new Float32Array(samples), dist = new Float32Array(samples), spd = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      t[i] = (i * (timeMs / 1000) / (samples - 1)) * tScale;
      dist[i] = (i * trackLength / (samples - 1)) * distScale;
      spd[i] = speed ?? trackLength / (timeMs / 1000);
    }
    for (const [i, value] of Object.entries(speedAt ?? {})) spd[i] = value;
    tweakT?.(t);
    const third = Math.floor(timeMs / 3);
    const sectors = sectorsMs === false ? undefined : sectorsMs ?? [third, third, timeMs - 2 * third];
    const channels = [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }, ...(noSpeed ? [] : [{ id: 'speed', unit: 'm/s' }])];
    return gzipLap({
      header: {
        game, track: { name: track, ...(noLength ? {} : { lengthM: trackLength }) }, car: { name: car },
        lap: { number, timeMs, valid, ...(sectors ? { sectorsMs: sectors } : {}) }, startedAt, sampleRateHz: headerRate ?? rate, sampleCount: samples, channels, ...header,
      },
      data: { t, dist, ...(noSpeed ? {} : { speed: spd }) },
    });
  };
  const rigs = {};
  for (const name of Object.keys(people)) rigs[name] = await deviceFor(tokens[name], `RIG ${name}`);
  let sent = 0;
  const put = async (who, spec = {}) => {
    if (++sent % 40 === 0) await resetRates();
    const r = await upload(rigs[who].token, await makeLap(spec));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  const lapRow = async (id) => (await direct.query('SELECT * FROM public.sim_laps WHERE id = $1', [id])).rows[0];
  const catalog = async (game, track, car) => ({
    track: (await direct.query('SELECT id FROM public.sim_track_catalog WHERE game = $1 AND name = $2', [game, track])).rows[0]?.id,
    car: (await direct.query('SELECT id FROM public.sim_car_catalog WHERE game = $1 AND name = $2', [game, car])).rows[0]?.id,
  });
  const board = async (who, game, track, car, extra = '') => {
    const c = await catalog(game, track, car);
    return api[who](`/leaderboard?track=${c.track}&car=${c.car}${extra}`);
  };
  const entryHandles = (r) => r.body.entries.map((e) => e.handle);
  /** Drivers that exist only in the database (no sign-in): an account, a public profile and one lap on a board. */
  const fakeDrivers = async (count, prefix, { track, car, game = 'lmu', startMs = 100_000, step = 10, visibility = 'public' }) => {
    const made = await direct.query(
      `WITH a AS (INSERT INTO public.app_accounts(id, email) SELECT gen_random_uuid(), 'fake-' || $1::text || '-' || g || '@example.com' FROM generate_series(1, $2::int) g RETURNING id)
       INSERT INTO public.sim_profiles(user_id, handle, display_name, visibility)
       SELECT id, $1::text || '_' || lpad(row_number() OVER ()::text, 3, '0'), 'Fake ' || $1::text, $3 FROM a RETURNING user_id, handle`, [prefix, count, visibility]);
    if (track) {
      await direct.query(
        `INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path, plausible, plausibility)
         SELECT p.user_id, 'fake|' || p.user_id, $1, $2, $3, 1, $4::int + (row_number() OVER (ORDER BY p.handle)) * $5::int, true, now(), 3, 100, 'fake/' || p.user_id, true, '{"v":1,"failed":[]}'::jsonb
         FROM public.sim_profiles p WHERE p.handle LIKE $6`, [game, track, car, startMs, step, `${prefix}\\_%`]);
    }
    return made.rows;
  };
  const listAll = async (who, path, key, extra = '') => {
    const seen = []; let cursor = null, pages = 0;
    do {
      const r = await api[who](`${path}?limit=2${extra}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      seen.push(...r.body[key]); cursor = r.body.nextCursor; pages++;
    } while (cursor && pages < 100);
    return seen;
  };
  ready = true;

  // ================================================================== profiles

  await check('profile: created lazily by a read with a generated handle and name, never from the e-mail, the account name or the phone', async () => {
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_profiles WHERE user_id = $1', [ids.A])).rows[0].n, 0, 'nothing is made at sign-up');
    const first = await api.A('/profile');
    assert.equal(first.status, 200);
    const profile = first.body.profile;
    assert.match(profile.handle, /^driver_[a-z0-9]{6}$/);
    assert.equal(profile.displayName, `Driver ${profile.handle.slice(7, 11).toUpperCase()}`);
    assert.equal(profile.visibility, 'public', 'public by default');
    assert.deepEqual([profile.handleChangesLeft, profile.handleChangesResetAt], [3, null]);
    assert.match(profile.createdAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    assert.deepEqual(Object.keys(profile).sort(), ['createdAt', 'displayName', 'handleChangesLeft', 'handleChangesResetAt', 'handle', 'visibility'].sort());
    for (const secret of secrets) assert.ok(!JSON.stringify(profile).toLowerCase().includes(secret.toLowerCase()));
    assert.equal((await api.A('/profile')).body.profile.handle, profile.handle, 'the same one every time');
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_profiles WHERE user_id = $1', [ids.A])).rows[0].n, 1);
    // Every account gets its own.
    const other = (await api.B('/profile')).body.profile;
    assert.notEqual(other.handle, profile.handle);
    // Signed out, or with a device key: 401.
    for (const bearer of [undefined, 'nope', rigs.A.token]) problem(await call(v1, '/api/sim/v1/profile', { bearer }), 401, 'unauthorized');
    problem(await api.A('/profile', { method: 'DELETE' }), 405, 'method_not_allowed');
  });

  await check('profile: the first uploaded lap creates the profile too', async () => {
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_profiles WHERE user_id = $1', [ids.F])).rows[0].n, 0);
    const id = await put('F', { track: 'First Ring', car: 'First Car' });
    const row = (await direct.query('SELECT handle, display_name, visibility FROM public.sim_profiles WHERE user_id = $1', [ids.F])).rows[0];
    assert.match(row.handle, /^driver_[a-z0-9]{6}$/);
    assert.deepEqual([row.display_name.startsWith('Driver '), row.visibility], [true, 'public']);
    assert.equal((await lapRow(id)).plausible, true);
    assert.equal((await api.F('/profile')).body.profile.handle, row.handle, 'and the read finds it');
    // A duplicate upload does not make another.
    await put('F', { track: 'First Ring', car: 'First Car' });
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_profiles WHERE user_id = $1', [ids.F])).rows[0].n, 1);
  });

  await check('profile: handle rules (format, reserved words, taken, case) and the limit of 3 changes in 30 days', async () => {
    const patch = (who, body) => api[who]('/profile', { method: 'PATCH', body });
    await api.A('/profile'); await api.B('/profile');
    for (const bad of ['ab', 'a'.repeat(25), 'bad-handle', 'has space', 'ünïcode', '', 'a@b.co', 12, null, ['x']]) problem(await patch('A', { handle: bad }), 400, 'invalid_handle');
    for (const word of ['admin', 'xpeed_fan', 'support', 'REQUESTS', 'moderator1', 'driver']) problem(await patch('A', { handle: word }), 400, 'reserved_handle');
    assert.ok(RESERVED_HANDLES.has('admin') && RESERVED_HANDLES.has('xpeed') && RESERVED_HANDLES.has('requests'));
    // Typed in capitals it is read as lower case, and it counts as one change.
    let r = await patch('A', { handle: ' Speedy_Ana ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.profile.handle, r.body.profile.handleChangesLeft], ['speedy_ana', 2]);
    // Taken: 409, and it does not use up one of B's changes. A's own handle in another case is also taken.
    problem(await patch('B', { handle: 'speedy_ana' }), 409, 'handle_taken');
    problem(await patch('B', { handle: 'SPEEDY_ANA' }), 409, 'handle_taken');
    assert.equal((await profileOf('B')).handleChangesLeft, 3);
    // The same handle again is not a change.
    assert.equal((await patch('A', { handle: 'speedy_ana' })).body.profile.handleChangesLeft, 2);
    assert.equal((await patch('A', { handle: 'ana_two' })).body.profile.handleChangesLeft, 1);
    r = await patch('A', { handle: 'ana_three' });
    assert.deepEqual([r.status, r.body.profile.handleChangesLeft], [200, 0]);
    assert.ok(Date.parse(r.body.profile.handleChangesResetAt) > Date.now() + 29 * 86_400_000, 'the oldest change leaves the window in about 30 days');
    r = await patch('A', { handle: 'ana_four' });
    problem(r, 429, 'handle_change_limit');
    assert.ok(Number(r.headers.get('retry-after')) > 29 * 86_400, 'Retry-After says when a change is free again');
    assert.equal((await profileOf('A')).handle, 'ana_three', 'the refused change did nothing');
    // The name and the visibility are not limited by it.
    assert.equal((await patch('A', { displayName: 'Ana Rápida' })).status, 200);
    assert.equal((await patch('A', { visibility: 'friends' })).body.profile.visibility, 'friends');
    // The old handle is free for others, and the oldest change aging out opens a slot.
    assert.equal((await patch('B', { handle: 'speedy_ana' })).status, 200);
    await direct.query("UPDATE public.sim_handle_changes SET changed_at = now() - interval '31 days' WHERE user_id = $1 AND changed_at = (SELECT min(changed_at) FROM public.sim_handle_changes WHERE user_id = $1)", [ids.A]);
    assert.equal((await profileOf('A')).handleChangesLeft, 1);
    assert.equal((await patch('A', { handle: 'ana_four' })).status, 200);
  });

  await check('profile: display name and field rules', async () => {
    const patch = (body) => api.A('/profile', { method: 'PATCH', body });
    for (const bad of ['', '   ', 'x'.repeat(41), 'bell\u0007', 'tab\there', 'zero​width', 'rtl‮evil', 'me@example.com', 'line\nbreak', 7, null]) problem(await patch({ displayName: bad }), 400, 'invalid_display_name');
    assert.equal([...readDisplayName('x'.repeat(40))].length, 40);
    for (const good of ['Zé "Pé de Chumbo" 🏎', '  Padded Name  ', '速い車', 'a']) assert.equal((await patch({ displayName: good })).status, 200, good);
    assert.equal((await profileOf('A')).displayName, 'a');
    assert.equal((await patch({ displayName: 'Padded Name  ' })).body.profile.displayName, 'Padded Name', 'trimmed');
    // The emoji name is stored whole: 18 code points, not cut by UTF-16 units.
    assert.equal((await patch({ displayName: 'Zé "Pé de Chumbo" 🏎' })).body.profile.displayName, 'Zé "Pé de Chumbo" 🏎');
    for (const bad of ['secret', 'PUBLIC', '', null, 1]) problem(await patch({ visibility: bad }), 400, 'invalid_visibility');
    problem(await patch({}), 400, 'invalid_request');
    problem(await patch({ email: 'x@y.co' }), 400, 'invalid_request');
    problem(await patch({ displayName: 'ok', admin: true }), 400, 'invalid_request');
    problem(await api.A('/profile', { method: 'PATCH', body: 'not json' }), 400, 'invalid_body');
    problem(await api.A('/profile', { method: 'PATCH', body: '[1]' }), 400, 'invalid_body');
    problem(await api.A('/profile', { method: 'PATCH' }), 400, 'invalid_body');
    assert.equal(readHandle('%41na_x', true), 'ana_x');
    assert.equal(readHandle('%41na_x'), null, 'a body is not URL decoded');
    assert.equal(readHandle('%zz', true), null);
    // The database refuses what the API would have, too.
    // (Straight into the database engine: PGlite's socket server drops the connection after some failed statements.)
    for (const [handle, name, visibility] of [['Bad-Handle', 'Fine', 'public'], ['ab', 'Fine', 'public'], ['ok_handle', 'Fine', 'everyone'], ['ok_handle', 'x'.repeat(41), 'public'], ['ok_handle', 'bell', 'public']]) {
      await assert.rejects(db.query('INSERT INTO public.sim_profiles(user_id, handle, display_name, visibility) VALUES ($1, $2, $3, $4)', [ids.D, handle, name, visibility]), /check constraint/, `${handle} / ${name.length} / ${visibility}`);
    }
  });

  // ================================================================== visibility

  await check('visibility matrix: what a stranger, a friend, a blocked person and the owner see changes with public, friends and private', async () => {
    await api.A('/profile'); await api.B('/profile'); await api.C('/profile'); await api.D('/profile');
    const ha = (await profileOf('A')).handle;
    for (const who of ['A', 'B']) await put(who, { track: 'Matrix Ring', car: 'Matrix Car', timeMs: who === 'A' ? 90_000 : 91_000 });
    await befriend('A', 'B');
    // D is blocked by A.
    assert.equal((await api.A(`/friends/${(await profileOf('D')).handle}/block`, { method: 'POST' })).status, 200);
    const stranger404 = await api.C('/profiles/nobody_here');
    problem(stranger404, 404, 'profile_not_found');
    const unknownRequest = await api.C('/friends/requests', { method: 'POST', body: { handle: 'nobody_here' } });
    problem(unknownRequest, 404, 'handle_not_found');

    // viewer -> [profile page, A on the public board, A on the friends board of that viewer, a friend request by handle]
    const expected = {
      public: { self: [200, true, true, 'self'], friend: [200, true, true, 'exists'], stranger: [200, true, false, 201], blocked: [404, false, false, 404] },
      friends: { self: [200, false, true, 'self'], friend: [200, false, true, 'exists'], stranger: [404, false, false, 201], blocked: [404, false, false, 404] },
      private: { self: [200, false, true, 'self'], friend: [404, false, false, 'exists'], stranger: [404, false, false, 404], blocked: [404, false, false, 404] },
    };
    const viewers = { self: 'A', friend: 'B', stranger: 'C', blocked: 'D' };
    for (const visibility of ['public', 'friends', 'private']) {
      await setVisibility('A', visibility);
      for (const [role, who] of Object.entries(viewers)) {
        const [pageStatus, onPublic, onFriends, request] = expected[visibility][role];
        const label = `${visibility} / ${role}`;
        const page = await api[who](`/profiles/${ha}`);
        assert.equal(page.status, pageStatus, `${label}: page`);
        if (pageStatus === 404) problem(page, 404, 'profile_not_found');
        else assert.deepEqual([page.body.profile.handle, page.body.profile.isMe], [ha, role === 'self']);
        const pub = await board(who, 'lmu', 'Matrix Ring', 'Matrix Car');
        assert.equal(entryHandles(pub).includes(ha), onPublic, `${label}: public board`);
        const friends = await board(who, 'lmu', 'Matrix Ring', 'Matrix Car', '&scope=friends');
        assert.equal(entryHandles(friends).includes(ha), onFriends, `${label}: friends board`);
        // A request by handle: private looks exactly like an unknown handle; a block hides too.
        if (typeof request === 'number') {
          const asked = await api[who]('/friends/requests', { method: 'POST', body: { handle: ha } });
          if (request === 404) assert.deepEqual([asked.status, asked.body], [unknownRequest.status, unknownRequest.body], `${label}: request`);
          else assert.equal(asked.status, request, `${label}: request`);
          await direct.query('DELETE FROM public.sim_friendships WHERE requested_by = $1 AND status = $2', [ids[who], 'pending']);
        }
      }
    }
    // The page of a viewer who may see it carries the relation, and the owner alone sees their own visibility.
    await setVisibility('A', 'friends');
    assert.equal((await api.B(`/profiles/${ha}`)).body.profile.relation, 'friend');
    assert.equal((await api.B(`/profiles/${ha}`)).body.profile.visibility, null, 'a friend is not told the visibility');
    assert.equal((await api.A(`/profiles/${ha}`)).body.profile.visibility, 'friends');
    // A friend of a friends profile still sees the name in the friend list; a stranger with a pending request does not.
    assert.equal((await api.B('/friends')).body.friends[0].displayName, (await profileOf('A')).displayName);
    // Going private takes the name out of the list but keeps the friendship (they can still remove it).
    await setVisibility('A', 'private');
    const list = (await api.B('/friends')).body.friends;
    assert.deepEqual([list.length, list[0].handle, list[0].displayName], [1, ha, null]);
    assert.equal((await api.B(`/friends/${ha}`, { method: 'DELETE' })).status, 204);
  });

  // ================================================================== friends

  await check('friends: request, accept, decline, remove, cancel and block through the API, and what each side sees', async () => {
    const [ha, hb, hc, hd] = await Promise.all(['A', 'B', 'C', 'D'].map(async (who) => (await profileOf(who)).handle));
    const lists = async (who, status) => (await api[who](`/friends?status=${status}`)).body.friends;
    // B asks A.
    let r = await api.B('/friends/requests', { method: 'POST', body: { handle: ha } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.friend).sort(), ['displayName', 'handle', 'since', 'status']);
    assert.deepEqual([r.body.friend.handle, r.body.friend.status], [ha, 'outgoing']);
    problem(await api.B('/friends/requests', { method: 'POST', body: { handle: ha } }), 409, 'already_requested');
    assert.deepEqual((await lists('B', 'outgoing')).map((f) => f.handle), [ha]);
    assert.deepEqual((await lists('A', 'incoming')).map((f) => [f.handle, f.status, f.displayName]), [[hb, 'incoming', (await profileOf('B')).displayName]]);
    assert.deepEqual(await lists('A', 'accepted'), []);
    // A declines: it is gone, and B may ask again.
    assert.equal((await api.A(`/friends/requests/${hb}/decline`, { method: 'POST' })).status, 204);
    assert.deepEqual([await lists('A', 'incoming'), await lists('B', 'outgoing')], [[], []]);
    problem(await api.A(`/friends/requests/${hb}/decline`, { method: 'POST' }), 404, 'request_not_found');
    problem(await api.A(`/friends/requests/${hb}/accept`, { method: 'POST' }), 404, 'request_not_found');
    assert.equal((await api.B('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    // The one who asked cannot accept their own request.
    problem(await api.B(`/friends/requests/${ha}/accept`, { method: 'POST' }), 404, 'request_not_found');
    r = await api.A(`/friends/requests/${hb}/accept`, { method: 'POST' });
    assert.deepEqual([r.status, r.body.friend.handle, r.body.friend.status], [200, hb, 'accepted']);
    assert.deepEqual([(await lists('A', 'accepted')).map((f) => f.handle), (await lists('B', 'accepted')).map((f) => f.handle)], [[hb], [ha]]);
    problem(await api.B('/friends/requests', { method: 'POST', body: { handle: ha } }), 409, 'already_friends');
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: hb } }), 409, 'already_friends');
    // Stored as one row, the lower id first.
    const rows = (await direct.query('SELECT user_a, user_b, requested_by, status FROM public.sim_friendships')).rows;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].user_a < rows[0].user_b);
    assert.deepEqual([rows[0].status, rows[0].requested_by], ['accepted', ids.B]);
    // Either side removes it.
    assert.equal((await api.A(`/friends/${hb}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual([await lists('A', 'accepted'), await lists('B', 'accepted')], [[], []]);
    problem(await api.A(`/friends/${hb}`, { method: 'DELETE' }), 404, 'friend_not_found');
    await befriend('A', 'B');
    assert.equal((await api.B(`/friends/${ha}`, { method: 'DELETE' })).status, 204, 'the other side can remove too');

    // Two requests that cross become a friendship.
    assert.equal((await api.C('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    r = await api.A('/friends/requests', { method: 'POST', body: { handle: hc } });
    assert.deepEqual([r.status, r.body.friend.status], [200, 'accepted']);
    assert.equal((await api.A(`/friends/${hc}`, { method: 'DELETE' })).status, 204);
    // A request can be withdrawn by its sender.
    assert.equal((await api.D('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    assert.equal((await api.D(`/friends/${ha}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await lists('A', 'incoming'), []);

    // Block: whatever there was is replaced; the blocked person is told nothing.
    await befriend('A', 'C');
    r = await api.A(`/friends/${hc}/block`, { method: 'POST' });
    assert.deepEqual([r.status, r.body.friend.handle, r.body.friend.status], [200, hc, 'blocked']);
    assert.deepEqual([(await lists('A', 'accepted')).length, (await lists('A', 'blocked')).map((f) => f.handle)], [0, [hc]]);
    assert.deepEqual([(await lists('C', 'accepted')).length, (await lists('C', 'blocked')).length], [0, 0]);
    problem(await api.C('/friends/requests', { method: 'POST', body: { handle: ha } }), 404, 'handle_not_found');
    problem(await api.C(`/profiles/${ha}`), 404, 'profile_not_found');
    problem(await api.A(`/profiles/${hc}`), 404, 'profile_not_found');
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: hc } }), 409, 'blocked');
    problem(await api.C(`/friends/${ha}`, { method: 'DELETE' }), 404, 'friend_not_found');
    assert.equal((await api.C(`/friends/${ha}/block`, { method: 'POST' })).status, 200, 'blocking back changes nothing and tells nothing');
    assert.equal((await direct.query('SELECT blocked_by FROM public.sim_friendships')).rows[0].blocked_by, ids.A);
    // Blocking someone with no relation at all, and lifting a block.
    r = await api.A(`/friends/${hd}/block`, { method: 'POST' });
    assert.deepEqual([r.status, r.body.friend.status], [200, 'blocked']);
    assert.equal((await api.A(`/friends/${hc}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api.C('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201, 'after the block is lifted they may ask again');
    // Yourself.
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: ha } }), 400, 'invalid_target');
    problem(await api.A(`/friends/${ha}/block`, { method: 'POST' }), 400, 'invalid_target');
    problem(await api.A(`/friends/${ha}`, { method: 'DELETE' }), 404, 'friend_not_found');
    // Bad input.
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: 'no' } }), 404, 'handle_not_found');
    problem(await api.A('/friends/requests', { method: 'POST', body: {} }), 404, 'handle_not_found');
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: ha, extra: 1 } }), 400, 'invalid_request');
    problem(await api.A('/friends?status=all'), 400, 'invalid_status');
    problem(await api.A('/friends/requests'), 405, 'method_not_allowed');
    problem(await api.A('/friends/x/y/z'), 404, 'not_found');
  });

  await check('friends: at most 200 friends and 50 pending requests, and a private profile cannot be probed', async () => {
    const [ha, hb, hc, hd] = await Promise.all(['A', 'B', 'C', 'D'].map(async (who) => (await profileOf(who)).handle));
    // 200 friends for A, written straight into the database; the 201st is refused by the API.
    const bulk = await fakeDrivers(201, 'bulk', {});
    await direct.query(
      `INSERT INTO public.sim_friendships(user_a, user_b, requested_by, status, decided_at)
       SELECT least($1::uuid, p.user_id), greatest($1::uuid, p.user_id), p.user_id, 'accepted', now() FROM public.sim_profiles p WHERE p.handle LIKE 'bulk\\_%' AND p.handle <> $2`, [ids.A, bulk[200].handle]);
    assert.equal((await api.A('/friends?limit=100')).body.friends.length, 100);
    assert.equal((await direct.query("SELECT public.sim_friend_count($1) AS n", [ids.A])).rows[0].n, 200);
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: hb } }), 422, 'friend_limit');
    // Someone asks A (they are well under the limit); A cannot accept, nor can the two requests cross.
    assert.equal((await api.B('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    problem(await api.A(`/friends/requests/${hb}/accept`, { method: 'POST' }), 422, 'friend_limit');
    problem(await api.A('/friends/requests', { method: 'POST', body: { handle: hb } }), 422, 'friend_limit');
    // One friend leaves and it works.
    assert.equal((await api.A(`/friends/${bulk[0].handle}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api.A(`/friends/requests/${hb}/accept`, { method: 'POST' })).status, 200);
    // 50 pending requests sent by C; the 51st is refused. A pending request received does not count against the receiver.
    await direct.query(
      `INSERT INTO public.sim_friendships(user_a, user_b, requested_by, status)
       SELECT least($1::uuid, p.user_id), greatest($1::uuid, p.user_id), $1::uuid, 'pending' FROM public.sim_profiles p WHERE p.handle LIKE 'bulk\\_%' ORDER BY p.handle LIMIT 50 OFFSET 100`, [ids.C]);
    problem(await api.C('/friends/requests', { method: 'POST', body: { handle: hd } }), 422, 'pending_limit');
    assert.equal((await api.C('/friends?status=outgoing&limit=100')).body.friends.length, 50);
    assert.equal((await api.D('/friends/requests', { method: 'POST', body: { handle: hc } })).status, 201, 'a person with 50 incoming still receives');
    // A private profile gives the same answers as a handle nobody has: for a request, a block, a page and a report.
    await setVisibility('D', 'private');
    const probe = async (who, handle) => ({
      request: await api[who]('/friends/requests', { method: 'POST', body: { handle } }),
      block: await api[who](`/friends/${handle}/block`, { method: 'POST' }),
      page: await api[who](`/profiles/${handle}`),
      report: await api[who]('/reports', { method: 'POST', body: { kind: 'profile', handle, reason: 'spam' } }),
    });
    await direct.query('DELETE FROM public.sim_friendships');
    const ghost = await probe('B', 'nobody_has_this');
    const priv = await probe('B', hd);
    for (const key of Object.keys(ghost)) assert.deepEqual([priv[key].status, priv[key].body], [ghost[key].status, ghost[key].body], key);
    assert.deepEqual([ghost.request.status, ghost.request.body.error, ghost.page.body.error, ghost.report.body.error], [404, 'handle_not_found', 'profile_not_found', 'target_not_found']);
    // A hidden profile (moderation) is the same.
    await setVisibility('D', 'public');
    await direct.query('UPDATE public.sim_profiles SET hidden = true WHERE user_id = $1', [ids.D]);
    const hidden = await probe('B', hd);
    for (const key of Object.keys(ghost)) assert.deepEqual([hidden[key].status, hidden[key].body], [ghost[key].status, ghost[key].body], `hidden ${key}`);
    await direct.query("DELETE FROM public.sim_friendships; DELETE FROM public.app_accounts WHERE email LIKE 'fake-bulk-%'");
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM public.sim_profiles WHERE handle LIKE 'bulk\\_%'")).rows[0].n, 0, 'the fixtures went with their accounts');
    void hc;
  });

  // ================================================================== plausibility

  await check('plausibility: a good lap is plausible, and each failed check is flagged with its numbers, at its threshold', async () => {
    assert.deepEqual([...CHECKS], ['sector_sum', 'elapsed_time', 'distance', 'speed_range', 'sample_count', 'time_gap']);
    const verdict = async (spec) => {
      const id = await put('D', { track: 'Plausible Ring', car: 'Plausible Car', ...spec });
      const row = await lapRow(id);
      assert.deepEqual(row.plausibility.v, 1);
      assert.equal(row.plausible, row.plausibility.failed.length === 0);
      return row.plausibility.failed;
    };
    const names = (failed) => failed.map((f) => f.check);
    assert.deepEqual(await verdict({}), [], 'a lap with everything in order');
    // 1. sectors add up to the lap time (+- 50 ms)
    assert.deepEqual(await verdict({ sectorsMs: [30000, 30000, 30050] }), [], '50 ms off is allowed');
    let failed = await verdict({ sectorsMs: [30000, 30000, 30051] });
    assert.deepEqual(names(failed), ['sector_sum']);
    assert.deepEqual(failed[0].detail, { sectorsSumMs: 90051, lapMs: 90000, toleranceMs: PLAUSIBILITY.sectorSumToleranceMs });
    assert.deepEqual(names(await verdict({ sectorsMs: [20000, 20000, 20000] })), ['sector_sum']);
    assert.deepEqual(await verdict({ sectorsMs: false }), [], 'no sectors, nothing to add up');
    // 2. the t channel matches the lap time (0.5 %)
    assert.deepEqual(await verdict({ tScale: 1.004 }), [], '0.4 % off is allowed');
    failed = await verdict({ tScale: 1.006 });
    assert.deepEqual(names(failed), ['elapsed_time']);
    assert.deepEqual([failed[0].detail.lapMs, failed[0].detail.allowedMs, failed[0].detail.elapsedMs > 90_400], [90000, 450, true]);
    assert.deepEqual(names(await verdict({ tScale: 0.9 })), ['elapsed_time'], 'a lap whose clock ran short');
    // 3. the distance matches the track length (3 %)
    assert.deepEqual(await verdict({ distScale: 1.029 }), []);
    failed = await verdict({ distScale: 1.031 });
    assert.deepEqual(names(failed), ['distance']);
    assert.deepEqual([failed[0].detail.trackLengthM, failed[0].detail.allowedM], [5000, 150]);
    assert.deepEqual(names(await verdict({ distScale: 0.5 })), ['distance']);
    assert.deepEqual(await verdict({ distScale: 2, noLength: true }), [], 'no track length in the header, nothing to compare');
    // 4. no speed above 150 m/s or below 0
    assert.deepEqual(await verdict({ speedAt: { 5: 150 } }), [], '150 m/s itself is allowed');
    failed = await verdict({ speedAt: { 5: 150.5 } });
    assert.deepEqual(names(failed), ['speed_range']);
    assert.deepEqual([failed[0].detail.samples, failed[0].detail.maxMs, failed[0].detail.limitMs], [1, 150.5, 150]);
    assert.deepEqual(names(await verdict({ speedAt: { 7: -0.5 } })), ['speed_range'], 'a negative speed');
    assert.deepEqual(await verdict({ noSpeed: true }), [], 'no speed channel, nothing to check');
    // 5. the sample rate and the sample count agree with the lap time
    assert.deepEqual(await verdict({ headerRate: 2.01 }), []);
    failed = await verdict({ headerRate: 60 });
    assert.deepEqual(names(failed), ['sample_count']);
    assert.deepEqual([failed[0].detail.sampleCount, failed[0].detail.expected, failed[0].detail.sampleRateHz], [181, 5400, 60]);
    assert.deepEqual(names(await verdict({ headerRate: 0.5 })), ['sample_count'], 'far fewer samples than the rate says');
    // 6. no gap in the clock over 2 s, and it never runs backwards
    assert.deepEqual(await verdict({ rate: 0.5 }), [], 'a step of exactly 2 s is allowed');
    failed = await verdict({ rate: 0.4 });
    assert.deepEqual(names(failed), ['time_gap']);
    assert.deepEqual([failed[0].detail.largestGapS, failed[0].detail.limitS], [2.5, 2]);
    failed = await verdict({ tweakT: (t) => { t[90] = t[89] - 0.2; } });
    assert.deepEqual([names(failed), failed[0].detail.backwardsSteps], [['time_gap'], 1]);
    // Several at once are all listed.
    assert.deepEqual(names(await verdict({ sectorsMs: [1, 2, 3], distScale: 2, speedAt: { 1: 999 } })).sort(), ['distance', 'sector_sum', 'speed_range']);
    // The upload is accepted whatever the verdict: the lap is the driver's, it just does not rank.
    const bad = await put('D', { track: 'Plausible Ring', car: 'Plausible Car', tScale: 1.5 });
    assert.equal((await lapRow(bad)).plausible, false);
    assert.equal((await api.D('/laps?game=lmu&limit=100')).body.laps.some((l) => l.id === bad), true, 'still in the driver\'s own list');
    // The pure function agrees with what was stored (the same code runs for laps read back from the file).
    const bytes = await makeLap({ speedAt: { 3: 300 } });
    assert.deepEqual(checkPlausibility(await gunzipLap(bytes)).failed.map((f) => f.check), ['speed_range']);
  });

  // ================================================================== leaderboards

  await check('leaderboard: only valid, plausible laps of public drivers, the best per driver, ranked with ties, gaps and cursor paging', async () => {
    const T = { track: 'Board Ring', car: 'Board Car' };
    const ha = (await profileOf('A')).handle, hb = (await profileOf('B')).handle, hc = (await profileOf('C')).handle, hd = (await profileOf('D')).handle, he = (await profileOf('E')).handle;
    const hf = (await profileOf('F')).handle;
    await put('A', { ...T, timeMs: 90_000 });
    await put('A', { ...T, timeMs: 99_000 });                  // slower: not A's best
    await put('B', { ...T, timeMs: 91_000 });
    await put('B', { ...T, timeMs: 80_000, valid: false });    // faster but invalid
    await put('B', { ...T, timeMs: 95_000 });
    await put('C', { ...T, timeMs: 91_000 });                  // ties with B, later
    await put('D', { ...T, timeMs: 70_000, tScale: 1.1 });     // the fastest, but not believable
    await put('E', { ...T, timeMs: 85_000 });                  // fast, but E will be private
    await put('F', { ...T, timeMs: 92_000 });                  // F is the fourth: rank 4 after the tie
    await setVisibility('E', 'private');
    await put('A', { track: 'Board Ring', car: 'Other Board Car', timeMs: 60_000 }); // another car never mixes
    const r = await board('C', 'lmu', T.track, T.car);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['car', 'entries', 'game', 'nextCursor', 'scope', 'track']);
    assert.deepEqual([r.body.game, r.body.scope, r.body.track.name, r.body.track.lengthM, r.body.car.name, r.body.nextCursor], ['lmu', 'public', 'Board Ring', 5000, 'Board Car', null]);
    assert.deepEqual(entryHandles(r), [ha, hb, hc, hf], 'D (implausible), E (private) and the invalid lap are not there; the tie is in the order of the laps');
    assert.deepEqual(r.body.entries.map((e) => [e.rank, e.timeMs, e.gapMs]), [[1, 90_000, 0], [2, 91_000, 1000], [2, 91_000, 1000], [4, 92_000, 2000]], 'ties share a rank, the next is 4');
    assert.deepEqual(r.body.entries.map((e) => e.isMe), [false, false, true, false]);
    assert.deepEqual(Object.keys(r.body.entries[0]).sort(), ['achievedAt', 'displayName', 'gapMs', 'handle', 'isMe', 'lapId', 'rank', 'timeMs']);
    assert.equal((await lapRow(r.body.entries[1].lapId)).time_ms, 91_000, 'the lap id is the lap that counts');
    assert.match(r.body.entries[0].achievedAt, /^\d{4}-\d{2}-\d{2}T/);
    // The same board for everybody except the "isMe" flag.
    const asA = await board('A', 'lmu', T.track, T.car);
    assert.deepEqual(asA.body.entries.map((e) => [e.handle, e.isMe]), [[ha, true], [hb, false], [hc, false], [hf, false]]);
    // Paging: two at a time, none twice, none missing, the same order as the whole list.
    const paged = await listAll('C', '/leaderboard', 'entries', `&track=${r.body.track.id}&car=${r.body.car.id}`);
    assert.deepEqual(paged.map((e) => e.handle), [ha, hb, hc, hf]);
    assert.deepEqual(paged.map((e) => e.rank), [1, 2, 2, 4]);
    const first = await board('C', 'lmu', T.track, T.car, '&limit=1');
    assert.equal(first.body.entries.length, 1);
    assert.ok(first.body.nextCursor);
    // A cursor in the middle of a tie continues with the other one of the tie.
    const second = await board('C', 'lmu', T.track, T.car, `&limit=1&cursor=${first.body.nextCursor}`);
    const third = await board('C', 'lmu', T.track, T.car, `&limit=1&cursor=${second.body.nextCursor}`);
    assert.deepEqual([second.body.entries[0].handle, third.body.entries[0].handle], [hb, hc]);
    // The caller's own rank and neighbours.
    const me = await api.B(`/leaderboard/me?track=${r.body.track.id}&car=${r.body.car.id}`);
    assert.equal(me.status, 200);
    assert.deepEqual([me.body.total, me.body.me.rank, me.body.me.handle, me.body.me.timeMs, me.body.me.gapMs, me.body.me.isMe], [4, 2, hb, 91_000, 1000, true]);
    assert.deepEqual([me.body.neighbours.above.map((e) => e.handle), me.body.neighbours.below.map((e) => e.handle)], [[ha], [hc, hf]]);
    assert.equal(me.body.reason, null);
    for (const [who, label] of [['E', 'private'], ['D', 'implausible']]) {
      const out = await api[who](`/leaderboard/me?track=${r.body.track.id}&car=${r.body.car.id}`);
      assert.deepEqual([out.status, out.body.me, out.body.reason, out.body.neighbours, out.body.total], [200, null, 'not_listed', { above: [], below: [] }, 4], label);
    }
    // Inputs.
    problem(await api.C('/leaderboard'), 400, 'invalid_track');
    problem(await api.C(`/leaderboard?track=${r.body.track.id}`), 400, 'invalid_car');
    problem(await api.C(`/leaderboard?track=nope&car=${r.body.car.id}`), 400, 'invalid_track');
    problem(await api.C(`/leaderboard?track=00000000-0000-4000-8000-000000000000&car=${r.body.car.id}`), 404, 'track_not_found');
    problem(await api.C(`/leaderboard?track=${r.body.track.id}&car=00000000-0000-4000-8000-000000000000`), 404, 'car_not_found');
    problem(await board('C', 'lmu', T.track, T.car, '&scope=everyone'), 400, 'invalid_scope');
    problem(await board('C', 'lmu', T.track, T.car, '&limit=0'), 400, 'invalid_limit');
    problem(await board('C', 'lmu', T.track, T.car, '&cursor=garbage'), 400, 'invalid_cursor');
    problem(await board('C', 'lmu', T.track, T.car, '&game=acc'), 400, 'invalid_game');
    assert.equal((await board('C', 'lmu', T.track, T.car, '&game=lmu')).status, 200);
    problem(await call(v1, `/api/sim/v1/leaderboard?track=${r.body.track.id}&car=${r.body.car.id}`), 401, 'unauthorized');
    // Blocking takes a driver off the other's public board.
    assert.equal((await api.C(`/friends/${ha}/block`, { method: 'POST' })).status, 200);
    assert.deepEqual(entryHandles(await board('C', 'lmu', T.track, T.car)), [hb, hc, hf]);
    assert.deepEqual(entryHandles(await board('A', 'lmu', T.track, T.car)), [ha, hb, hf]);
    assert.equal(hd.length > 0 && he.length > 0, true);
  });

  await check('leaderboard: a limit above 100 is read as 100 and a big board pages through to the end without repeats', async () => {
    await api.A('/profile');
    const T = { track: 'Big Ring', car: 'Big Car' };
    const bulk = await fakeDrivers(130, 'big', { ...T, startMs: 100_000, step: 10 });
    assert.equal(bulk.length, 130);
    await put('A', { ...T, timeMs: 99_000 }); // A is first
    const c = await catalog('lmu', T.track, T.car);
    const first = await api.C(`/leaderboard?track=${c.track}&car=${c.car}&limit=1000`);
    assert.equal(first.body.entries.length, 100);
    assert.ok(first.body.nextCursor);
    const second = await api.C(`/leaderboard?track=${c.track}&car=${c.car}&limit=1000&cursor=${first.body.nextCursor}`);
    assert.equal(second.body.entries.length, 31);
    assert.equal(second.body.nextCursor, null);
    const all = [...first.body.entries, ...second.body.entries];
    assert.equal(new Set(all.map((e) => e.handle)).size, 131, 'nobody twice');
    assert.deepEqual(all.map((e) => e.rank), Array.from({ length: 131 }, (_, i) => i + 1), 'ranks 1 to 131, ties aside');
    assert.equal(all[0].timeMs, 99_000, 'A is the fastest');
    assert.equal(all[1].gapMs, 1010, 'the first fixture is 100 010 ms, 1 010 ms behind');
    const mine = await api.A(`/leaderboard/me?track=${c.track}&car=${c.car}`);
    assert.deepEqual([mine.body.me.rank, mine.body.total, mine.body.neighbours.above.length, mine.body.neighbours.below.length], [1, 131, 0, 2]);
    // A driver in the middle has two on each side.
    const mid = bulk[60];
    const viewer = (await direct.query('SELECT public.sim_leaderboard_me($1, $2, $3, $4) AS r', [mid.user_id, c.track, c.car, 'public'])).rows[0].r;
    assert.deepEqual([viewer.me.handle, viewer.above.length, viewer.below.length, viewer.above[1].rank], [mid.handle, 2, 2, viewer.me.rank - 1]);
  });

  await check('leaderboard: friends scope lists the caller and their accepted friends only, and leaves out a private, hidden, blocked or pending friend', async () => {
    const T = { track: 'Friends Ring', car: 'Friends Car' };
    const [ha, hb, hc, hd] = await Promise.all(['A', 'B', 'C', 'D'].map(async (who) => (await profileOf(who)).handle));
    await put('A', { ...T, timeMs: 92_000 }); await put('B', { ...T, timeMs: 90_000 });
    await put('C', { ...T, timeMs: 91_000 }); await put('D', { ...T, timeMs: 89_000 });
    const friends = (who) => board(who, 'lmu', T.track, T.car, '&scope=friends');
    // Nobody is anybody's friend yet: everyone sees only themselves.
    for (const [who, h] of [['A', ha], ['B', hb], ['C', hc], ['D', hd]]) assert.deepEqual(entryHandles(await friends(who)), [h]);
    await befriend('A', 'B'); await befriend('A', 'C');
    const mine = await friends('A');
    assert.deepEqual(entryHandles(mine), [hb, hc, ha], 'the caller and their two friends; D is a stranger');
    assert.deepEqual(mine.body.entries.map((e) => [e.rank, e.gapMs, e.isMe]), [[1, 0, false], [2, 1000, false], [3, 2000, true]], 'ranked among themselves');
    assert.equal(mine.body.scope, 'friends');
    assert.deepEqual(entryHandles(await friends('B')), [hb, ha], 'B is not C\'s friend');
    assert.deepEqual(entryHandles(await friends('D')), [hd]);
    // A pending request is not a friendship.
    assert.equal((await api.D('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    assert.deepEqual(entryHandles(await friends('A')), [hb, hc, ha]);
    // A private friend is left out for the others, but sees only themselves.
    await setVisibility('C', 'private');
    assert.deepEqual(entryHandles(await friends('A')), [hb, ha]);
    assert.deepEqual(entryHandles(await friends('C')), [hc, ha], 'a private driver sees their own row and their friends');
    await setVisibility('C', 'friends');
    assert.deepEqual(entryHandles(await friends('A')), [hb, hc, ha], 'a friends profile shows to friends');
    // Moderation hides a friend everywhere, a block removes the friendship.
    await direct.query('UPDATE public.sim_profiles SET hidden = true WHERE user_id = $1', [ids.B]);
    assert.deepEqual(entryHandles(await friends('A')), [hc, ha]);
    assert.deepEqual(entryHandles(await friends('B')), [ha], 'a hidden driver is on no board, not even their own; they still see their friends');
    await direct.query('UPDATE public.sim_profiles SET hidden = false WHERE user_id = $1', [ids.B]);
    assert.equal((await api.A(`/friends/${hc}/block`, { method: 'POST' })).status, 200);
    assert.deepEqual(entryHandles(await friends('A')), [hb, ha]);
    // The caller's rank on the friends board.
    const me = await api.A(`/leaderboard/me?scope=friends&track=${mine.body.track.id}&car=${mine.body.car.id}`);
    assert.deepEqual([me.body.total, me.body.me.rank, me.body.neighbours.above.map((e) => e.handle)], [2, 2, [hb]]);
  });

  await check('hidden items vanish from every social answer: a hidden lap and a hidden profile, until a moderator shows them again', async () => {
    const T = { track: 'Hidden Ring', car: 'Hidden Car' };
    const [ha, hb] = await Promise.all(['A', 'B'].map(async (who) => (await profileOf(who)).handle));
    const fast = await put('A', { ...T, timeMs: 88_000 });
    const slow = await put('A', { ...T, timeMs: 93_000 });
    await put('B', { ...T, timeMs: 90_000 });
    await befriend('A', 'B');
    const shared = await api.A('/shares', { method: 'POST', body: { lapId: fast } });
    assert.equal(shared.status, 201);
    const where = `/share/${shared.body.token}`;
    assert.equal((await pub(where)).status, 200);
    assert.equal((await api.C(`/profiles/${ha}`)).body.profile.bestLaps.some((l) => l.lapId === fast), true);
    // The moderator hides the fast lap (through a report).
    const report = await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: fast, reason: 'cheating', details: 'impossible corner speed' } });
    assert.equal(report.status, 201, JSON.stringify(report.body));
    const acted = await api.E(`/admin/reports/${report.body.report.id}`, { method: 'POST', body: { action: 'action', hideTarget: true } });
    assert.equal(acted.status, 200, JSON.stringify(acted.body));
    assert.deepEqual([acted.body.report.status, acted.body.report.target.hidden], ['actioned', true]);
    const afterLap = await board('C', 'lmu', T.track, T.car);
    assert.deepEqual(afterLap.body.entries.map((e) => [e.handle, e.timeMs]), [[hb, 90_000], [ha, 93_000]], 'A\'s next lap counts instead');
    assert.equal((await pub(where)).status, 404, 'the share of a hidden lap shows nothing');
    assert.equal((await pub(`${where}/file/${fast}`)).status, 404);
    assert.equal((await api.C(`/profiles/${ha}`)).body.profile.bestLaps.some((l) => l.lapId === fast), false);
    problem(await api.C('/reports', { method: 'POST', body: { kind: 'lap', lapId: fast, reason: 'spam' } }), 404, 'target_not_found');
    problem(await api.A('/shares', { method: 'POST', body: { lapId: fast } }), 404, 'lap_not_found');
    assert.equal((await api.A('/laps?limit=100')).body.laps.some((l) => l.id === fast), true, 'the driver still has their own lap');
    assert.equal((await api.E(`/admin/laps/${fast}`)).body.lap.hidden, true);
    // Hide the profile too: gone from the boards, pages, friend lists, requests and shares.
    const slowShare = await api.A('/shares', { method: 'POST', body: { lapId: slow } });
    const profileReport = await api.C('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'offensive_name' } });
    assert.equal((await api.E(`/admin/reports/${profileReport.body.report.id}`, { method: 'POST', body: { action: 'action', hideTarget: true } })).body.report.target.hidden, true);
    assert.deepEqual(entryHandles(await board('C', 'lmu', T.track, T.car)), [hb]);
    assert.deepEqual(entryHandles(await board('B', 'lmu', T.track, T.car, '&scope=friends')), [hb]);
    assert.deepEqual(entryHandles(await board('A', 'lmu', T.track, T.car, '&scope=friends')), [hb], 'not even on their own board (they still see their friends)');
    problem(await api.C(`/profiles/${ha}`), 404, 'profile_not_found');
    problem(await api.B(`/profiles/${ha}`), 404, 'profile_not_found');
    assert.deepEqual((await api.B('/friends')).body.friends, [], 'a hidden friend is not listed');
    problem(await api.C('/friends/requests', { method: 'POST', body: { handle: ha } }), 404, 'handle_not_found');
    assert.equal((await pub(`/share/${slowShare.body.token}`)).status, 404, 'no share shows a hidden person\'s laps');
    problem(await api.C('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } }), 404, 'target_not_found');
    // A moderator shows them again.
    assert.equal((await api.E(`/admin/reports/${profileReport.body.report.id}`, { method: 'POST', body: { action: 'unhide' } })).status, 200);
    assert.equal((await api.E(`/admin/reports/${report.body.report.id}`, { method: 'POST', body: { action: 'unhide' } })).status, 200);
    assert.deepEqual(entryHandles(await board('C', 'lmu', T.track, T.car)), [ha, hb]);
    assert.equal((await api.C(`/profiles/${ha}`)).status, 200);
    assert.equal((await pub(`/share/${slowShare.body.token}`)).status, 200);
  });

  // ================================================================== sharing

  await check('sharing: a link works with no sign-in, shows the driver unless private, and stops when hidden, expired, revoked or the lap is deleted', async () => {
    const [ha] = [(await profileOf('A')).handle];
    const bytes = await makeLap({ track: 'Share Ring', car: 'Share Car', timeMs: 91_234, number: 7, startedAt: '2026-11-05T10:00:00.000Z', sectorsMs: [30_000, 30_000, 31_234] });
    const up = await upload(rigs.A.token, bytes);
    assert.equal(up.status, 201);
    const lapId = up.body.id;
    const other = await put('A', { track: 'Share Ring', car: 'Share Car', timeMs: 95_000 });
    const made = await api.A('/shares', { method: 'POST', body: { lapId } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const share = made.body;
    assert.deepEqual(Object.keys(share).sort(), ['path', 'share', 'token']);
    assert.match(share.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, URL safe');
    assert.equal(share.path, `/api/sim/public/share/${share.token}`);
    assert.deepEqual([share.share.kind, share.share.lapId, share.share.sessionId, share.share.expiresAt, share.share.revokedAt, share.share.active], ['lap', lapId, null, null, null, true]);
    // Only the hash is stored.
    const stored = (await direct.query('SELECT token_hash, created_by FROM public.sim_shares WHERE id = $1', [share.share.id])).rows[0];
    assert.deepEqual([stored.token_hash, stored.created_by], [sha(share.token), ids.A]);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_shares WHERE token_hash = $1', [share.token])).rows[0].n, 0);
    // The person's own list never shows the token.
    const listed = await api.A('/shares');
    assert.deepEqual(listed.body.shares.map((s) => s.id), [share.share.id]);
    assert.ok(!listed.text.includes(share.token));

    // No sign-in, no cookies: the summary.
    const view = await pub(`/share/${share.token}`);
    assert.equal(view.status, 200, view.text);
    assert.deepEqual(view.body, {
      kind: 'lap', createdAt: share.share.createdAt, expiresAt: null, driver: { handle: ha, displayName: (await profileOf('A')).displayName },
      lap: { id: lapId, game: 'lmu', track: { name: 'Share Ring', lengthM: 5000 }, car: { name: 'Share Car', class: null }, lapNumber: 7, timeMs: 91_234, valid: true,
        startedAt: '2026-11-05T10:00:00.000Z', sectorsMs: [30_000, 30_000, 31_234], topSpeedKmh: view.body.lap.topSpeedKmh },
    });
    assert.ok(view.body.lap.topSpeedKmh > 150);
    assert.equal(view.headers.get('cache-control'), 'private, no-store');
    // The lap file: the very bytes, with an immutable cache; a lap the link does not cover is not served.
    const file = await raw(simPublic, `/api/sim/public/share/${share.token}/file/${lapId}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/gzip');
    assert.match(file.headers.get('cache-control'), /max-age=31536000, immutable/);
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array(bytes));
    assert.equal((await pub(`/share/${share.token}/file/${other}`)).status, 404, 'another lap of the same driver');
    assert.equal((await pub(`/share/${share.token}/file/not-a-uuid`)).status, 404);
    assert.equal((await pub(`/share/${share.token}/file/00000000-0000-4000-8000-000000000000`)).status, 404);

    // A private profile: the lap is still shown (they chose to share it) but without any name.
    await setVisibility('A', 'private');
    const anon = await pub(`/share/${share.token}`);
    assert.deepEqual([anon.status, anon.body.driver, anon.body.lap.id], [200, null, lapId]);
    await setVisibility('A', 'friends');
    assert.equal((await pub(`/share/${share.token}`)).body.driver.handle, ha, 'a friends profile is not private');
    await setVisibility('A', 'public');
    // A hidden profile shows nothing.
    await direct.query('UPDATE public.sim_profiles SET hidden = true WHERE user_id = $1', [ids.A]);
    problem(await pub(`/share/${share.token}`), 404, 'not_found');
    await direct.query('UPDATE public.sim_profiles SET hidden = false WHERE user_id = $1', [ids.A]);
    assert.equal((await pub(`/share/${share.token}`)).status, 200);

    // Not a token, not found, wrong method: the same 404.
    for (const bad of ['abc', 'x'.repeat(100), `${share.token.slice(0, 40)}!!!`, share.token.slice(0, -1) + (share.token.endsWith('A') ? 'B' : 'A')]) problem(await pub(`/share/${bad}`), 404, 'not_found');
    problem(await pub('/share'), 404, 'not_found');
    problem(await pub('/nothing/here'), 404, 'not_found');
    problem(await pub(`/share/${share.token}`, { method: 'POST' }), 405, 'method_not_allowed');
    assert.equal((await raw(simPublic, `/api/sim/public/share/${share.token}`, { method: 'OPTIONS' })).status, 204);

    // Expiry.
    const expiring = await api.A('/shares', { method: 'POST', body: { lapId, expiresInDays: 7 } });
    assert.equal(expiring.status, 201);
    assert.ok(Math.abs(Date.parse(expiring.body.share.expiresAt) - (Date.now() + 7 * 86_400_000)) < 60_000);
    assert.equal((await pub(`/share/${expiring.body.token}`)).status, 200);
    await direct.query("UPDATE public.sim_shares SET expires_at = now() - interval '1 minute' WHERE id = $1", [expiring.body.share.id]);
    problem(await pub(`/share/${expiring.body.token}`), 404, 'not_found');
    problem(await pub(`/share/${expiring.body.token}/file/${lapId}`), 404, 'not_found');
    const afterExpiry = (await api.A('/shares')).body.shares.find((s) => s.id === expiring.body.share.id);
    assert.deepEqual([afterExpiry.active, afterExpiry.revokedAt], [false, null]);

    // Revoking: gone at once for the public, kept in the list as revoked, and again is fine.
    assert.equal((await api.A(`/shares/${share.share.id}`, { method: 'DELETE' })).status, 204);
    problem(await pub(`/share/${share.token}`), 404, 'not_found');
    problem(await pub(`/share/${share.token}/file/${lapId}`), 404, 'not_found');
    const revoked = (await api.A('/shares')).body.shares.find((s) => s.id === share.share.id);
    assert.deepEqual([revoked.active, typeof revoked.revokedAt], [false, 'string']);
    assert.equal((await api.A(`/shares/${share.share.id}`, { method: 'DELETE' })).status, 204);
    problem(await api.B(`/shares/${share.share.id}`, { method: 'DELETE' }), 404, 'share_not_found');
    problem(await api.A('/shares/00000000-0000-4000-8000-000000000000', { method: 'DELETE' }), 404, 'share_not_found');

    // Deleting the lap takes its links with it.
    const doomed = await api.A('/shares', { method: 'POST', body: { lapId: other } });
    assert.equal((await pub(`/share/${doomed.body.token}`)).status, 200);
    assert.equal((await api.A(`/laps/${other}`, { method: 'DELETE' })).status, 204);
    problem(await pub(`/share/${doomed.body.token}`), 404, 'not_found');
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_shares WHERE id = $1', [doomed.body.share.id])).rows[0].n, 0);
  });

  await check('sharing: a session link shows its laps and serves their files, and creating links has rules', async () => {
    const mine = await put('A', { track: 'Session Ring', car: 'Session Car', timeMs: 90_000 });
    const mate = await put('A', { track: 'Session Ring', car: 'Session Car', timeMs: 91_000 });
    const away = await put('A', { track: 'Session Ring', car: 'Session Car', timeMs: 92_000, startedAt: new Date(clock += 5 * 3600_000).toISOString() }); // a later session
    const sessionId = (await lapRow(mine)).session_id;
    assert.equal((await lapRow(mate)).session_id, sessionId);
    assert.notEqual((await lapRow(away)).session_id, sessionId);
    const made = await api.A('/shares', { method: 'POST', body: { sessionId, expiresInDays: 30 } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual([made.body.share.kind, made.body.share.sessionId, made.body.share.lapId], ['session', sessionId, null]);
    const view = await pub(`/share/${made.body.token}`);
    assert.equal(view.status, 200);
    assert.deepEqual([view.body.kind, view.body.session.game, view.body.session.track.name, view.body.session.car.name, view.body.session.lapCount, view.body.session.bestLapMs],
      ['session', 'lmu', 'Session Ring', 'Session Car', 2, 90_000]);
    assert.deepEqual(view.body.session.laps.map((l) => l.id), [mine, mate]);
    assert.deepEqual(Object.keys(view.body.session.laps[0]).sort(), ['id', 'lapNumber', 'sectorsMs', 'startedAt', 'timeMs', 'topSpeedKmh', 'valid']);
    assert.equal(view.body.driver.handle, (await profileOf('A')).handle);
    assert.equal((await pub(`/share/${made.body.token}/file/${mate}`)).status, 200, 'any lap of the session');
    assert.equal((await pub(`/share/${made.body.token}/file/${away}`)).status, 404, 'but not a lap of another session');
    // Rules.
    problem(await api.B('/shares', { method: 'POST', body: { lapId: mine } }), 404, 'lap_not_found');
    problem(await api.B('/shares', { method: 'POST', body: { sessionId } }), 404, 'session_not_found');
    problem(await api.A('/shares', { method: 'POST', body: { lapId: 'nope' } }), 400, 'invalid_lap');
    problem(await api.A('/shares', { method: 'POST', body: { sessionId: 7 } }), 400, 'invalid_session');
    problem(await api.A('/shares', { method: 'POST', body: { lapId: mine, sessionId } }), 400, 'invalid_request');
    problem(await api.A('/shares', { method: 'POST', body: {} }), 400, 'invalid_request');
    for (const days of [0, 366, 1.5, '7', -1]) problem(await api.A('/shares', { method: 'POST', body: { lapId: mine, expiresInDays: days } }), 400, 'invalid_expires');
    problem(await api.A('/shares', { method: 'POST', body: { lapId: mine, note: 'x' } }), 400, 'invalid_request');
    problem(await api.A('/shares', { method: 'PUT' }), 405, 'method_not_allowed');
    // Paging the person's own links, newest first.
    for (let i = 0; i < 3; i++) await api.A('/shares', { method: 'POST', body: { lapId: mine } });
    const all = await listAll('A', '/shares', 'shares');
    assert.equal(all.length, 4);
    assert.deepEqual(all.map((s) => s.createdAt), [...all.map((s) => s.createdAt)].sort().reverse());
    assert.equal(new Set(all.map((s) => s.id)).size, 4);
    // At most 100 live links.
    await direct.query(`INSERT INTO public.sim_shares(token_hash, lap_id, created_by) SELECT 'bulk-' || g, $1, $2 FROM generate_series(1, 96) g`, [mine, ids.A]);
    problem(await api.A('/shares', { method: 'POST', body: { lapId: mine } }), 422, 'share_limit');
    await direct.query("DELETE FROM public.sim_shares WHERE token_hash LIKE 'bulk-%'");
    assert.equal((await api.A('/shares', { method: 'POST', body: { lapId: mine } })).status, 201);
  });

  await check('sharing: the public endpoints are rate limited per address, and creating links is limited per person', async () => {
    const lap = await put('A', { track: 'Rate Ring', car: 'Rate Car' });
    const made = await api.A('/shares', { method: 'POST', body: { lapId: lap } });
    let limited = null;
    for (let i = 1; i <= 130; i++) {
      const r = await pub(`/share/${made.body.token}`, { ip: '10.9.9.9' });
      if (r.status === 429) { limited = { at: i, r }; break; }
      assert.equal(r.status, 200);
    }
    assert.ok(limited, 'the 121st read from one address is throttled');
    assert.equal(limited.at, 121);
    assert.deepEqual(limited.r.body, { error: 'too_many_requests', retryable: true });
    assert.ok(Number(limited.r.headers.get('retry-after')) >= 1);
    assert.equal((await pub(`/share/${made.body.token}`, { ip: '10.9.9.10' })).status, 200, 'another address is not affected');
    assert.equal((await pub(`/share/${made.body.token}/file/${lap}`, { ip: '10.9.9.9' })).status, 429, 'the file shares the count');
    // 30 new links an hour per person: B makes 30, the next two are refused.
    const bLaps = [];
    for (let i = 0; i < 32; i++) bLaps.push(await put('B', { track: 'Rate Ring', car: 'Rate Car' }));
    await resetRates();
    const statuses = [];
    for (const lapId of bLaps) statuses.push((await api.B('/shares', { method: 'POST', body: { lapId } })).status);
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(201));
    assert.deepEqual(statuses.slice(30), [429, 429]);
    const refused = await api.B('/shares', { method: 'POST', body: { lapId: (await direct.query('SELECT id FROM public.sim_laps WHERE user_id = $1 LIMIT 1', [ids.B])).rows[0].id } });
    problem(refused, 429, 'too_many_requests');
    assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  });

  // ================================================================== reports and moderation

  await check('reports: a person reports a profile or a lap once with a reason, and only what they could see', async () => {
    const [ha, hb] = await Promise.all(['A', 'B'].map(async (who) => (await profileOf(who)).handle));
    const lap = await put('A', { track: 'Report Ring', car: 'Report Car' });
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'planet', handle: ha, reason: 'spam' } }), 400, 'invalid_kind');
    problem(await api.B('/reports', { method: 'POST', body: { handle: ha, reason: 'spam' } }), 400, 'invalid_kind');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'rude' } }), 400, 'invalid_reason');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha } }), 400, 'invalid_reason');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam', details: 'x'.repeat(301) } }), 400, 'invalid_details');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam', details: 'bad\u0007' } }), 400, 'invalid_details');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam', details: 5 } }), 400, 'invalid_details');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', reason: 'spam' } }), 400, 'invalid_target');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: 'nope', reason: 'spam' } }), 400, 'invalid_target');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam', extra: 1 } }), 400, 'invalid_request');
    problem(await api.B('/reports', { method: 'GET' }), 405, 'method_not_allowed');
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_reports')).rows[0].n, 0, 'nothing was stored by a bad request');

    const first = await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'offensive_name', details: `  ${'ü'.repeat(300)}  ` } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(Object.keys(first.body.report).sort(), ['createdAt', 'id', 'status']);
    assert.equal(first.body.report.status, 'open');
    const stored = (await direct.query('SELECT * FROM public.sim_reports WHERE id = $1', [first.body.report.id])).rows[0];
    assert.deepEqual([stored.reporter_id, stored.target_kind, stored.target_id, stored.reason, stored.details.length], [ids.B, 'profile', ids.A, 'offensive_name', 300]);
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } }), 409, 'already_reported');
    assert.equal((await api.C('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } })).status, 201, 'another person may report the same profile');
    const lapReport = await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: lap, reason: 'cheating' } });
    assert.equal(lapReport.status, 201);
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: lap.toUpperCase(), reason: 'spam' } }), 409, 'already_reported');
    assert.equal((await direct.query('SELECT details FROM public.sim_reports WHERE id = $1', [lapReport.body.report.id])).rows[0].details, null);
    // Not yourself, and not what you cannot see.
    problem(await api.A('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } }), 400, 'invalid_target');
    problem(await api.A('/reports', { method: 'POST', body: { kind: 'lap', lapId: lap, reason: 'spam' } }), 400, 'invalid_target');
    problem(await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: '00000000-0000-4000-8000-000000000000', reason: 'spam' } }), 404, 'target_not_found');
    await setVisibility('A', 'friends');
    problem(await api.D('/reports', { method: 'POST', body: { kind: 'lap', lapId: lap, reason: 'spam' } }), 404, 'target_not_found');
    problem(await api.D('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } }), 404, 'target_not_found');
    await setVisibility('A', 'public');
    // A decided report frees the pair for a new one.
    assert.equal((await api.E(`/admin/reports/${first.body.report.id}`, { method: 'POST', body: { action: 'dismiss' } })).status, 200);
    assert.equal((await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'spam' } })).status, 201);
    // Ten reports an hour per person, and 50 open ones.
    await resetRates();
    const bulk = await fakeDrivers(12, 'rep', {});
    let last;
    for (const [i, row] of bulk.entries()) {
      last = await api.D('/reports', { method: 'POST', body: { kind: 'profile', handle: row.handle, reason: 'spam' } });
      if (i < 10) assert.equal(last.status, 201, `report ${i + 1}`);
    }
    problem(last, 429, 'too_many_requests');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    await resetRates();
    await direct.query(`INSERT INTO public.sim_reports(reporter_id, target_kind, target_id, reason) SELECT $1, 'lap', gen_random_uuid(), 'spam' FROM generate_series(1, 50)`, [ids.C]);
    problem(await api.C('/reports', { method: 'POST', body: { kind: 'profile', handle: hb, reason: 'spam' } }), 422, 'too_many_open_reports');
    void hb;
  });

  await check('moderation: only an admin reaches the admin endpoints (403 otherwise), and they list, decide and inspect', async () => {
    const ha = (await profileOf('A')).handle;
    const bad = await put('A', { track: 'Admin Ring', car: 'Admin Car', timeMs: 80_000, sectorsMs: [1, 2, 3], speedAt: { 4: 500 } });
    const good = await put('A', { track: 'Admin Ring', car: 'Admin Car', timeMs: 90_000 });
    const r1 = await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: bad, reason: 'cheating', details: 'sectors do not add up' } });
    const r2 = await api.C('/reports', { method: 'POST', body: { kind: 'profile', handle: ha, reason: 'impersonation' } });
    const r3 = await api.D('/reports', { method: 'POST', body: { kind: 'lap', lapId: good, reason: 'other', details: 'just looking' } });
    // A person who is not a moderator, a signed-out caller and a device key.
    const adminPaths = [['/admin/reports', 'GET'], [`/admin/reports/${r1.body.report.id}`, 'POST', { action: 'dismiss' }], [`/admin/laps/${bad}`, 'GET'], ['/admin/recheck', 'POST', {}]];
    for (const [path, method, body] of adminPaths) {
      for (const who of ['A', 'B', 'C', 'F']) problem(await api[who](path, { method, body }), 403, 'forbidden');
      problem(await call(v1, `/api/sim/v1${path}`, { method, body }), 401, 'unauthorized');
      problem(await call(v1, `/api/sim/v1${path}`, { method, body, bearer: rigs.E.token }), 401, 'unauthorized');
    }
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM public.sim_reports WHERE status = 'open'")).rows[0].n, 3, 'a refused call changed nothing');
    // The list: open first by default, newest first, with the reporter and the target as handles and names.
    const list = await api.E('/admin/reports');
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.reports.map((r) => r.id), [r3.body.report.id, r2.body.report.id, r1.body.report.id]);
    const lapItem = list.body.reports[2];
    assert.deepEqual(Object.keys(lapItem).sort(), ['createdAt', 'decidedAt', 'details', 'id', 'kind', 'reason', 'reporter', 'status', 'target']);
    assert.deepEqual([lapItem.kind, lapItem.status, lapItem.reason, lapItem.details, lapItem.decidedAt], ['lap', 'open', 'cheating', 'sectors do not add up', null]);
    assert.deepEqual(lapItem.reporter, { handle: (await profileOf('B')).handle, displayName: (await profileOf('B')).displayName });
    assert.deepEqual([lapItem.target.lapId, lapItem.target.timeMs, lapItem.target.plausible, lapItem.target.hidden, lapItem.target.owner.handle], [bad, 80_000, false, false, ha]);
    assert.deepEqual([list.body.reports[1].kind, list.body.reports[1].target.handle, list.body.reports[1].target.visibility], ['profile', ha, 'public']);
    const pageOne = await api.E('/admin/reports?limit=2');
    assert.deepEqual([pageOne.body.reports.length, typeof pageOne.body.nextCursor], [2, 'string']);
    const pageTwo = await api.E(`/admin/reports?limit=2&cursor=${pageOne.body.nextCursor}`);
    assert.deepEqual([pageTwo.body.reports.map((r) => r.id), pageTwo.body.nextCursor], [[r1.body.report.id], null]);
    problem(await api.E('/admin/reports?status=weird'), 400, 'invalid_status');
    problem(await api.E('/admin/reports?cursor=zzz'), 400, 'invalid_cursor');
    // Decisions.
    problem(await api.E(`/admin/reports/${r1.body.report.id}`, { method: 'POST', body: { action: 'ban' } }), 400, 'invalid_action');
    problem(await api.E(`/admin/reports/${r1.body.report.id}`, { method: 'POST', body: { action: 'dismiss', hideTarget: 'yes' } }), 400, 'invalid_request');
    problem(await api.E('/admin/reports/00000000-0000-4000-8000-000000000000', { method: 'POST', body: { action: 'dismiss' } }), 404, 'report_not_found');
    problem(await api.E('/admin/reports/not-a-uuid', { method: 'POST', body: { action: 'dismiss' } }), 404, 'not_found');
    const dismissed = await api.E(`/admin/reports/${r3.body.report.id}`, { method: 'POST', body: { action: 'dismiss', hideTarget: true } });
    assert.deepEqual([dismissed.body.report.status, typeof dismissed.body.report.decidedAt, dismissed.body.report.target.hidden], ['dismissed', 'string', false], 'a dismissal never hides');
    problem(await api.E(`/admin/reports/${r3.body.report.id}`, { method: 'POST', body: { action: 'action' } }), 409, 'already_decided');
    const row = (await direct.query('SELECT status, decided_by FROM public.sim_reports WHERE id = $1', [r3.body.report.id])).rows[0];
    assert.deepEqual([row.status, row.decided_by], ['dismissed', ids.E]);
    const actioned = await api.E(`/admin/reports/${r2.body.report.id}`, { method: 'POST', body: { action: 'action' } });
    assert.deepEqual([actioned.body.report.status, actioned.body.report.target.hidden], ['actioned', false], 'actioned without hiding');
    assert.equal((await api.C(`/profiles/${ha}`)).status, 200);
    const hid = await api.E(`/admin/reports/${r1.body.report.id}`, { method: 'POST', body: { action: 'action', hideTarget: true } });
    assert.deepEqual([hid.body.report.status, hid.body.report.target.hidden], ['actioned', true]);
    assert.deepEqual((await api.E('/admin/reports?status=open')).body.reports, []);
    assert.deepEqual(new Set((await api.E('/admin/reports?status=actioned')).body.reports.map((r) => r.id)), new Set([r1.body.report.id, r2.body.report.id]));
    assert.equal((await api.E('/admin/reports?status=all')).body.reports.length, 3);
    assert.equal((await api.E('/admin/reports?status=dismissed')).body.reports.length, 1);
    // What the moderator sees of a lap: the failed checks and the numbers.
    const detail = await api.E(`/admin/laps/${bad}`);
    assert.equal(detail.status, 200, detail.text);
    assert.deepEqual([detail.body.lap.plausible, detail.body.lap.hidden, detail.body.lap.timeMs, detail.body.onLeaderboard], [false, true, 80_000, false]);
    assert.deepEqual(detail.body.lap.plausibility.failed.map((f) => f.check).sort(), ['sector_sum', 'speed_range']);
    assert.ok(detail.body.lap.plausibility.failed.some((f) => f.check === 'sector_sum' && f.detail.sectorsSumMs === 6));
    assert.ok(detail.body.lap.plausibility.failed.some((f) => f.check === 'speed_range' && f.detail.maxMs === 500));
    assert.deepEqual(detail.body.owner, { handle: ha, displayName: (await profileOf('A')).displayName, visibility: 'public', hidden: false });
    assert.deepEqual(detail.body.reports.map((r) => [r.id, r.status]), [[r1.body.report.id, 'actioned']]);
    const goodDetail = await api.E(`/admin/laps/${good}`);
    assert.deepEqual([goodDetail.body.lap.plausible, goodDetail.body.lap.plausibility.failed, goodDetail.body.onLeaderboard], [true, [], true]);
    problem(await api.E('/admin/laps/00000000-0000-4000-8000-000000000000'), 404, 'lap_not_found');
    problem(await api.E('/admin/laps/nope'), 404, 'not_found');
    problem(await api.E('/admin/reports', { method: 'DELETE' }), 405, 'method_not_allowed');
  });

  await check('moderation: laps that arrived before the check have no verdict, rank nowhere, and the admin recheck reads their files', async () => {
    const T = { track: 'Legacy Ring', car: 'Legacy Car' };
    const ha = (await profileOf('A')).handle, hb = (await profileOf('B')).handle;
    const a = await put('A', { ...T, timeMs: 90_000 });
    const b = await put('B', { ...T, timeMs: 91_000, tScale: 1.2 }); // implausible once it is read
    const c = await put('C', { ...T, timeMs: 92_000 });
    await direct.query('UPDATE public.sim_laps SET plausible = NULL, plausibility = NULL WHERE id = ANY($1)', [[a, b, c]]);
    assert.deepEqual(entryHandles(await board('F', 'lmu', T.track, T.car)), [], 'no verdict, no rank');
    // A row whose file is gone is marked unreadable, once.
    const lost = (await direct.query(
      `INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
       VALUES ($1, 'lost|1', 'lmu', 'Legacy Ring', 'Legacy Car', 1, 80000, true, now(), 3, 100, $2) RETURNING id`, [ids.D, `${ids.D}/not-there.xlap.gz`])).rows[0].id;
    problem(await api.E('/admin/recheck', { method: 'POST', body: { limit: 0 } }), 400, 'invalid_limit');
    problem(await api.E('/admin/recheck', { method: 'POST', body: { limit: 201 } }), 400, 'invalid_limit');
    problem(await api.E('/admin/recheck', { method: 'POST', body: { speed: 1 } }), 400, 'invalid_request');
    const total = (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE plausible IS NULL')).rows[0].n;
    const part = await api.E('/admin/recheck', { method: 'POST', body: { limit: 1 } });
    assert.deepEqual([part.status, part.body.checked, part.body.remaining], [200, 1, total - 1]);
    const rest = await api.E('/admin/recheck', { method: 'POST' });
    assert.deepEqual([rest.body.checked, rest.body.remaining, rest.body.plausible + rest.body.implausible], [total - 1, 0, total - 1]);
    assert.deepEqual((await api.E('/admin/recheck', { method: 'POST' })).body, { checked: 0, plausible: 0, implausible: 0, remaining: 0 }, 'a second run has nothing to do');
    assert.deepEqual([(await lapRow(a)).plausible, (await lapRow(b)).plausible, (await lapRow(c)).plausible], [true, false, true]);
    assert.deepEqual((await lapRow(b)).plausibility.failed.map((f) => f.check), ['elapsed_time']);
    const unreadable = await lapRow(lost);
    assert.deepEqual([unreadable.plausible, unreadable.plausibility.failed[0].check], [false, 'file_unreadable']);
    assert.deepEqual(entryHandles(await board('F', 'lmu', T.track, T.car)), [ha, (await profileOf('C')).handle], 'the readable, believable ones rank now');
    assert.ok(!entryHandles(await board('F', 'lmu', T.track, T.car)).includes(hb));
  });

  await check('plausibility recheck job: works through the laps with no verdict in batches until none is left, marks an unreadable file once and never loops on it, stops at its time budget, and is a job of the schedule', async () => {
    const T = { track: 'Job Ring', car: 'Job Car' };
    const legacy = async (count, { lost = 0, bad = 0 } = {}) => {
      const made = [];
      for (let i = 0; i < count; i++) made.push(await put('A', { ...T, timeMs: 90_000 + i, ...(i < bad ? { tScale: 1.2 } : {}) }));
      await direct.query('UPDATE public.sim_laps SET plausible = NULL, plausibility = NULL WHERE id = ANY($1)', [made]);
      for (let i = 0; i < lost; i++) {
        made.push((await direct.query(
          `INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
           VALUES ($1, $2, 'lmu', 'Job Ring', 'Job Car', 1, 80000, true, now(), 3, 100, $3) RETURNING id`, [ids.D, `job-lost|${made.length}|${Math.random()}`, `${ids.D}/gone-${Math.random()}.xlap.gz`])).rows[0].id);
      }
      return made;
    };
    const unchecked = async () => (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE plausible IS NULL')).rows[0].n;
    assert.equal(await unchecked(), 0, 'nothing waits before this check');
    const backend = openBackend();

    // 7 laps with no verdict (one implausible once read, one whose file is gone): batches of 3 until none is left.
    const first = await legacy(6, { lost: 1, bad: 1 });
    const sizes = [];
    const done = await runPlausibilityRecheck({ recheck: (limit) => { sizes.push(limit); return recheckLaps(backend, limit); }, batch: 3 });
    assert.deepEqual(sizes, [3, 3, 3], 'three batches: 3 + 3 + 1, the last one finds the end');
    assert.deepEqual(done, { checked: 7, plausible: 5, implausible: 2, remaining: 0 });
    assert.equal(await unchecked(), 0);
    assert.deepEqual((await lapRow(first[6])).plausibility.failed.map((f) => f.check), ['file_unreadable'], 'the lost file is marked');
    assert.equal((await lapRow(first[0])).plausible, false, 'the implausible one');
    // Nothing is tried twice: the lost file does not come back, and a run with nothing to do ends after one look.
    const calls = [];
    assert.deepEqual(await runPlausibilityRecheck({ recheck: (limit) => { calls.push(limit); return recheckLaps(backend, limit); }, batch: 3 }), { checked: 0, plausible: 0, implausible: 0, remaining: 0 });
    assert.equal(calls.length, 1);

    // A batch that settles nothing ends the run instead of looping, however many are said to remain.
    let stuck = 0;
    assert.deepEqual(await runPlausibilityRecheck({ recheck: async () => { stuck++; return { checked: 0, plausible: 0, implausible: 0, remaining: 9 }; } }), { checked: 0, plausible: 0, implausible: 0, remaining: 9 });
    assert.equal(stuck, 1);

    // The time budget stops it between batches: each batch takes two minutes on this clock, the budget is three.
    await legacy(6);
    let clock = 0, batches = 0;
    const partial = await runPlausibilityRecheck({ recheck: (limit) => { batches++; clock += 120_000; return recheckLaps(backend, limit); }, batch: 2, budgetMs: 180_000, now: () => clock });
    assert.equal(batches, 2, 'a batch is not started once the budget is spent');
    assert.deepEqual([partial.checked, partial.remaining], [4, 2]);
    assert.equal(await unchecked(), 2, 'the rest waits for the next run');

    // The scheduled job is the same thing with the real defaults (200 a batch), logs one line through the schedule, and finishes the rest.
    const job = enabledJobs(process.env).find((j) => j.name === 'plausibility_recheck');
    assert.ok(job, 'on by default');
    const summary = await job.run();
    assert.deepEqual(summary, { checked: 2, plausible: 2, implausible: 0, remaining: 0 });
    assert.equal(await unchecked(), 0);
    assert.equal((await enabledJobs({ ...process.env, PLAUSIBILITY_RECHECK: 'false' }).find((j) => j.name === 'plausibility_recheck')), undefined, 'off with PLAUSIBILITY_RECHECK=false');

    // Two runs at once: the second one steps aside.
    let release;
    const slow = runPlausibilityRecheck({ recheck: () => new Promise((resolveBatch) => { release = () => resolveBatch({ checked: 1, plausible: 1, implausible: 0, remaining: 0 }); }) });
    assert.deepEqual(await runPlausibilityRecheck({ recheck: async () => assert.fail('it must not run twice at once') }), { skipped: true });
    release();
    assert.equal((await slow).checked, 1);
    assert.deepEqual(await runPlausibilityRecheck({ recheck: async () => ({ checked: 0, plausible: 0, implausible: 0, remaining: 0 }) }), { checked: 0, plausible: 0, implausible: 0, remaining: 0 }, 'and the next one runs again');
  });

  // ================================================================== privacy rights

  await check('export: one JSON file with every kind of the person\'s data and links to their files, and nothing of anyone else', async () => {
    const T = { track: 'Export Ring', car: 'Export Car' };
    const ha = (await profileOf('A')).handle, hb = (await profileOf('B')).handle, hc = (await profileOf('C')).handle;
    const first = await put('A', { ...T, timeMs: 90_000 }); const second = await put('A', { ...T, timeMs: 95_000, valid: false });
    const bs = await put('B', { ...T, timeMs: 91_000 });
    await befriend('A', 'B');
    assert.equal((await api.C('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    await api.A(`/friends/${(await profileOf('D')).handle}/block`, { method: 'POST' });
    const share = await api.A('/shares', { method: 'POST', body: { lapId: first } });
    await api.A('/reports', { method: 'POST', body: { kind: 'profile', handle: hb, reason: 'spam', details: 'my own report' } });
    await direct.query(`INSERT INTO public.sim_tracks (user_id, game, track_key, track_name, size_bytes, sha256, storage_path) VALUES ($1, 'lmu', 'lmu|export ring', 'Export Ring', 1234, 'abc', $2)`, [ids.A, `${ids.A}/layout.xtrk.gz`]);
    const keyHash = (await direct.query('SELECT token_hash FROM public.sim_devices WHERE id = $1', [rigs.A.deviceId])).rows[0].token_hash;
    await api.A('/profile', { method: 'PATCH', body: { displayName: 'Ana Exportável' } });

    const r = await api.A('/me/export');
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.match(r.headers.get('content-disposition'), /^attachment; filename="[\w.-]+\.json"$/);
    assert.match(r.headers.get('content-type'), /application\/json/);
    const doc = r.body;
    assert.deepEqual(Object.keys(doc).sort(), ['devices', 'exportedAt', 'format', 'friends', 'lapFiles', 'laps', 'personalBests', 'profile', 'reportsMade', 'sessions', 'shares', 'trackLayoutFiles', 'trackLayouts', 'version']);
    assert.deepEqual([doc.format, doc.version], ['xpeed-virtual-export', 1]);
    assert.deepEqual([doc.profile.handle, doc.profile.displayName, doc.profile.visibility], [ha, 'Ana Exportável', 'public']);
    const count = async (table, column = 'user_id') => (await direct.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${column} = $1`, [ids.A])).rows[0].n;
    assert.equal(doc.laps.length, await count('sim_laps'));
    assert.equal(doc.sessions.length, await count('sim_sessions'));
    assert.equal(doc.personalBests.length, await count('sim_personal_bests'));
    assert.equal(doc.devices.length, await count('sim_devices'));
    assert.equal(doc.trackLayouts.length, 1);
    assert.deepEqual(doc.laps.map((l) => l.id).sort(), (await direct.query('SELECT id FROM public.sim_laps WHERE user_id = $1', [ids.A])).rows.map((l) => l.id).sort());
    const exported = doc.laps.find((l) => l.id === first);
    assert.deepEqual([exported.timeMs, exported.track.name, exported.car.name, exported.valid, exported.plausible, exported.plausibility.failed, exported.deviceName], [90_000, 'Export Ring', 'Export Car', true, true, [], 'RIG A']);
    assert.equal(doc.laps.find((l) => l.id === second).valid, false);
    assert.deepEqual(doc.friends.map((f) => [f.handle, f.status]).sort(), [[hb, 'accepted'], [hc, 'incoming'], [(await profileOf('D')).handle, 'blocked']].sort());
    assert.deepEqual(Object.keys(doc.friends[0]).sort(), ['handle', 'since', 'status'], 'friends by handle, nothing else');
    assert.deepEqual(doc.shares.map((s) => [s.id, s.lapId]), [[share.body.share.id, first]]);
    assert.deepEqual(doc.reportsMade.map((x) => [x.kind, x.reason, x.details]), [['profile', 'spam', 'my own report']]);
    assert.deepEqual(doc.devices.map((d) => Object.keys(d).sort()), [['id', 'lastLapAt', 'lastSeenAt', 'name', 'pairedAt', 'revokedAt']]);
    assert.equal(doc.lapFiles.length, doc.laps.length);
    assert.deepEqual(doc.lapFiles.find((f) => f.lapId === first), { lapId: first, sizeBytes: exported.sizeBytes, path: `/api/sim/v1/laps/${first}/file` });
    assert.deepEqual(doc.trackLayoutFiles.map((f) => f.path), [`/api/sim/tracks/${doc.trackLayouts[0].id}/file`]);
    // Nothing of anybody else, and no secret: not B's lap, not the e-mail of A or of anyone, not a key hash or a share token.
    assert.ok(!r.text.includes(bs), 'B\'s lap is not in A\'s export');
    assert.ok(!r.text.includes(keyHash) && !r.text.includes(share.body.token) && !r.text.includes(sha(share.body.token)) && !r.text.includes(rigs.A.token));
    assert.ok(!/"token"/.test(r.text), 'no token field');
    // The links work with the same sign-in.
    const link = await call(v1, doc.lapFiles.find((f) => f.lapId === first).path, { bearer: A });
    assert.equal(link.status, 200);
    assert.equal(link.text.length > 0, true);
    // Another person's export holds only theirs.
    const other = (await api.B('/me/export')).body;
    assert.ok(other.laps.some((l) => l.id === bs));
    assert.ok(!other.laps.some((l) => l.id === first || l.id === second), 'no lap of A in the export of B');
    assert.equal(other.laps.length, (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1', [ids.B])).rows[0].n);
    assert.deepEqual(other.friends.map((f) => f.handle), [ha]);
    assert.deepEqual([other.shares, other.reportsMade, other.trackLayouts], [[], [], []]);
    // A sign-in with no account at all gets nothing.
    problem(await call(v1, '/api/sim/v1/me/export', { bearer: await token('uid-nobody', { phone_number: '+15550009999' }) }), 401, 'unauthorized');
    // Five an hour per person, and only for the signed-in person.
    for (let i = 0; i < 4; i++) assert.equal((await api.A('/me/export')).status, 200);
    problem(await api.A('/me/export'), 429, 'too_many_requests');
    problem(await call(v1, '/api/sim/v1/me/export'), 401, 'unauthorized');
    problem(await api.B('/me/export', { method: 'POST' }), 405, 'method_not_allowed');
  });

  await check('delete: needs the exact confirmation, then nothing of the person is left: rows, files, links, friendships, reports, devices and profile; others are untouched', async () => {
    const T = { track: 'Erase Ring', car: 'Erase Car' };
    await api.F('/profile');
    const hf = (await profileOf('F')).handle, hb = (await profileOf('B')).handle, hc = (await profileOf('C')).handle;
    const f1 = await put('F', { ...T, timeMs: 90_000 }); const f2 = await put('F', { ...T, timeMs: 92_000 });
    const b1 = await put('B', { ...T, timeMs: 91_000 });
    await befriend('F', 'B');
    assert.equal((await api.C('/friends/requests', { method: 'POST', body: { handle: hf } })).status, 201);
    const share = await api.F('/shares', { method: 'POST', body: { lapId: f1 } });
    const sessionShare = await api.F('/shares', { method: 'POST', body: { sessionId: (await lapRow(f1)).session_id } });
    assert.equal((await api.F('/reports', { method: 'POST', body: { kind: 'profile', handle: hb, reason: 'spam' } })).status, 201);
    assert.equal((await api.B('/reports', { method: 'POST', body: { kind: 'lap', lapId: f1, reason: 'cheating' } })).status, 201, 'a report about F\'s lap');
    assert.equal((await api.B('/reports', { method: 'POST', body: { kind: 'profile', handle: hc, reason: 'spam' } })).status, 201, 'and one that has nothing to do with F');
    const layoutPath = `${ids.F}/layout.xtrk.gz`;
    const backend = openBackend();
    assert.equal((await backend.service.storage.from('sim-tracks').upload(layoutPath, new Uint8Array([1, 2, 3]), { contentType: 'application/gzip' })).error, null);
    await direct.query(`INSERT INTO public.sim_tracks (user_id, game, track_key, track_name, size_bytes, sha256, storage_path) VALUES ($1, 'lmu', 'lmu|erase ring', 'Erase Ring', 3, 'abc', $2)`, [ids.F, layoutPath]);
    await direct.query(`INSERT INTO public.sim_pairing_codes(code_hash, user_id, expires_at) VALUES ('erase-code', $1, now() + interval '5 minutes')`, [ids.F]);
    const lapFiles = (await direct.query('SELECT storage_path FROM public.sim_laps WHERE user_id = $1', [ids.F])).rows.map((r) => resolve(filesRoot, 'sim-laps', r.storage_path));
    assert.ok(lapFiles.length >= 4);
    assert.ok(lapFiles.every((p) => existsSync(p)));
    assert.ok(existsSync(resolve(filesRoot, 'sim-tracks', layoutPath)));
    const mine = async (table, column = 'user_id') => (await direct.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${column} = $1`, [ids.F])).rows[0].n;
    const expected = { laps: await mine('sim_laps'), sessions: await mine('sim_sessions'), trackLayouts: 1, shares: 2, friendships: 2, reports: 2, devices: 1, profile: true };
    assert.ok(expected.laps >= 4 && expected.sessions >= 2, 'the person has laps from an earlier check too');
    const tables = [['sim_laps'], ['sim_sessions'], ['sim_personal_bests'], ['sim_tracks'], ['sim_shares', 'created_by'], ['sim_profiles'], ['sim_devices'], ['sim_pairing_codes']];
    for (const [table, column] of tables) assert.ok(await mine(table, column) > 0, `${table} has rows before`);

    // The confirmation must be exact; anything else deletes nothing.
    for (const body of [undefined, {}, { confirm: 'yes' }, { confirm: 'Delete my racing data' }, { confirm: 'delete my racing data ' }, { confirm: true }, { confirmation: 'delete my racing data' }]) {
      problem(await api.F('/me/data', { method: 'DELETE', body }), 400, 'confirmation_required');
    }
    problem(await api.F('/me/data', { method: 'DELETE', body: 'nope' }), 400, 'invalid_body');
    problem(await api.F('/me/data', { method: 'POST', body: { confirm: 'delete my racing data' } }), 405, 'method_not_allowed');
    problem(await call(v1, '/api/sim/v1/me/data', { method: 'DELETE', body: { confirm: 'delete my racing data' } }), 401, 'unauthorized');
    problem(await call(v1, '/api/sim/v1/me/data', { method: 'DELETE', body: { confirm: 'delete my racing data' }, bearer: rigs.F.token }), 401, 'unauthorized');
    for (const [table, column] of tables) assert.ok(await mine(table, column) > 0, `${table} still has rows`);

    const gone = await api.F('/me/data', { method: 'DELETE', body: { confirm: 'delete my racing data' } });
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual(gone.body, { deleted: expected });
    // The database: nothing of F's left anywhere.
    for (const [table, column] of tables) assert.equal(await mine(table, column), 0, table);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_friendships WHERE user_a = $1 OR user_b = $1 OR requested_by = $1', [ids.F])).rows[0].n, 0);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_reports WHERE reporter_id = $1 OR target_id = $1 OR target_id = ANY($2)', [ids.F, [f1, f2]])).rows[0].n, 0);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_handle_changes WHERE user_id = $1', [ids.F])).rows[0].n, 0);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_link_requests WHERE user_id = $1', [ids.F])).rows[0].n, 0);
    // The files.
    assert.ok(lapFiles.every((p) => !existsSync(p)), 'the lap files are gone');
    assert.ok(!existsSync(resolve(filesRoot, 'sim-tracks', layoutPath)), 'and the track layout');
    for (const bucket of ['sim-laps', 'sim-tracks']) {
      const folder = resolve(filesRoot, bucket, ids.F);
      assert.ok(!existsSync(folder) || readdirSync(folder).length === 0, `nothing under ${bucket}/<person>`);
    }
    // Nothing reachable: not by handle, not on a board, not by a link, not with the old device key.
    problem(await api.C(`/profiles/${hf}`), 404, 'profile_not_found');
    problem(await api.C('/friends/requests', { method: 'POST', body: { handle: hf } }), 404, 'handle_not_found');
    assert.deepEqual(entryHandles(await board('C', 'lmu', T.track, T.car)), [hb]);
    assert.deepEqual((await api.B('/friends')).body.friends, []);
    assert.deepEqual((await api.C('/friends?status=outgoing')).body.friends, []);
    problem(await pub(`/share/${share.body.token}`), 404, 'not_found');
    problem(await pub(`/share/${sessionShare.body.token}`), 404, 'not_found');
    problem(await pub(`/share/${share.body.token}/file/${f1}`), 404, 'not_found');
    assert.equal((await upload(rigs.F.token, await makeLap({ ...T }))).status, 401, 'the device key no longer works');
    assert.deepEqual((await api.F('/laps')).body, { laps: [], nextCursor: null });
    assert.deepEqual((await api.F('/overview')).body.lapsPerGame, []);
    const adminSees = (await api.E('/admin/reports?status=all')).body.reports;
    assert.ok(!adminSees.some((x) => x.reporter?.handle === hf || x.target?.handle === hf || x.target?.owner?.handle === hf), 'no report mentions them');
    problem(await api.E(`/admin/laps/${f1}`), 404, 'lap_not_found');
    const ex = (await api.F('/me/export')).body;
    assert.deepEqual([ex.profile, ex.laps, ex.sessions, ex.friends, ex.shares, ex.devices, ex.personalBests, ex.reportsMade, ex.trackLayouts], [null, [], [], [], [], [], [], [], []]);
    // Other people are untouched: their laps, files, report about someone else.
    assert.equal((await lapRow(b1)).user_id, ids.B);
    assert.ok(existsSync(resolve(filesRoot, 'sim-laps', (await lapRow(b1)).storage_path)));
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_reports WHERE reporter_id = $1 AND target_id = $2', [ids.B, ids.C])).rows[0].n, 1);
    assert.equal((await api.B('/laps?limit=100')).body.laps.some((l) => l.id === b1), true);
    // The account itself is not deleted: the person can sign in, and starts again with a new, generated profile.
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.app_accounts WHERE id = $1', [ids.F])).rows[0].n, 1);
    const fresh = (await api.F('/profile')).body.profile;
    assert.notEqual(fresh.handle, hf);
    assert.match(fresh.handle, /^driver_/);
    // And a second delete is fine and deletes nothing.
    const again = await api.F('/me/data', { method: 'DELETE', body: { confirm: 'delete my racing data' } });
    assert.deepEqual(again.body, { deleted: { laps: 0, sessions: 0, trackLayouts: 0, shares: 0, friendships: 0, reports: 0, devices: 0, profile: true } });
  });

  // ================================================================== access, routes and privacy

  await check('access: a signed-in person cannot read the social tables or call the social functions through the Data API', async () => {
    const asPerson = async (sub, sql, args = []) => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
          JSON.stringify({ iss: 'https://securetoken.google.com/skaleclub', aud: 'skaleclub', sub, firebase: { sign_in_provider: 'phone' } }), sub]);
        return (await client.query(sql, args)).rows;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };
    await api.A('/profile');
    for (const sql of ['SELECT * FROM public.sim_profiles', 'SELECT * FROM public.sim_friendships', 'SELECT * FROM public.sim_shares', 'SELECT * FROM public.sim_reports', 'SELECT * FROM public.sim_handle_changes',
      "UPDATE public.sim_profiles SET visibility = 'public'", "DELETE FROM public.sim_shares", `SELECT public.sim_profile_page('${ids.B}', 'x')`,
      `SELECT public.sim_leaderboard('${ids.B}', '${ids.B}', '${ids.B}', 'public')`, `SELECT public.sim_export_me('${ids.B}')`, `SELECT public.sim_delete_my_data('${ids.B}')`,
      `SELECT public.sim_admin_reports('all')`, `SELECT public.sim_share_view('x')`, `SELECT public.sim_set_plausibility('${ids.B}', true, '{}')`,
      `SELECT public.sim_friend_request('${ids.B}', 'x')`, `SELECT public.sim_ensure_profile('${ids.B}')`,
      `SELECT public.sim_leaderboard_catalog('${ids.B}', 'track')`, `SELECT public.sim_share_list('${ids.B}')`, `SELECT public.sim_friend_request_count('${ids.B}')`]) {
      await assert.rejects(asPerson('uid-a', sql), /permission denied|row-level security/, sql);
    }
    // The new columns of the laps are the owner's own like the rest of the row.
    assert.equal((await asPerson('uid-b', 'SELECT id FROM public.sim_laps WHERE user_id = $1', [ids.A])).length, 0);
    for (const sql of ["UPDATE public.sim_laps SET plausible = true", "UPDATE public.sim_laps SET hidden = false"]) await assert.rejects(asPerson('uid-a', sql), /permission denied|row-level security/, sql);
  });

  await check('routes: profiles, friends and moderation go through the real server with CORS and PATCH, and the public share needs no sign-in or Origin', async () => {
    webServer = createXpeedServer({ staticRoot: temp, origin: 'https://xpeed.test' });
    await new Promise((done) => webServer.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${webServer.address().port}`;
    const lap = await put('A', { track: 'Server Ring', car: 'Server Car' });
    const headers = { authorization: `Bearer ${A}`, origin: 'https://xpeed.test', 'content-type': 'application/json' };
    const pre = await fetch(`${base}/api/sim/v1/profile`, { method: 'OPTIONS', headers: { origin: 'https://xpeed.test', 'access-control-request-method': 'PATCH' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    const patched = await fetch(`${base}/api/sim/v1/profile`, { method: 'PATCH', headers, body: JSON.stringify({ displayName: 'Server Ana' }) });
    assert.equal(patched.status, 200);
    assert.equal(patched.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    assert.equal((await patched.json()).profile.displayName, 'Server Ana');
    assert.equal((await fetch(`${base}/api/sim/v1/profile`, { method: 'PATCH', headers: { ...headers, origin: 'https://evil.example' }, body: '{"visibility":"private"}' })).headers.get('access-control-allow-origin'), null);
    await direct.query("UPDATE public.sim_profiles SET visibility = 'public'");
    // A share, then the public side with no Authorization and no Origin at all.
    const share = await (await fetch(`${base}/api/sim/v1/shares`, { method: 'POST', headers, body: JSON.stringify({ lapId: lap }) })).json();
    const open = await fetch(`${base}${share.path}`);
    assert.equal(open.status, 200);
    assert.equal((await open.json()).lap.id, lap);
    assert.equal((await fetch(`${base}${share.path}/file/${lap}`)).status, 200);
    assert.equal((await fetch(`${base}/api/sim/public/share/${'z'.repeat(43)}`)).status, 404);
    assert.equal((await fetch(`${base}${share.path}`, { method: 'POST' })).status, 405);
    // A DELETE with a body arrives intact (the confirmation is read), and nothing is deleted by a wrong one.
    const refused = await fetch(`${base}/api/sim/v1/me/data`, { method: 'DELETE', headers, body: JSON.stringify({ confirm: 'no' }) });
    assert.deepEqual([refused.status, await refused.json()], [400, { error: 'confirmation_required', retryable: false }]);
    // Friends and moderation.
    assert.equal((await fetch(`${base}/api/sim/v1/friends`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/sim/v1/admin/reports`, { headers })).status, 403);
    assert.equal((await fetch(`${base}/api/sim/v1/admin/reports`, { headers: { ...headers, authorization: `Bearer ${E}` } })).status, 200);
    await new Promise((done) => (webServer.closeAllConnections?.(), webServer.close(done)));
    webServer = undefined;
  });

  // ================================================================== the gaps the Virtual screens reported

  await check('leaderboard catalog: the tracks and cars that have a public, valid, plausible, visible lap, by name with their lap counts, and nothing private', async () => {
    const cat = (who, extra = '') => api[who](`/leaderboards/catalog?${extra}`);
    const ours = (r) => r.body.items.filter((item) => item.name.startsWith('Cat '));
    const summary = (r) => ours(r).map((item) => [item.name, item.game, item.lapCount]);
    await put('A', { track: 'Cat Ring 1', car: 'Cat Car X', timeMs: 90_000 });
    await put('A', { track: 'Cat Ring 1', car: 'Cat Car X', timeMs: 91_000 });
    await put('A', { track: 'Cat Ring 1', car: 'Cat Car Y', timeMs: 92_000 });
    await put('B', { track: 'Cat Ring 2', car: 'Cat Car X', timeMs: 90_500 });
    await put('C', { track: 'Cat Ring 3', car: 'Cat Car Z', timeMs: 95_000 });                    // C is private below
    await put('D', { track: 'Cat Ring 4', car: 'Cat Car X', timeMs: 95_000, speed: 200 });        // implausible
    await put('A', { track: 'Cat Ring 5', car: 'Cat Car X', timeMs: 95_000, valid: false });      // not valid
    const hidden = await put('A', { track: 'Cat Ring 6', car: 'Cat Car X', timeMs: 95_000 });     // hidden by a moderator below
    await put('A', { track: 'Cat Ring 7', car: 'Cat Car W', timeMs: 95_000, game: 'acc' });
    await setVisibility('C', 'private');
    await direct.query('UPDATE public.sim_laps SET hidden = true WHERE id = $1', [hidden]);
    assert.equal((await lapRow(await put('D', { track: 'Cat Ring 4', car: 'Cat Car X', timeMs: 96_000, speed: 200 }))).plausible, false);

    // Tracks (the default) and cars, alphabetical, with the number of listed laps. Private, implausible, invalid and hidden laps do not count.
    const tracks = await cat('A');
    assert.equal(tracks.status, 200, JSON.stringify(tracks.body));
    assert.deepEqual(Object.keys(tracks.body).sort(), ['items', 'kind', 'nextCursor']);
    assert.equal(tracks.body.kind, 'track');
    assert.deepEqual(summary(tracks), [['Cat Ring 1', 'lmu', 3], ['Cat Ring 2', 'lmu', 1], ['Cat Ring 7', 'acc', 1]]);
    assert.deepEqual(Object.keys(tracks.body.items[0]).sort(), ['game', 'id', 'lapCount', 'lengthM', 'name']);
    const names = tracks.body.items.map((item) => item.name);
    assert.deepEqual(names, [...names].sort(), 'by name');
    assert.deepEqual(summary(await cat('C')), summary(tracks), 'a private driver sees the same public catalog (their own laps are not on it)');
    const cars = await cat('A', 'kind=car');
    assert.equal(cars.body.kind, 'car');
    assert.deepEqual(summary(cars), [['Cat Car W', 'acc', 1], ['Cat Car X', 'lmu', 3], ['Cat Car Y', 'lmu', 1]]);
    assert.deepEqual(Object.keys(cars.body.items[0]).sort(), ['brand', 'class', 'game', 'id', 'lapCount', 'name']);
    // Filters: the game, and the other side of the pair.
    assert.deepEqual(summary(await cat('A', 'game=acc')), [['Cat Ring 7', 'acc', 1]]);
    const x = ours(cars).find((item) => item.name === 'Cat Car X'), ring1 = ours(tracks).find((item) => item.name === 'Cat Ring 1');
    assert.deepEqual(summary(await cat('A', `car=${x.id}`)), [['Cat Ring 1', 'lmu', 2], ['Cat Ring 2', 'lmu', 1]], 'the tracks the car has public laps on');
    assert.deepEqual(summary(await cat('A', `kind=car&track=${ring1.id}`)), [['Cat Car X', 'lmu', 2], ['Cat Car Y', 'lmu', 1]], 'the cars with public laps on the track');
    assert.deepEqual((await cat('A', `kind=car&track=${ring1.id}&game=acc`)).body.items, [], 'no car of another game');
    // It follows the profile and the blocks at once.
    await setVisibility('C', 'public');
    assert.deepEqual(summary(await cat('A')).map(([name]) => name), ['Cat Ring 1', 'Cat Ring 2', 'Cat Ring 3', 'Cat Ring 7']);
    await setVisibility('C', 'friends');
    assert.deepEqual(summary(await cat('A')).map(([name]) => name), ['Cat Ring 1', 'Cat Ring 2', 'Cat Ring 7'], 'friends-only is not public');
    assert.equal((await api.A(`/friends/${(await profileOf('B')).handle}/block`, { method: 'POST' })).status, 200);
    assert.deepEqual(summary(await cat('A')), [['Cat Ring 1', 'lmu', 3], ['Cat Ring 7', 'acc', 1]], 'a person the viewer blocked is not counted');
    assert.deepEqual(summary(await cat('A', 'kind=car')).find(([name]) => name === 'Cat Car X'), ['Cat Car X', 'lmu', 2]);
    assert.deepEqual(summary(await cat('B')), [['Cat Ring 2', 'lmu', 1]], 'nor is the person who blocked the viewer: B sees only their own');
    assert.deepEqual(summary(await cat('D')).map(([name]) => name), ['Cat Ring 1', 'Cat Ring 2', 'Cat Ring 7'], 'somebody else is not affected');
    await direct.query('UPDATE public.sim_profiles SET hidden = true WHERE user_id = $1', [ids.A]);
    assert.deepEqual(summary(await cat('D')).map(([name]) => name), ['Cat Ring 2'], 'a hidden profile takes its laps off the catalog');
    await direct.query('UPDATE public.sim_profiles SET hidden = false WHERE user_id = $1', [ids.A]);

    // Cursor paging: two at a time, every item once, in the same order as one big page.
    const whole = (await cat('D', 'limit=100')).body;
    assert.equal(whole.nextCursor, null);
    assert.ok(whole.items.length >= 4);
    const walked = []; let cursor = null, pages = 0;
    do {
      const r = await cat('D', `limit=5${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.items.length <= 5);
      if (r.body.nextCursor) assert.match(r.body.nextCursor, /^[A-Za-z0-9_-]+$/);
      walked.push(...r.body.items); cursor = r.body.nextCursor; pages++;
    } while (cursor && pages < 100);
    assert.deepEqual(walked.map((item) => item.id), whole.items.map((item) => item.id));
    assert.equal(new Set(walked.map((item) => item.id)).size, walked.length, 'none twice');
    assert.ok(pages > 1);
    assert.equal((await cat('D', 'limit=1000')).body.items.length, whole.items.length, 'a big limit is read as 100');

    // Errors, like everywhere else.
    problem(await cat('A', 'kind=lap'), 400, 'invalid_kind');
    problem(await cat('A', 'game=Not A Game'), 400, 'invalid_game');
    problem(await cat('A', 'track=zzz'), 400, 'invalid_track');
    problem(await cat('A', 'car=zzz'), 400, 'invalid_car');
    problem(await cat('A', 'limit=0'), 400, 'invalid_limit');
    problem(await cat('A', 'cursor=%%%'), 400, 'invalid_cursor');
    problem(await cat('A', `cursor=${Buffer.from(JSON.stringify(['x', 'not-a-uuid'])).toString('base64url')}`), 400, 'invalid_cursor');
    problem(await call(v1, '/api/sim/v1/leaderboards/catalog'), 401, 'unauthorized');
    problem(await api.A('/leaderboards/catalog', { method: 'POST' }), 405, 'method_not_allowed');
    assert.equal((await api.A('/leaderboards/catalog', { method: 'POST' })).headers.get('allow'), 'GET');
    problem(await api.A('/leaderboards'), 404, 'not_found');
    problem(await api.A('/leaderboards/other'), 404, 'not_found');
    // It counts every public lap, so it is limited per person: 60 a minute.
    let last;
    for (let i = 0; i < 61; i++) last = await cat('C', 'limit=1');
    problem(last, 429, 'too_many_requests');
    assert.ok(Number(last.headers.get('retry-after')) >= 1);
    assert.equal((await cat('D', 'limit=1')).status, 200, 'the limit is per person');
  });

  await check('shares: each link in the list says what it is about (track, car and lap time for a lap; track, car, kind and laps for a session)', async () => {
    const first = await put('A', { track: 'Shareable Ring', car: 'Shareable Car', timeMs: 88_888, number: 1 });
    await put('A', { track: 'Shareable Ring', car: 'Shareable Car', timeMs: 90_000, number: 2 });
    const sessionId = (await lapRow(first)).session_id;
    await direct.query("UPDATE public.sim_sessions SET kind = 'race' WHERE id = $1", [sessionId]);
    const lapLink = await api.A('/shares', { method: 'POST', body: { lapId: first } });
    const sessionLink = await api.A('/shares', { method: 'POST', body: { sessionId, expiresInDays: 30 } });
    assert.deepEqual([lapLink.status, sessionLink.status], [201, 201]);
    assert.deepEqual(Object.keys(lapLink.body.share).sort(), ['active', 'createdAt', 'expiresAt', 'id', 'kind', 'lapId', 'revokedAt', 'sessionId'], 'creating one answers as before');
    const list = (await api.A('/shares')).body.shares;
    const byId = Object.fromEntries(list.map((share) => [share.id, share]));
    const lap = byId[lapLink.body.share.id], session = byId[sessionLink.body.share.id];
    const KEYS = ['active', 'carName', 'createdAt', 'expiresAt', 'id', 'kind', 'lapCount', 'lapId', 'lapMs', 'revokedAt', 'sessionId', 'sessionKind', 'trackName'];
    assert.deepEqual(Object.keys(lap).sort(), KEYS);
    assert.deepEqual(Object.keys(session).sort(), KEYS);
    assert.deepEqual([lap.kind, lap.trackName, lap.carName, lap.lapMs, lap.sessionKind, lap.lapCount], ['lap', 'Shareable Ring', 'Shareable Car', 88_888, null, null]);
    assert.deepEqual([session.kind, session.trackName, session.carName, session.lapMs, session.sessionKind, session.lapCount], ['session', 'Shareable Ring', 'Shareable Car', null, 'race', 2]);
    // The names are the catalog's: a revoked link still says what it was.
    assert.equal((await api.A(`/shares/${lapLink.body.share.id}`, { method: 'DELETE' })).status, 204);
    const revoked = (await api.A('/shares')).body.shares.find((share) => share.id === lapLink.body.share.id);
    assert.deepEqual([revoked.active, revoked.trackName, revoked.lapMs], [false, 'Shareable Ring', 88_888]);
    // A session with more laps says so, and deleting the lap takes its link away.
    await put('A', { track: 'Shareable Ring', car: 'Shareable Car', timeMs: 91_000, number: 3 });
    assert.equal((await api.A('/shares')).body.shares.find((share) => share.id === sessionLink.body.share.id).lapCount, 3);
    // Only the owner's links, and paging still works with the new fields.
    assert.deepEqual((await api.B('/shares')).body.shares, []);
    const many = await Promise.all([1, 2, 3].map(() => api.A('/shares', { method: 'POST', body: { sessionId } })));
    assert.ok(many.every((r) => r.status === 201));
    const walked = await listAll('A', '/shares', 'shares');
    assert.equal(new Set(walked.map((share) => share.id)).size, walked.length);
    assert.ok(walked.every((share) => share.trackName === 'Shareable Ring' && !('_k' in share) && !('_i' in share)));
    assert.equal((await api.A('/shares?limit=2')).body.shares.length, 2);
  });

  await check('friend requests: GET /friends/requests/count says how many people wait for an answer, the same people the incoming list shows', async () => {
    const handle = async (who) => (await profileOf(who)).handle;
    const count = async (who) => (await api[who]('/friends/requests/count'));
    const ha = await handle('A');
    assert.deepEqual([(await count('A')).status, (await count('A')).body], [200, { incoming: 0 }]);
    for (const who of ['C', 'D', 'E']) assert.equal((await api[who]('/friends/requests', { method: 'POST', body: { handle: ha } })).status, 201);
    assert.deepEqual((await count('A')).body, { incoming: 3 });
    assert.deepEqual((await count('C')).body, { incoming: 0 }, 'a request sent is not a request waiting');
    assert.equal((await api.A('/friends?status=incoming')).body.friends.length, 3, 'the same people the list shows');
    // Answering one, either way, takes it off the count.
    assert.equal((await api.A(`/friends/requests/${await handle('C')}/accept`, { method: 'POST' })).status, 200);
    assert.deepEqual((await count('A')).body, { incoming: 2 });
    assert.equal((await api.A(`/friends/requests/${await handle('D')}/decline`, { method: 'POST' })).status, 204);
    assert.deepEqual((await count('A')).body, { incoming: 1 });
    // A hidden profile is not on the list, so it is not counted; a block removes the request.
    await direct.query('UPDATE public.sim_profiles SET hidden = true WHERE user_id = $1', [ids.E]);
    assert.deepEqual([(await count('A')).body.incoming, (await api.A('/friends?status=incoming')).body.friends.length], [0, 0]);
    await direct.query('UPDATE public.sim_profiles SET hidden = false WHERE user_id = $1', [ids.E]);
    assert.deepEqual((await count('A')).body, { incoming: 1 });
    assert.equal((await api.A(`/friends/${await handle('E')}/block`, { method: 'POST' })).status, 200);
    assert.deepEqual((await count('A')).body, { incoming: 0 });
    // A person who has no profile yet has nothing waiting, and asking does not make one.
    const quiet = await token('uid-no-profile', { phone_number: '+15550000077' });
    assert.equal((await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${quiet}` } }))).status, 200);
    const fresh = await call(v1, '/api/sim/v1/friends/requests/count', { bearer: quiet });
    assert.deepEqual([fresh.status, fresh.body], [200, { incoming: 0 }]);
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM public.sim_profiles p JOIN public.app_accounts a ON a.id = p.user_id WHERE a.phone = '+15550000077'")).rows[0].n, 0);
    // Errors, and the neighbours of the path are as they were.
    problem(await call(v1, '/api/sim/v1/friends/requests/count'), 401, 'unauthorized');
    problem(await api.A('/friends/requests/count', { method: 'POST' }), 405, 'method_not_allowed');
    assert.equal((await api.A('/friends/requests/count', { method: 'POST' })).headers.get('allow'), 'GET');
    problem(await api.A('/friends/requests/count/accept', { method: 'POST' }), 404, 'request_not_found');
    problem(await api.A('/friends/requests/count/extra/more', { method: 'POST' }), 404, 'not_found');
  });

  await check('upgrade: a database at the previous schema with laps in it keeps every row, and then ingests, ranks and erases', async () => {
    const upgradeUrl = `postgres://postgres:postgres@127.0.0.1:${upgradePort}/postgres`;
    const before = mkdtempSync(resolve(temp, 'migrations-before-'));
    for (const name of listMigrations(MIGRATIONS_DIR).filter((file) => file < '20261113170000')) copyFileSync(resolve(MIGRATIONS_DIR, name), resolve(before, name));
    assert.ok(listMigrations(MIGRATIONS_DIR).some((file) => file.startsWith('20261113170000_sim_social')), 'the social migration exists');
    const client = new pg.Client({ connectionString: upgradeUrl });
    await client.connect();
    try {
      await migrate(client, { dir: before });
      assert.equal((await client.query("SELECT to_regclass('public.sim_profiles') IS NULL AS missing")).rows[0].missing, true, 'the database is as it was before the social side');
      const [u1, u2] = ['ddd00000-0000-4000-8000-000000000001', 'ddd00000-0000-4000-8000-000000000002'];
      for (const id of [u1, u2]) await client.query('INSERT INTO public.app_accounts(id, email) VALUES ($1, $2)', [id, `${id}@example.com`]);
      // The current schema, with laps and a session and personal bests, made by the Phase 1 ingest itself.
      const lapJson = (identity, ms, extra = {}) => JSON.stringify({ identity, game: 'lmu', track_name: 'Upgrade Ring', track_length_m: 5000, car_name: 'Upgrade Car', lap_number: 1, time_ms: ms,
        valid: true, started_at: '2026-11-10T10:00:00.000Z', sample_count: 3, size_bytes: 100, storage_path: `legacy/${identity}`, format_version: 2, ...extra });
      for (const [user, identity, ms] of [[u1, 'old-1', 91_000], [u1, 'old-2', 90_000], [u2, 'old-3', 92_000]]) {
        const made = (await client.query('SELECT public.sim_ingest_lap($1, NULL, $2::jsonb, 1000000) AS r', [user, lapJson(identity, ms)])).rows[0].r;
        assert.equal(made.status, 'created');
      }
      const snapshot = async () => ({
        laps: (await client.query('SELECT id, user_id, identity, game, track_name, car_name, time_ms, valid, started_at, track_id, car_id, session_id, storage_path FROM public.sim_laps ORDER BY identity')).rows,
        sessions: (await client.query('SELECT * FROM public.sim_sessions ORDER BY id')).rows,
        bests: (await client.query('SELECT * FROM public.sim_personal_bests ORDER BY user_id')).rows,
      });
      const legacy = await snapshot();
      assert.equal(legacy.laps.length, 3);
      assert.equal(legacy.bests.length, 2);

      const applied = await migrate(client);
      // The upgrade starts with the social migration, the site's and the server gaps'; later additive migrations (the dashboard's 20261113194500 ...) may follow.
      assert.deepEqual(applied.applied.filter((name) => name.startsWith('20261113')).map((name) => name.slice(0, 14)).slice(0, 3), ['20261113170000', '20261113180000', '20261113190000']);
      assert.deepEqual(await snapshot(), legacy, 'every row, session and personal best is as it was');
      const columns = (await client.query('SELECT plausible, plausibility, hidden FROM public.sim_laps ORDER BY identity')).rows;
      assert.deepEqual(columns.map((c) => [c.plausible, c.plausibility, c.hidden]), [[null, null, false], [null, null, false], [null, null, false]], 'old laps: no verdict yet, not hidden');
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.sim_profiles')).rows[0].n, 0, 'no profile is made by the migration');

      // The ingest keeps working, now with the verdict and a profile.
      const made = (await client.query('SELECT public.sim_ingest_lap($1, NULL, $2::jsonb, 1000000) AS r', [u1, lapJson('new-1', 89_000, { started_at: '2026-11-11T10:00:00.000Z', plausible: true, plausibility: { v: 1, failed: [] } })])).rows[0].r;
      assert.equal(made.status, 'created');
      const dup = (await client.query('SELECT public.sim_ingest_lap($1, NULL, $2::jsonb, 1000000) AS r', [u1, lapJson('new-1', 89_000, { started_at: '2026-11-11T10:00:00.000Z' })])).rows[0].r;
      assert.deepEqual([dup.status, dup.id], ['duplicate', made.id]);
      const fresh = (await client.query('SELECT plausible, plausibility FROM public.sim_laps WHERE id = $1', [made.id])).rows[0];
      assert.deepEqual([fresh.plausible, fresh.plausibility], [true, { v: 1, failed: [] }]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.sim_profiles WHERE user_id = $1', [u1])).rows[0].n, 1, 'the first lap after the upgrade makes the profile');
      // An old server (no verdict in the call) leaves it unknown, which is on no board.
      const noVerdict = (await client.query('SELECT public.sim_ingest_lap($1, NULL, $2::jsonb, 1000000) AS r', [u2, lapJson('new-2', 80_000, { started_at: '2026-11-12T10:00:00.000Z' })])).rows[0].r;
      assert.equal((await client.query('SELECT plausible FROM public.sim_laps WHERE id = $1', [noVerdict.id])).rows[0].plausible, null);

      const track = (await client.query("SELECT id FROM public.sim_track_catalog WHERE name = 'Upgrade Ring'")).rows[0].id, car = (await client.query("SELECT id FROM public.sim_car_catalog WHERE name = 'Upgrade Car'")).rows[0].id;
      const rank = async (viewer) => (await client.query('SELECT public.sim_leaderboard($1, $2, $3, $4) AS r', [viewer, track, car, 'public'])).rows[0].r.map((e) => [e.timeMs, e.rank]);
      assert.deepEqual(await rank(u2), [[89_000, 1]], 'only the lap with a verdict ranks; the old ones wait for the recheck');
      // The recheck gives the old laps their verdict, and they rank by their best.
      for (const row of legacy.laps) await client.query('SELECT public.sim_set_plausibility($1, true, $2::jsonb)', [row.id, '{"v":1,"failed":[]}']);
      await client.query('SELECT public.sim_ensure_profile($1)', [u2]);
      assert.deepEqual(await rank(u2), [[89_000, 1], [92_000, 2]], 'u1\'s best is the new lap, u2\'s the old one');
      // Deleting an old lap still corrects the session and the personal best (the Phase 1 triggers).
      await client.query('DELETE FROM public.sim_laps WHERE identity = $1', ['new-1']);
      assert.deepEqual(await rank(u2), [[90_000, 1], [92_000, 2]]);
      // The erase function works on an upgraded database.
      const erased = (await client.query('SELECT public.sim_delete_my_data($1) AS r', [u1])).rows[0].r;
      assert.deepEqual([erased.deleted.laps, erased.deleted.profile, erased.lapPaths.length], [2, true, 2]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1', [u1])).rows[0].n, 0);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1', [u2])).rows[0].n, 2);
    } finally {
      await client.end();
    }
  });

  await check('privacy: every answer of the suite was scanned for an e-mail, a phone, a real name, a sign-in id, an account id and private keys', async () => {
    assert.ok(scanned > 500, `${scanned} responses scanned`);
    assert.ok(secrets.length >= 6 * 5);
    // And the fixtures really are in the database, so the scan could have caught a leak.
    const row = (await direct.query('SELECT email, full_name, phone FROM public.app_accounts WHERE id = $1', [ids.A])).rows[0];
    assert.deepEqual([row.email, row.full_name, row.phone], ['a.secret@example.com', 'Ana Realname', '+15550000001']);
  });

  console.log(`${checks.length} sim social checks passed (${scanned} responses scanned for leaks):\n- ${checks.join('\n- ')}`);
} finally {
  await new Promise((done) => (webServer ? (webServer.closeAllConnections?.(), webServer.close(done)) : done())).catch(() => {});
  await direct.end().catch(() => {});
  await server.stop().catch(() => {});
  await upgradeServer.stop().catch(() => {});
  await db.close().catch(() => {});
  await upgradeDb.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
