// Phase 1 racing data model (docs/platform/PHASE-1-DATA-MODEL.md, API in docs/platform/API-V1.md) on the app's own backend:
// real PostgreSQL via PGlite, a real file folder, real row level security. Catalog and aliases, sessions, personal bests, the
// atomic upload, the account quota and the database rate limit, the backfill of laps that already exist, and API v1.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
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
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-sim-v1-'));
const filesRoot = mkdtempSync(resolve(temp, 'files-'));
const port = 55471, upgradePort = 55472;
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATA_BACKEND: 'own', DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', STORAGE_DIR: filesRoot,
  STORAGE_SECRET: 'test-secret', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
});

await build({
  entryPoints: {
    pair: 'api/sim/pair.ts', laps: 'api/sim/laps.ts', codes: 'api/sim/codes.ts', devices: 'api/sim/devices.ts', tracks: 'api/sim/tracks.ts',
    me: 'api/sim/me.ts', v1: 'api/sim/v1.ts', sweep: 'api/sim/_sweep.ts', summary: 'api/sim/_summary.ts', v1cache: 'api/sim/_v1cache.ts',
    shared: 'api/sim/_shared.ts', webserver: 'server/index.ts', lapfile: 'src/lib/sim/lap-file.ts', serverdb: 'server/db.ts',
    identity: 'server/identity.ts', account: 'server/account-route.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error', plugins: [edgeFunctions],
});
const load = (name, query = '') => import(pathToFileURL(resolve(temp, name)).href + query);
const pair = (await load('pair.mjs')).default, laps = (await load('laps.mjs')).default;
const codes = (await load('codes.mjs')).default, devices = (await load('devices.mjs')).default;
const me = (await load('me.mjs')).default, v1 = (await load('v1.mjs')).default;
const { sweepOrphanLaps } = await load('sweep.mjs');
const { topSpeedKmh, fuelUsedL } = await load('summary.mjs');
const { cachedOverview, rememberOverview, forgetAllOverviews, OVERVIEW_TTL_MS } = await load('v1cache.mjs');
const { createXpeedServer } = await load('webserver.mjs');
const { forgetLimits, MAX_ACCOUNT_BYTES } = await load('shared.mjs');
const { getPool } = await load('serverdb.mjs');
const { gzipLap } = await load('lapfile.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createAccountRoute } = await load('account.mjs');

const checks = [];
let resetRates;
// The in-memory limiters and the database's upload counters (sim_rate) both start from zero for every check.
const check = async (name, test) => { forgetLimits(); if (resetRates) await resetRates(); await test(); checks.push(name); };
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
const upgradeDb = await PGlite.create();
const upgradeServer = new PGLiteSocketServer({ db: upgradeDb, port: upgradePort, host: '127.0.0.1' });
await upgradeServer.start();
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
  const accounts = createAccountRoute();
  const tokens = {}, ids = {};
  for (const [name, phone] of [['A', 1], ['B', 2], ['C', 3], ['D', 4]]) {
    tokens[name] = await token(`uid-${name.toLowerCase()}`, { phone_number: `+1555000000${phone}` });
    const r = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${tokens[name]}` } }));
    assert.equal(r.status, 200);
    ids[name] = (await r.json()).id;
  }
  const { A, B, C, D } = tokens;

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

  /** One lap file. `speed` (m/s) and `fuel` (l) are three readings each; the rest of the header can be overridden. */
  const makeLap = ({ number = 1, timeMs = 1000, valid = true, startedAt = '2026-11-10T12:00:00.000Z', track = 'Test Track', car = 'Test Car', game = 'lmu',
    carClass, trackLength = 20, sectorsMs, speed, fuel, ...header } = {}) => {
    const channels = [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }];
    const data = { t: new Float32Array([0, 0.5, 1]), dist: new Float32Array([0, 10, 20]) };
    if (speed) { channels.push({ id: 'speed', unit: 'm/s' }); data.speed = new Float32Array(speed); }
    if (fuel) { channels.push({ id: 'fuel', unit: 'l' }); data.fuel = new Float32Array(fuel); }
    return gzipLap({
      header: {
        game, track: { name: track, lengthM: trackLength }, car: { name: car, ...(carClass ? { class: carClass } : {}) },
        lap: { number, timeMs, valid, ...(sectorsMs ? { sectorsMs } : {}) }, startedAt, sampleRateHz: 2, sampleCount: 3, channels, ...header,
      },
      data,
    });
  };
  let sent = 0;
  /** Uploads one lap and returns its id; the upload counters are reset now and then so a long scenario is not throttled. */
  const put = async (rig, spec) => {
    if (++sent % 40 === 0) await resetRates();
    const r = await upload(rig.token, await makeLap(spec));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id;
  };
  const lapRow = async (id) => (await direct.query('SELECT * FROM public.sim_laps WHERE id = $1', [id])).rows[0];
  const sessionOf = async (id) => (await direct.query('SELECT * FROM public.sim_sessions WHERE id = $1', [id])).rows[0];
  const bestOf = async (userId, game, track, car) => (await direct.query(
    `SELECT b.* FROM public.sim_personal_bests b JOIN public.sim_track_catalog t ON t.id = b.track_id JOIN public.sim_car_catalog c ON c.id = b.car_id
     WHERE b.user_id = $1 AND t.game = $2 AND t.name = $3 AND c.name = $4`, [userId, game, track, car])).rows[0];
  const MIN = 60_000, T0 = Date.parse('2026-11-01T10:00:00.000Z');
  const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();

  // ================================================================== normalization, catalog and aliases

  await check('normalization: sim_norm lower-cases, strips accents and punctuation, collapses spaces, keeps other scripts', async () => {
    const norm = async (text) => (await direct.query('SELECT public.sim_norm($1) AS n', [text])).rows[0].n;
    assert.equal(await norm('Circuit de la Sarthe'), 'circuit de la sarthe');
    assert.equal(await norm('  Spa-Francorchamps  (GP) '), 'spa francorchamps gp');
    assert.equal(await norm('Nürburgring Nordschleife'), 'nurburgring nordschleife');
    assert.equal(await norm('Autódromo José Carlos Pace — Interlagos'), 'autodromo jose carlos pace interlagos');
    assert.equal(await norm('Ferrari_499P  #51'), 'ferrari 499p 51');
    assert.equal(await norm('Škoda  Rapid\tŽilina'), 'skoda rapid zilina');
    assert.equal(await norm('MONZA'), await norm('monza'));
    assert.equal(await norm('Łódź Ñandú'), 'lodz nandu');
    assert.equal(await norm('鈴鹿サーキット'), '鈴鹿サーキット', 'a track named in Japanese is not reduced to nothing');
    assert.equal(await norm('Трасса Сочи'), 'трасса сочи');
    assert.equal(await norm('***'), '');
    assert.equal(await norm(''), '');
    assert.equal((await direct.query('SELECT public.sim_norm(NULL) AS n')).rows[0].n, '');
  });

  await check('aliases: a name is resolved to one catalog row however it is spelled, and a new name creates the row and its alias once', async () => {
    const resolve = async (fn, game, name) => (await direct.query(`SELECT public.${fn}($1, $2) AS id`, [game, name])).rows[0].id;
    const first = await resolve('sim_resolve_track', 'lmu', 'Circuit de la Sarthe');
    const again = await resolve('sim_resolve_track', 'lmu', 'circuit  de la SARTHE!');
    const accented = await resolve('sim_resolve_track', 'lmu', 'Círcuit dé la Sarthe');
    assert.equal(again, first);
    assert.equal(accented, first);
    const count = async (table, where, args) => (await direct.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, args)).rows[0].n;
    assert.equal(await count('sim_track_catalog', "game = 'lmu' AND slug = 'circuit-de-la-sarthe'"), 1, 'one catalog row');
    assert.equal(await count('sim_track_alias', 'track_id = $1', [first]), 1, 'one alias: the spellings normalize to the same one');
    const row = (await direct.query('SELECT name, slug, game FROM public.sim_track_catalog WHERE id = $1', [first])).rows[0];
    assert.deepEqual({ ...row }, { name: 'Circuit de la Sarthe', slug: 'circuit-de-la-sarthe', game: 'lmu' }, 'the first spelling seen is the display name');
    assert.notEqual(await resolve('sim_resolve_track', 'acc', 'Circuit de la Sarthe'), first, 'another game has its own track');
    assert.notEqual(await resolve('sim_resolve_track', 'lmu', 'Circuit de Spa'), first);
    // The same for cars, and a car's class is kept once.
    const car = (await direct.query("SELECT public.sim_resolve_car('lmu', 'Toyota GR010', 'Hypercar') AS id")).rows[0].id;
    assert.equal(await resolve('sim_resolve_car', 'lmu', 'TOYOTA gr010'), car);
    assert.equal(await count('sim_car_catalog', "game = 'lmu' AND slug = 'toyota-gr010'"), 1);
    assert.equal((await direct.query('SELECT class FROM public.sim_car_catalog WHERE id = $1', [car])).rows[0].class, 'Hypercar');
    // A track length is learned once, from the first lap that carries it.
    const long = (await direct.query("SELECT public.sim_resolve_track('lmu', 'Length Ring', NULL) AS id")).rows[0].id;
    await direct.query("SELECT public.sim_resolve_track('lmu', 'length ring', 4200)");
    await direct.query("SELECT public.sim_resolve_track('lmu', 'LENGTH RING', 9999)");
    assert.equal((await direct.query('SELECT length_m FROM public.sim_track_catalog WHERE id = $1', [long])).rows[0].length_m, 4200);
    // A name with nothing to normalize still resolves (to "unknown"), and an upload with it is accepted.
    const odd = await resolve('sim_resolve_track', 'lmu', '***');
    assert.equal((await direct.query('SELECT slug FROM public.sim_track_catalog WHERE id = $1', [odd])).rows[0].slug, 'unknown');
    // Metadata strings are limited in the database too.
    await assert.rejects(direct.query("INSERT INTO public.sim_track_catalog(game, slug, name) VALUES ('lmu', 'long', $1)", ['x'.repeat(121)]));
    await assert.rejects(direct.query("INSERT INTO public.sim_car_catalog(game, slug, name) VALUES ('Bad Game', 'x', 'x')"));
  });

  await check('catalog and personal data access: the catalogs are readable by a signed-in person, never writable, sessions and bests are only the owner\'s', async () => {
    const asPerson = async (userSub, sql, args = []) => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE authenticated');
        await client.query("SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
          JSON.stringify({ iss: 'https://securetoken.google.com/skaleclub', aud: 'skaleclub', sub: userSub, firebase: { sign_in_provider: 'phone' } }), userSub]);
        const result = await client.query(sql, args);
        return result.rows;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };
    const rigA = await deviceFor(A, 'ACCESS');
    await put(rigA, { track: 'Access Ring', car: 'Access Car', number: 1, startedAt: at(0) });
    assert.ok((await asPerson('uid-b', 'SELECT id FROM public.sim_track_catalog')).length >= 1, 'B reads the catalog');
    assert.ok((await asPerson('uid-b', 'SELECT alias_norm FROM public.sim_car_alias')).length >= 1);
    assert.equal((await asPerson('uid-b', 'SELECT id FROM public.sim_sessions')).length, 0, 'B reads none of A\'s sessions');
    assert.equal((await asPerson('uid-b', 'SELECT track_id FROM public.sim_personal_bests')).length, 0);
    assert.equal((await asPerson('uid-b', 'SELECT id FROM public.sim_laps WHERE user_id = $1', [ids.A])).length, 0);
    assert.ok((await asPerson('uid-a', 'SELECT id FROM public.sim_sessions')).length >= 1, 'A reads their own');
    assert.ok((await asPerson('uid-a', 'SELECT track_id, session_id FROM public.sim_laps')).every((r) => r.track_id && r.session_id));
    for (const sql of ["INSERT INTO public.sim_track_catalog(game, slug, name) VALUES ('lmu', 'hacked', 'hacked')", "DELETE FROM public.sim_car_alias", "UPDATE public.sim_sessions SET kind = 'race'",
      'SELECT * FROM public.sim_rate', "SELECT public.sim_resolve_track('lmu', 'x')", "SELECT public.sim_ingest_lap(NULL, NULL, '{}'::jsonb, 1)", 'SELECT public.sim_backfill_platform()']) {
      await assert.rejects(asPerson('uid-a', sql), /permission denied|row-level security/, sql);
    }
  });

  // ================================================================== sessions

  await check('sessions: the Companion\'s session id groups laps whatever the gap; a lap without one is inferred, and never joins it', async () => {
    const rig = await deviceFor(A, 'SESSIONS');
    const one = await put(rig, { track: 'Companion Ring', number: 1, startedAt: at(0), sessionId: 'sess-1', sessionKind: 'race', weather: 'Rain', airTempC: 14.5, trackTempC: 19 });
    const two = await put(rig, { track: 'Companion Ring', number: 2, startedAt: at(180), sessionId: 'sess-1' }); // three hours later, same id
    const other = await put(rig, { track: 'Companion Ring', number: 3, startedAt: at(181), sessionId: 'sess-2' });
    const bare = await put(rig, { track: 'Companion Ring', number: 4, startedAt: at(182) }); // no id: its own inferred session
    const [l1, l2, l3, l4] = await Promise.all([one, two, other, bare].map(lapRow));
    assert.equal(l1.session_id, l2.session_id, 'the same Companion id is one session');
    assert.notEqual(l3.session_id, l1.session_id, 'another id is another session');
    assert.notEqual(l4.session_id, l1.session_id);
    assert.notEqual(l4.session_id, l3.session_id, 'an inferred session is not a Companion one');
    const s1 = await sessionOf(l1.session_id);
    assert.deepEqual([s1.origin, s1.companion_session_id, s1.kind, s1.weather, s1.air_temp_c, s1.track_temp_c, s1.lap_count], ['companion', 'sess-1', 'race', 'Rain', 14.5, 19, 2]);
    assert.equal(new Date(s1.started_at).toISOString(), at(0));
    assert.equal(new Date(s1.ended_at).toISOString(), new Date(T0 + 180 * MIN + 1000).toISOString(), 'the span covers the lap that came three hours later');
    assert.equal((await sessionOf(l4.session_id)).origin, 'inferred');
    // The same Companion id on another car is another session: a session is one car on one track.
    const swap = await put(rig, { track: 'Companion Ring', car: 'Other Car', number: 5, startedAt: at(183), sessionId: 'sess-1' });
    assert.notEqual((await lapRow(swap)).session_id, l1.session_id);
    // An unknown kind is read as unknown.
    const odd = await put(rig, { track: 'Companion Ring', number: 6, startedAt: at(400), sessionId: 'sess-9', sessionKind: 'warmup' });
    assert.equal((await sessionOf((await lapRow(odd)).session_id)).kind, 'unknown');
  });

  await check('sessions: without a Companion id a break of up to 30 minutes keeps a session, longer starts one, and another car splits', async () => {
    const rig = await deviceFor(A, 'GAPS');
    // Laps last 3.5 minutes (210 s). The break counts from the end of a lap to the start of the next.
    const lap = (number, minute, extra = {}) => put(rig, { track: 'Gap Ring', number, timeMs: 210_000, startedAt: at(minute), ...extra });
    const a = await lap(1, 0), b = await lap(2, 4), c = await lap(3, 8);
    const justInTime = await lap(4, 11.5 + 30); // starts exactly 30 minutes after lap 3 ended: still the same session (the site's rule)
    const tooLate = await lap(5, 41.5 + 3.5 + 31); // 31 minutes after the previous ended: a new session
    const next = await lap(6, 41.5 + 3.5 + 31 + 5);
    const otherCar = await lap(7, 12, { car: 'Gap Car Two' }); // inside the first session's time, but another car
    const rows = await Promise.all([a, b, c, justInTime, tooLate, next, otherCar].map(lapRow));
    const [sa, sb, sc, sj, st, sn, so] = rows.map((r) => r.session_id);
    assert.deepEqual([sa === sb, sb === sc, sc === sj], [true, true, true], 'one session up to and at the 30 minute limit');
    assert.notEqual(st, sj, 'a 31 minute break starts a session');
    assert.equal(sn, st);
    assert.notEqual(so, sa, 'a different car is a different session');
    assert.equal((await sessionOf(sa)).lap_count, 4);
    assert.equal((await sessionOf(st)).lap_count, 2);
    assert.equal((await sessionOf(so)).lap_count, 1);
    // A lap that arrives late, from the middle of the break, joins the closest session within reach.
    const late = await lap(8, 41.5 + 3.5 + 1);
    assert.equal((await lapRow(late)).session_id, sa, 'it follows the lap before it by 1 minute, the closest session in reach');
    // Laps of another account never meet these.
    const rigB = await deviceFor(B, 'GAPS B');
    const theirs = await put(rigB, { track: 'Gap Ring', number: 1, timeMs: 210_000, startedAt: at(0) });
    assert.notEqual((await lapRow(theirs)).session_id, sa);
  });

  await check('ingest: the track, car and session are linked when the lap arrives, and the summary columns come from the file', async () => {
    const rig = await deviceFor(A, 'SUMMARY');
    const id = await put(rig, {
      track: 'Summary Ring', car: 'Summary Car', carClass: 'GT3', trackLength: 5412, number: 3, timeMs: 91234, startedAt: at(0),
      sectorsMs: [30000, 31000, 30234], speed: [10, 83.4, 50], fuel: [40.5, 40.1, 39.7], inLap: false, outLap: true,
    });
    const row = await lapRow(id);
    assert.ok(row.track_id && row.car_id && row.session_id);
    assert.deepEqual(row.sector_ms, [30000, 31000, 30234]);
    assert.equal(row.top_speed_kmh, 300.2, '83.4 m/s is 300.24 km/h, kept to 0.1');
    assert.equal(row.fuel_used_l, 0.8, 'first reading minus last, to 0.001');
    assert.deepEqual([row.in_lap, row.out_lap, row.format_version, row.reduced], [false, true, 1, false]);
    const track = (await direct.query('SELECT name, game, length_m FROM public.sim_track_catalog WHERE id = $1', [row.track_id])).rows[0];
    assert.deepEqual({ ...track }, { name: 'Summary Ring', game: 'lmu', length_m: 5412 });
    assert.deepEqual({ ...(await direct.query('SELECT name, class FROM public.sim_car_catalog WHERE id = $1', [row.car_id])).rows[0] }, { name: 'Summary Car', class: 'GT3' });
    // A file without those channels and flags leaves them null, and does not fail.
    const bare = await lapRow(await put(rig, { track: 'Summary Ring', car: 'Summary Car', number: 4, startedAt: at(5) }));
    assert.deepEqual([bare.sector_ms, bare.top_speed_kmh, bare.fuel_used_l, bare.in_lap, bare.out_lap], [null, null, null, null, null]);
    assert.equal(bare.track_id, row.track_id, 'the same track is found again');
    assert.equal(bare.session_id, row.session_id, 'and the lap joins the session five minutes after');
    // The readers behind the columns.
    assert.equal(topSpeedKmh(new Float32Array([1, NaN, 30, Infinity])), 108);
    assert.equal(topSpeedKmh(new Float32Array([NaN, NaN])), null);
    assert.equal(topSpeedKmh(new Float32Array([1000])), null, 'a speed no car reaches is a bad channel, not a column value');
    assert.equal(topSpeedKmh(undefined), null);
    assert.equal(fuelUsedL(new Float32Array([NaN, 20, 19.5, NaN, 19])), 1);
    assert.equal(fuelUsedL(new Float32Array([10, 11])), null, 'the tank went up: a refuel, not a lap\'s use');
    assert.equal(fuelUsedL(undefined), null);
  });

  // ================================================================== personal bests

  await check('personal best: the first valid lap sets it, a faster one improves it, an invalid, slower or equal one does not', async () => {
    const rig = await deviceFor(A, 'PB');
    const spec = (number, timeMs, extra = {}) => ({ track: 'PB Ring', car: 'PB Car', number, timeMs, startedAt: at(number * 10), ...extra });
    const invalidFirst = await put(rig, spec(1, 70_000, { valid: false }));
    assert.equal(await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car'), undefined, 'an invalid lap is no personal best');
    const first = await put(rig, spec(2, 100_000));
    assert.deepEqual([(await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).best_ms, (await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).lap_id], [100_000, first]);
    await put(rig, spec(3, 110_000)); // slower
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).lap_id, first);
    await put(rig, spec(4, 90_000, { valid: false })); // faster but invalid
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).lap_id, first);
    const faster = await put(rig, spec(5, 95_000));
    const best = await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car');
    assert.deepEqual([best.best_ms, best.lap_id], [95_000, faster], 'a faster valid lap improves it');
    assert.equal(new Date(best.achieved_at).toISOString(), at(50), 'achieved when the lap was driven');
    await put(rig, spec(6, 95_000)); // equal: the first to do it keeps it
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).lap_id, faster);
    // One per person, track and car.
    await put(rig, spec(7, 99_000, { car: 'PB Car Two' }));
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car Two')).best_ms, 99_000);
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).best_ms, 95_000);
    const rigB = await deviceFor(B, 'PB B');
    await put(rigB, spec(8, 120_000));
    assert.equal((await bestOf(ids.B, 'lmu', 'PB Ring', 'PB Car')).best_ms, 120_000, 'B\'s own, whatever A drove');
    assert.equal((await bestOf(ids.A, 'lmu', 'PB Ring', 'PB Car')).best_ms, 95_000);
    assert.equal((await lapRow(invalidFirst)).valid, false);
    // The session counts the valid best too.
    const session = await sessionOf((await lapRow(faster)).session_id);
    assert.equal(session.best_lap_ms, 95_000);
    assert.equal(session.lap_count, 6);
  });

  await check('personal best: deleting a lap recomputes it from the laps that remain, and a session that loses its last lap goes', async () => {
    const rig = await deviceFor(A, 'DEL');
    const spec = (number, timeMs, extra = {}) => ({ track: 'Delete Ring', car: 'Delete Car', number, timeMs, startedAt: at(number * 5), ...extra });
    const a = await put(rig, spec(1, 90_000)), b = await put(rig, spec(2, 85_000)), c = await put(rig, spec(3, 80_000, { valid: false })), d = await put(rig, spec(4, 95_000));
    const sessionId = (await lapRow(a)).session_id;
    assert.equal((await bestOf(ids.A, 'lmu', 'Delete Ring', 'Delete Car')).lap_id, b);
    assert.deepEqual([(await sessionOf(sessionId)).lap_count, (await sessionOf(sessionId)).best_lap_ms], [4, 85_000]);

    // Deleting a lap that is not the best changes nothing about the best, and counts the session down.
    assert.equal((await call(laps, `/api/sim/laps/${d}`, { method: 'DELETE', bearer: A })).status, 204);
    assert.equal((await bestOf(ids.A, 'lmu', 'Delete Ring', 'Delete Car')).lap_id, b);
    assert.equal((await sessionOf(sessionId)).lap_count, 3);
    // Deleting the best moves it to the next valid lap (the invalid faster one is not a candidate).
    assert.equal((await call(v1, `/api/sim/v1/laps/${b}`, { method: 'DELETE', bearer: A })).status, 204);
    const next = await bestOf(ids.A, 'lmu', 'Delete Ring', 'Delete Car');
    assert.deepEqual([next.lap_id, next.best_ms], [a, 90_000]);
    assert.deepEqual([(await sessionOf(sessionId)).lap_count, (await sessionOf(sessionId)).best_lap_ms], [2, 90_000]);
    // Deleting the last valid lap leaves no best; the invalid lap alone keeps the session.
    assert.equal((await call(v1, `/api/sim/v1/laps/${a}`, { method: 'DELETE', bearer: A })).status, 204);
    assert.equal(await bestOf(ids.A, 'lmu', 'Delete Ring', 'Delete Car'), undefined);
    assert.deepEqual([(await sessionOf(sessionId)).lap_count, (await sessionOf(sessionId)).best_lap_ms], [1, null]);
    assert.equal((await call(v1, `/api/sim/v1/laps/${c}`, { method: 'DELETE', bearer: A })).status, 204);
    assert.equal(await sessionOf(sessionId), undefined, 'a session with no laps is gone');
    assert.equal((await call(v1, `/api/sim/v1/laps/${c}`, { method: 'DELETE', bearer: A })).status, 404);
    // An account that goes away takes its laps, sessions and bests with it, without the triggers getting in the way.
    const gone = '5a5a5a5a-0000-4000-8000-000000000001';
    await direct.query("INSERT INTO public.app_accounts(id, email) VALUES ($1, 'gone@example.com')", [gone]);
    await direct.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
      SELECT $1::uuid, 'gone|' || n, 'lmu', 'Cascade Ring', 'Cascade Car', n, 90000 - n, true, now() - make_interval(mins => n * 40), 3, 1, 'gone/' || n FROM generate_series(1, 30) AS n`, [gone]);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_personal_bests WHERE user_id = $1', [gone])).rows[0].n, 1);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_sessions WHERE user_id = $1', [gone])).rows[0].n, 30, 'laps 40 minutes apart are 30 sessions');
    await direct.query('DELETE FROM public.app_accounts WHERE id = $1', [gone]);
    for (const table of ['sim_laps', 'sim_sessions', 'sim_personal_bests']) {
      assert.equal((await direct.query(`SELECT count(*)::int AS n FROM public.${table} WHERE user_id = $1`, [gone])).rows[0].n, 0, table);
    }
  });

  await check('an insert that does not go through the ingest (an older server, a hand-made row) is linked by the database all the same', async () => {
    await direct.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
      VALUES ($1, 'legacy|1', 'lmu', 'Legacy Ring', 'Legacy Car', 1, 77000, true, $2, 3, 10, 'legacy/1')`, [ids.B, at(0)]);
    const row = (await direct.query("SELECT * FROM public.sim_laps WHERE identity = 'legacy|1'")).rows[0];
    assert.ok(row.track_id && row.car_id && row.session_id);
    assert.equal(row.format_version, 1);
    assert.equal((await bestOf(ids.B, 'lmu', 'Legacy Ring', 'Legacy Car')).best_ms, 77000);
    assert.equal((await sessionOf(row.session_id)).lap_count, 1);
    await direct.query("DELETE FROM public.sim_laps WHERE identity = 'legacy|1'");
  });

  // ================================================================== atomic upload and the sweeper

  const lapFolder = (userId) => resolve(filesRoot, 'sim-laps', userId);
  const filesOf = (userId) => (existsSync(lapFolder(userId)) ? readdirSync(lapFolder(userId)) : []);

  await check('atomic upload: when the row cannot be inserted nothing stays visible and the file is removed', async () => {
    const rig = await deviceFor(A, 'ATOMIC');
    await direct.query(`CREATE FUNCTION public.test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await direct.query("CREATE TRIGGER aaa_boom BEFORE INSERT ON public.sim_laps FOR EACH ROW WHEN (NEW.track_name = 'Boom Ring') EXECUTE FUNCTION public.test_boom()");
    try {
      const before = {
        files: filesOf(ids.A).length,
        laps: (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps')).rows[0].n,
        sessions: (await direct.query('SELECT count(*)::int AS n FROM public.sim_sessions')).rows[0].n,
        tracks: (await direct.query('SELECT count(*)::int AS n FROM public.sim_track_catalog')).rows[0].n,
        aliases: (await direct.query('SELECT count(*)::int AS n FROM public.sim_track_alias')).rows[0].n,
      };
      const failed = await upload(rig.token, await makeLap({ track: 'Boom Ring', number: 1 }));
      assert.equal(failed.status, 503);
      assert.deepEqual(failed.body, { error: 'unavailable', retryable: true });
      assert.deepEqual({
        files: filesOf(ids.A).length,
        laps: (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps')).rows[0].n,
        sessions: (await direct.query('SELECT count(*)::int AS n FROM public.sim_sessions')).rows[0].n,
        tracks: (await direct.query('SELECT count(*)::int AS n FROM public.sim_track_catalog')).rows[0].n,
        aliases: (await direct.query('SELECT count(*)::int AS n FROM public.sim_track_alias')).rows[0].n,
      }, before, 'no row, no session, no catalog row, no file (the staging file included)');
      assert.equal(filesOf(ids.A).some((name) => name.startsWith('staging-')), false);
    } finally {
      await direct.query('DROP TRIGGER aaa_boom ON public.sim_laps');
      await direct.query('DROP FUNCTION public.test_boom()');
    }
    // The same lap sent again goes through: nothing of the failed try is in the way.
    const ok = await upload(rig.token, await makeLap({ track: 'Boom Ring', number: 1 }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.ok(existsSync(resolve(lapFolder(ids.A), (await lapRow(ok.body.id)).storage_path.split('/')[1])));
    assert.equal(filesOf(ids.A).some((name) => name.startsWith('staging-')), false, 'a good upload leaves no staging file either');
  });

  await check('atomic upload: a row exists only with its file, and two uploads of the same lap at once make one row and keep the file', async () => {
    const rig = await deviceFor(A, 'RACE');
    const bytes = await makeLap({ track: 'Race Ring', number: 1, startedAt: at(77) });
    const answers = await Promise.all([upload(rig.token, bytes), upload(rig.token, bytes), upload(rig.token, bytes)]);
    assert.equal(answers.filter((r) => r.status === 201).length, 1, JSON.stringify(answers.map((r) => r.status)));
    assert.equal(answers.filter((r) => r.status === 200 && r.body.duplicate === true).length, 2);
    assert.equal(new Set(answers.map((r) => r.body.id)).size, 1);
    const row = await lapRow(answers[0].body.id);
    assert.deepEqual(new Uint8Array(readFileSync(resolve(filesRoot, 'sim-laps', row.storage_path))), new Uint8Array(bytes));
    assert.equal((await direct.query("SELECT count(*)::int AS n FROM public.sim_laps WHERE identity = $1", [row.identity])).rows[0].n, 1);
    assert.equal((await sessionOf(row.session_id)).lap_count, 1, 'counted once');
    assert.equal(filesOf(ids.A).some((name) => name.startsWith('staging-')), false);
  });

  await check('orphan sweeper: removes old files that no row points at (staging ones too), and leaves files with a row and young ones', async () => {
    const rig = await deviceFor(B, 'SWEEP');
    const id = await put(rig, { track: 'Sweep Ring', number: 1, startedAt: at(0) });
    const owned = (await lapRow(id)).storage_path;
    const folder = lapFolder(ids.B);
    const hourAgo = new Date(Date.now() - 60 * MIN);
    const old = ['orphan-old.xlap.gz', `staging-${'0'.repeat(8)}-0000-4000-8000-000000000000.xlap.gz`];
    for (const name of [...old, 'orphan-young.xlap.gz']) writeFileSync(resolve(folder, name), 'x');
    for (const name of old) utimesSync(resolve(folder, name), hourAgo, hourAgo);
    utimesSync(resolve(filesRoot, 'sim-laps', owned), hourAgo, hourAgo); // old, but a row owns it
    mkdirSync(resolve(lapFolder(ids.A)), { recursive: true });
    writeFileSync(resolve(lapFolder(ids.A), 'orphan-other-account.xlap.gz'), 'x');
    utimesSync(resolve(lapFolder(ids.A), 'orphan-other-account.xlap.gz'), hourAgo, hourAgo);

    const swept = await sweepOrphanLaps();
    assert.deepEqual([...swept.removed].sort(), [...old.map((name) => `${ids.B}/${name}`), `${ids.A}/orphan-other-account.xlap.gz`].sort());
    assert.ok(swept.scanned >= 5);
    assert.deepEqual(filesOf(ids.B).filter((name) => name.startsWith('orphan') || name.startsWith('staging')), ['orphan-young.xlap.gz'], 'the young one stays');
    assert.ok(existsSync(resolve(filesRoot, 'sim-laps', owned)), 'a file with a row stays, however old');
    assert.equal((await sweepOrphanLaps()).removed.length, 0, 'nothing more to remove');
    const later = await sweepOrphanLaps({ now: Date.now() + 60 * MIN });
    assert.ok(later.removed.includes(`${ids.B}/orphan-young.xlap.gz`), 'once it is old enough it goes too');
    for (const path of later.removed) assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE storage_path = $1', [path])).rows[0].n, 0, 'never one a row points at');
    assert.equal((await call(laps, `/api/sim/laps/${id}/file`, { bearer: B })).status, 200, 'the lap is still downloadable');
  });

  // ================================================================== limits

  await check('quota: an account at its byte cap is refused with 422 quota (not retryable), a lap it has is still recognized, and 5000 laps are no longer a limit', async () => {
    assert.equal(MAX_ACCOUNT_BYTES, 20 * 1024 ** 3);
    const rig = await deviceFor(B, 'QUOTA');
    const known = await put(rig, { track: 'Quota Ring', number: 1, startedAt: at(0) });
    // Fillers written with the triggers off (replica role), so 5001 of them take a moment, not a minute.
    const quietly = async (work) => {
      await direct.query('SET session_replication_role = replica');
      try { return await work(); } finally { await direct.query('SET session_replication_role = origin'); }
    };
    await quietly(() => direct.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
      SELECT $1::uuid, 'filler|' || n, 'lmu', 'Filler', 'Filler', n, 90000, true, now() - make_interval(secs => n), 3, 1, 'filler/' || n FROM generate_series(1, 5001) AS n`, [ids.B]));
    const under = await upload(rig.token, await makeLap({ track: 'Quota Ring', number: 2, startedAt: at(5) }));
    assert.equal(under.status, 201, `5000 laps are not a limit any more: ${JSON.stringify(under.body)}`);
    // Now the bytes: ten fillers carry the account to 10 bytes under the cap.
    const others = Number((await direct.query("SELECT sum(size_bytes)::bigint AS n FROM public.sim_laps WHERE user_id = $1 AND identity NOT IN (SELECT 'filler|' || n FROM generate_series(1, 10) AS n)", [ids.B])).rows[0].n);
    const big = 2_147_483_647; // the largest size_bytes a row can hold
    const last = MAX_ACCOUNT_BYTES - 10 - others - 9 * big;
    assert.ok(last > 0 && last <= big, 'ten rows can carry it');
    await direct.query("UPDATE public.sim_laps SET size_bytes = CASE WHEN identity = 'filler|10' THEN $2::int ELSE $3::int END WHERE user_id = $1 AND identity IN (SELECT 'filler|' || n FROM generate_series(1, 10) AS n)", [ids.B, last, big]);
    const used = Number((await direct.query('SELECT sum(size_bytes)::bigint AS n FROM public.sim_laps WHERE user_id = $1', [ids.B])).rows[0].n);
    assert.equal(MAX_ACCOUNT_BYTES - used, 10, 'the account has room for 10 bytes');
    const files = filesOf(ids.B).length, count = async () => (await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE user_id = $1', [ids.B])).rows[0].n;
    const laps = await count();
    const refused = await upload(rig.token, await makeLap({ track: 'Quota Ring', number: 3, startedAt: at(10) }));
    assert.equal(refused.status, 422);
    assert.deepEqual(refused.body, { error: 'quota', retryable: false });
    assert.equal(filesOf(ids.B).length, files, 'no file was written for it');
    assert.equal(await count(), laps);
    // A lap the account already has is still answered as a duplicate, not refused.
    const again = await upload(rig.token, await makeLap({ track: 'Quota Ring', number: 1, startedAt: at(0) }));
    assert.deepEqual([again.status, again.body], [200, { id: known, duplicate: true }]);
    // The cap is per account: another account is not held back.
    assert.equal((await upload((await deviceFor(A, 'QUOTA A')).token, await makeLap({ track: 'Quota Ring', number: 3, startedAt: at(10) }))).status, 201);
    await quietly(() => direct.query("DELETE FROM public.sim_laps WHERE user_id = $1 AND identity LIKE 'filler|%'", [ids.B]));
    const room = await upload(rig.token, await makeLap({ track: 'Quota Ring', number: 3, startedAt: at(10) }));
    assert.equal(room.status, 201, 'with the fillers gone there is room again');
  });

  await check('rate limit: the per-device counter is in the database, so a restart or another server instance does not forget it', async () => {
    const rig = await deviceFor(B, 'RATE');
    let last;
    for (let i = 0; i < 61; i++) last = await upload(rig.token, new TextEncoder().encode('x'));
    assert.equal(last.status, 429);
    assert.equal(last.body.retryable, true);
    assert.ok(Number(last.headers.get('retry-after')) >= 1 && Number(last.headers.get('retry-after')) <= 60);
    const counter = (await direct.query("SELECT hits FROM public.sim_rate WHERE key = $1", [`lap:${rig.deviceId}`])).rows[0];
    assert.equal(counter.hits, 61, 'the counter is a row');
    // A restart: the process forgets everything it kept in memory. The database still remembers.
    forgetLimits();
    const afterRestart = await upload(rig.token, await makeLap({ track: 'Rate Ring', number: 1 }));
    assert.equal(afterRestart.status, 429, 'still limited after the in-memory state is gone');
    // Another server instance: a second copy of the handler, with its own memory, sharing the database.
    const second = (await load('laps.mjs', '?instance=2')).default;
    const fromSecond = await call(second, '/api/sim/laps', { method: 'POST', bearer: rig.token, body: await makeLap({ track: 'Rate Ring', number: 2 }), headers: { 'content-type': 'application/gzip' } });
    assert.equal(fromSecond.status, 429, 'the other instance refuses too');
    // Another device is not held back by this one's counter, and the window ends: its counter starts again.
    assert.equal((await upload((await deviceFor(B, 'RATE 2')).token, await makeLap({ track: 'Rate Ring', number: 3 }))).status, 201);
    await direct.query("UPDATE public.sim_rate SET window_start = window_start - interval '2 minutes' WHERE key = $1", [`lap:${rig.deviceId}`]);
    assert.equal((await upload(rig.token, await makeLap({ track: 'Rate Ring', number: 4 }))).status, 201, 'a new window, a new count');
    // The function itself: 0 while allowed, then the seconds to wait.
    const hit = async (key) => (await direct.query('SELECT public.sim_rate_hit($1, 2, 60) AS wait', [key])).rows[0].wait;
    assert.deepEqual([await hit('unit'), await hit('unit'), (await hit('unit')) > 0, await hit('other')], [0, 0, true, 0]);
  });

  await check('pairing is limited by address only: strangers from many addresses cannot use up a shared bucket against real people', async () => {
    let throttled = 0;
    for (let i = 0; i < 150; i++) {
      const r = await call(pair, '/api/sim/pair', { method: 'POST', body: { code: 'ABCD2345', device: { name: 'RIG' } }, ip: `10.20.${Math.floor(i / 250)}.${i % 250}` });
      if (r.status === 429) throttled++;
    }
    assert.equal(throttled, 0, 'no bucket shared by everybody');
    // The per-address limit is still there.
    let last;
    for (let i = 0; i < 11; i++) last = await call(pair, '/api/sim/pair', { method: 'POST', body: { code: 'ABCD2345', device: { name: 'RIG' } }, ip: '10.30.0.1' });
    assert.equal(last.status, 429);
  });

  // ================================================================== backfill

  await check('backfill: old laps without the new columns are linked, grouped and given personal bests; a second run changes nothing', async () => {
    const upgradeUrl = `postgres://postgres:postgres@127.0.0.1:${upgradePort}/postgres`;
    const before = mkdtempSync(resolve(temp, 'migrations-before-'));
    for (const name of listMigrations(MIGRATIONS_DIR).filter((file) => file < '20261113150000')) copyFileSync(resolve(MIGRATIONS_DIR, name), resolve(before, name));
    assert.ok(listMigrations(MIGRATIONS_DIR).some((file) => file.startsWith('20261113150000')), 'the model migration exists');
    const client = new pg.Client({ connectionString: upgradeUrl });
    await client.connect();
    try {
      await migrate(client, { dir: before });
      assert.equal((await client.query("SELECT to_regclass('public.sim_sessions') IS NULL AS missing")).rows[0].missing, true, 'the database is as it was before the model');
      const [u1, u2] = ['ccc00000-0000-4000-8000-000000000001', 'ccc00000-0000-4000-8000-000000000002'];
      for (const id of [u1, u2]) await client.query('INSERT INTO public.app_accounts(id, email) VALUES ($1, $2)', [id, `${id}@example.com`]);
      // Old-style rows: only the columns that existed. Laps last 210 s; times are minutes after 10:00.
      const old = [
        // u1, lmu, Sarthe + GR010: 10:00, 10:04, 10:08 and (spelled differently) 10:12 -> one session; 12:00, 12:04 -> a second one
        [u1, 'lmu', 'Circuit de la Sarthe', 'GR010', 1, 212_000, true, 0], [u1, 'lmu', 'Circuit de la Sarthe', 'GR010', 2, 209_500, true, 4],
        [u1, 'lmu', 'Circuit de la Sarthe', 'GR010', 3, 205_000, false, 8], [u1, 'lmu', 'circuit  de la SARTHE', 'gr010', 4, 211_000, true, 12],
        [u1, 'lmu', 'Circuit de la Sarthe', 'GR010', 5, 210_000, true, 120], [u1, 'lmu', 'Circuit de la Sarthe', 'GR010', 6, 209_500, true, 124],
        // the same track with another car at the same time: another session; another game: another track
        [u1, 'lmu', 'Circuit de la Sarthe', 'Ferrari 499P', 1, 214_000, true, 5], [u1, 'acc', 'Monza', 'Ferrari 499P', 1, 105_000, true, 0],
        // u1: every lap invalid on one combination: a session, no personal best
        [u1, 'lmu', 'Monza', 'GR010', 1, 100_000, false, 0],
        // u2 drove the same things: their own sessions and bests, the same catalog rows
        [u2, 'lmu', 'Circuit de la Sarthe', 'GR010', 1, 215_000, true, 0], [u2, 'lmu', 'Circuit de la Sarthe', 'GR010', 2, 215_000, true, 4],
      ];
      for (const [i, [user, game, track, car, number, timeMs, valid, minute]] of old.entries()) {
        await client.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 3, 100, $10)`, [user, `old|${i}`, game, track, car, number, timeMs, valid, at(minute), `${user}/old${i}.xlap.gz`]);
      }
      const legacyColumns = 'identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path, created_at, device_id, user_id';
      const legacy = async () => (await client.query(`SELECT ${legacyColumns} FROM public.sim_laps ORDER BY identity`)).rows;
      const legacyBefore = await legacy();
      assert.equal(legacyBefore.length, old.length);

      // The model and the backfill are applied the way the server applies them at boot.
      const applied = await migrate(client);
      assert.ok(applied.applied.some((name) => name.startsWith('20261113150000')), 'the model was applied');
      assert.ok(applied.applied.some((name) => name.startsWith('20261113150100')), 'and the backfill ran as a migration right after');
      assert.deepEqual(await legacy(), legacyBefore, 'nothing an existing row already had was changed');

      const snapshot = async () => ({
        laps: (await client.query('SELECT identity, track_id, car_id, session_id, format_version, reduced FROM public.sim_laps ORDER BY identity')).rows,
        sessions: (await client.query('SELECT * FROM public.sim_sessions ORDER BY id')).rows,
        bests: (await client.query('SELECT * FROM public.sim_personal_bests ORDER BY user_id, track_id, car_id')).rows,
        tracks: (await client.query('SELECT * FROM public.sim_track_catalog ORDER BY id')).rows,
        tracksAliases: (await client.query('SELECT * FROM public.sim_track_alias ORDER BY game, alias_norm')).rows,
        cars: (await client.query('SELECT * FROM public.sim_car_catalog ORDER BY id')).rows,
        carAliases: (await client.query('SELECT * FROM public.sim_car_alias ORDER BY game, alias_norm')).rows,
      });
      const first = await snapshot();

      // Every lap is linked.
      assert.equal(first.laps.length, old.length);
      for (const lap of first.laps) assert.ok(lap.track_id && lap.car_id && lap.session_id && lap.format_version === 1, JSON.stringify(lap));
      // The catalog: Sarthe, Monza (lmu), Monza (acc); GR010, Ferrari 499P (lmu), Ferrari 499P (acc). The spellings share a row.
      assert.deepEqual(first.tracks.map((t) => `${t.game}|${t.name}`).sort(), ['acc|Monza', 'lmu|Circuit de la Sarthe', 'lmu|Monza']);
      assert.deepEqual(first.cars.map((c) => `${c.game}|${c.name}`).sort(), ['acc|Ferrari 499P', 'lmu|Ferrari 499P', 'lmu|GR010']);
      // Sessions: u1 Sarthe/GR010 twice (10:00-10:15:30, and 12:00-12:07:30), Sarthe/499P, acc Monza, lmu Monza; u2 Sarthe/GR010 once.
      const byUser = (user) => first.sessions.filter((s) => s.user_id === user);
      assert.equal(byUser(u1).length, 5);
      assert.equal(byUser(u2).length, 1);
      assert.deepEqual(byUser(u1).map((s) => s.lap_count).sort(), [1, 1, 1, 2, 4]);
      assert.ok(first.sessions.every((s) => s.origin === 'inferred' && s.kind === 'unknown' && s.companion_session_id === null));
      const sarthe = byUser(u1).find((s) => s.lap_count === 4);
      assert.equal(sarthe.best_lap_ms, 209_500, 'the invalid 205 s lap does not count');
      assert.equal(new Date(sarthe.started_at).toISOString(), at(0));
      assert.equal(new Date(sarthe.ended_at).toISOString(), new Date(T0 + 12 * MIN + 211_000).toISOString());
      assert.equal(byUser(u1).find((s) => s.lap_count === 2).best_lap_ms, 209_500);
      assert.equal(byUser(u2)[0].best_lap_ms, 215_000);
      // Laps in a session are the laps with that session id.
      for (const s of first.sessions) assert.equal(first.laps.filter((l) => l.session_id === s.id).length, s.lap_count);
      // Personal bests: one per person, track and car with a valid lap; the all-invalid combination has none; ties go to the earliest.
      assert.equal(first.bests.length, 4, 'u1: Sarthe/GR010, Sarthe/499P, acc Monza/499P; u2: Sarthe/GR010; and not lmu Monza/GR010 (no valid lap)');
      const best = (user, track, car) => first.bests.find((b) => b.user_id === user && first.tracks.find((t) => t.id === b.track_id).name === track && first.cars.find((c) => c.id === b.car_id).name === car);
      assert.equal(best(u1, 'Circuit de la Sarthe', 'GR010').best_ms, 209_500);
      assert.equal(new Date(best(u1, 'Circuit de la Sarthe', 'GR010').achieved_at).toISOString(), at(4), 'the first of two equal times (10:04, not 12:04)');
      assert.equal(best(u2, 'Circuit de la Sarthe', 'GR010').best_ms, 215_000);
      assert.equal(new Date(best(u2, 'Circuit de la Sarthe', 'GR010').achieved_at).toISOString(), at(0));
      assert.equal(first.bests.some((b) => b.user_id === u1 && first.tracks.find((t) => t.id === b.track_id).game === 'lmu' && first.tracks.find((t) => t.id === b.track_id).name === 'Monza'), false);

      // A second run, by hand, changes nothing at all.
      const run = (await client.query('SELECT public.sim_backfill_platform() AS r')).rows[0].r;
      assert.deepEqual(run, { tracksResolved: 0, carsResolved: 0, lapsLinkedToTracks: 0, lapsLinkedToCars: 0, lapsPlacedInSessions: 0, sessionsCreated: 0 });
      assert.deepEqual(await snapshot(), first, 'a second run changes nothing');
      await client.query('SELECT public.sim_backfill_platform()');
      assert.deepEqual(await snapshot(), first, 'nor a third');

      // A lap an older server inserts after the backfill (a deploy overlap) is linked by the trigger, and a re-run leaves the rest alone.
      await client.query("SET session_replication_role = replica");
      await client.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
        VALUES ($1, 'late|1', 'lmu', 'Circuit de la Sarthe', 'GR010', 7, 208_000, true, $2, 3, 100, 'late/1')`, [u1, at(128)]);
      await client.query("SET session_replication_role = origin");
      const partial = (await client.query('SELECT public.sim_backfill_platform() AS r')).rows[0].r;
      assert.equal(partial.lapsLinkedToTracks, 1);
      assert.equal(partial.lapsPlacedInSessions, 1);
      assert.equal(partial.sessionsCreated, 0, 'it joins the 12:00 session instead of starting another');
      const late = (await client.query("SELECT track_id, car_id, session_id FROM public.sim_laps WHERE identity = 'late|1'")).rows[0];
      assert.ok(late.track_id && late.car_id && late.session_id);
      assert.equal((await client.query('SELECT lap_count, best_lap_ms FROM public.sim_sessions WHERE id = $1', [late.session_id])).rows[0].best_lap_ms, 208_000);
      assert.equal((await client.query("SELECT best_ms FROM public.sim_personal_bests WHERE user_id = $1 AND car_id = $2 AND track_id = $3", [u1, late.car_id, late.track_id])).rows[0].best_ms, 208_000);
    } finally {
      await client.end();
    }
  });

  // ================================================================== API v1

  const api = (path, opts = {}) => call(v1, `/api/sim/v1${path}`, { bearer: C, ...opts });
  const SEED = 250;
  /** The 250 laps of person C: i = 0..249, two tracks (lmu, acc), two cars, ten days of 25 laps, every tenth lap (all on the acc track) invalid. */
  const seed = Array.from({ length: SEED }, (_, i) => ({
    i, game: i % 2 === 0 ? 'lmu' : 'acc', track: i % 2 === 0 ? 'Paging Ring' : 'Second Ring', car: i % 5 === 0 ? 'Car Two' : 'Car One',
    timeMs: 80_000 + ((i * 7919) % 5000), valid: i % 10 !== 3, startedAt: new Date(Date.parse('2026-10-01T08:00:00.000Z') + Math.floor(i / 25) * 86_400_000 + (i % 25) * 3 * MIN).toISOString(),
  }));
  const seedFor = async (userId, rows, tag) => direct.query(`INSERT INTO public.sim_laps (user_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at, sample_count, size_bytes, storage_path)
    SELECT $1::uuid, $3 || '|' || x.i, x.game, x.track, x.car, x.i, x.time_ms, x.valid, x.started_at::timestamptz, 3, 1000, $3 || '/' || x.i
    FROM jsonb_to_recordset($2::jsonb) AS x(i int, game text, track text, car text, time_ms int, valid boolean, started_at text)`,
  [userId, JSON.stringify(rows.map((r) => ({ i: r.i, game: r.game, track: r.track, car: r.car, time_ms: r.timeMs, valid: r.valid, started_at: r.startedAt }))), tag]);
  await seedFor(ids.C, seed, 'seedc'); // as an older server would insert them: the database links them
  await seedFor(ids.D, seed.slice(0, 30), 'seedd');
  const rigC = await deviceFor(C, 'Sim PC');
  const lastLap = await put(rigC, { track: 'Fresh Ring', car: 'Fresh Car', number: 1, timeMs: 99_000, startedAt: '2026-11-12T09:00:00.000Z', speed: [20, 70, 30] });

  const allIds = async (path, key = 'laps', pages = 20, extra = '') => {
    const seen = []; let cursor = null, count = 0;
    do {
      const r = await api(`${path}?limit=100${extra}${cursor ? `&cursor=${cursor}` : ''}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      seen.push(...r.body[key]); cursor = r.body.nextCursor; count++;
    } while (cursor && count < pages);
    return seen;
  };

  await check('v1: signed out, a device key or a bad token is 401, and every error is { error, retryable }', async () => {
    const paths = ['/laps', '/sessions', '/tracks', '/cars', '/pbs', '/overview', '/sessions/00000000-0000-4000-8000-000000000000', '/tracks/00000000-0000-4000-8000-000000000000',
      '/cars/00000000-0000-4000-8000-000000000000', '/laps/00000000-0000-4000-8000-000000000000/file'];
    for (const path of paths) {
      for (const bearer of [undefined, 'not-a-token', rigC.token]) {
        const r = await api(path, { bearer });
        assert.equal(r.status, 401, `${path} with ${bearer ?? 'nothing'}`);
        assert.deepEqual(r.body, { error: 'unauthorized', retryable: false });
      }
    }
    const del = await api('/laps/00000000-0000-4000-8000-000000000000', { method: 'DELETE', bearer: undefined });
    assert.deepEqual([del.status, del.body], [401, { error: 'unauthorized', retryable: false }]);
    // The other errors carry the flag too.
    for (const [path, status, error] of [['/nothing', 404, 'not_found'], ['/laps/not-a-uuid', 404, 'not_found'], ['/laps/00000000-0000-4000-8000-000000000000/other', 404, 'not_found'],
      ['/pbs/00000000-0000-4000-8000-000000000000', 404, 'not_found'], ['/overview/00000000-0000-4000-8000-000000000000', 404, 'not_found'],
      ['/sessions/00000000-0000-4000-8000-000000000000', 404, 'session_not_found'], ['/tracks/00000000-0000-4000-8000-000000000000', 404, 'track_not_found'],
      ['/cars/00000000-0000-4000-8000-000000000000', 404, 'car_not_found'], ['/laps/00000000-0000-4000-8000-000000000000/file', 404, 'lap_not_found'],
      ['/laps?limit=0', 400, 'invalid_limit'], ['/laps?limit=abc', 400, 'invalid_limit'], ['/laps?game=Not A Game', 400, 'invalid_game'], ['/laps?track=zzz', 400, 'invalid_track'],
      ['/laps?car=zzz', 400, 'invalid_car'], ['/laps?session=zzz', 400, 'invalid_session'], ['/laps?valid=maybe', 400, 'invalid_valid'], ['/laps?cursor=%%%', 400, 'invalid_cursor'],
      ['/sessions?cursor=bm90IGEgY3Vyc29y', 400, 'invalid_cursor'], ['/pbs?track=zzz', 400, 'invalid_track']]) {
      const r = await api(path);
      assert.deepEqual([r.status, r.body], [status, { error, retryable: false }], path);
    }
    const noLap = await api('/laps/00000000-0000-4000-8000-000000000000', { method: 'DELETE' });
    assert.deepEqual([noLap.status, noLap.body], [404, { error: 'lap_not_found', retryable: false }]);
    for (const [path, method, allow] of [['/laps', 'POST', 'GET'], ['/laps', 'DELETE', 'GET'], ['/overview', 'PUT', 'GET'], ['/sessions', 'DELETE', 'GET'],
      [`/laps/${lastLap}`, 'GET', 'DELETE'], [`/laps/${lastLap}/file`, 'DELETE', 'GET'], ['/tracks/00000000-0000-4000-8000-000000000000', 'POST', 'GET']]) {
      const r = await api(path, { method });
      assert.equal(r.status, 405, `${method} ${path}`);
      assert.deepEqual(r.body, { error: 'method_not_allowed', retryable: false });
      assert.equal(r.headers.get('allow'), allow);
    }
    // An outage is retryable and says when to come back.
    const backend = process.env.DATA_BACKEND;
    delete process.env.DATA_BACKEND;
    try {
      const down = await api('/overview');
      assert.deepEqual([down.status, down.body], [503, { error: 'unavailable', retryable: true }]);
      assert.ok(Number(down.headers.get('retry-after')) >= 1);
    } finally { process.env.DATA_BACKEND = backend; }
  });

  await check('v1 laps: 251 laps come in pages of at most 100 through an opaque cursor, newest first, none twice, none missing', async () => {
    const first = await api('/laps?limit=100');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(Object.keys(first.body).sort(), ['laps', 'nextCursor']);
    assert.equal(first.body.laps.length, 100);
    assert.equal(typeof first.body.nextCursor, 'string');
    assert.match(first.body.nextCursor, /^[A-Za-z0-9_-]+$/, 'opaque: nothing a client should parse or build');
    const second = await api(`/laps?limit=100&cursor=${first.body.nextCursor}`);
    const third = await api(`/laps?limit=100&cursor=${second.body.nextCursor}`);
    assert.deepEqual([second.body.laps.length, third.body.laps.length], [100, 51]);
    assert.equal(third.body.nextCursor, null, 'the last page says so');
    const everything = [...first.body.laps, ...second.body.laps, ...third.body.laps];
    assert.equal(everything.length, SEED + 1, '250 seeded laps and the one uploaded');
    assert.equal(new Set(everything.map((l) => l.id)).size, SEED + 1, 'no lap on two pages');
    const times = everything.map((l) => l.startedAt);
    assert.deepEqual(times, [...times].sort().reverse(), 'newest first across the pages');
    assert.equal(everything[0].id, lastLap, 'the lap uploaded last, started last, is first');
    assert.deepEqual(everything.slice(1).map((l) => l.lapNumber), Array.from({ length: SEED }, (_, i) => SEED - 1 - i), 'and the seeded ones follow in order');
    // The default is 50, a bigger limit is read as 100, a smaller one is honoured.
    assert.equal((await api('/laps')).body.laps.length, 50);
    assert.equal((await api('/laps?limit=500')).body.laps.length, 100);
    const five = await api('/laps?limit=5');
    assert.equal(five.body.laps.length, 5);
    assert.ok(five.body.nextCursor);
    assert.equal((await allIds('/laps', 'laps', 50, '')).length, SEED + 1);
    // The fields of a lap.
    const lap = everything[0];
    assert.deepEqual(Object.keys(lap).sort(), ['car', 'createdAt', 'deviceName', 'formatVersion', 'fuelUsedL', 'game', 'id', 'inLap', 'lapNumber', 'outLap', 'reduced', 'sampleCount',
      'sectorsMs', 'sessionId', 'sizeBytes', 'startedAt', 'timeMs', 'topSpeedKmh', 'track', 'valid']);
    assert.deepEqual({ ...lap, id: undefined, createdAt: undefined, sessionId: undefined, car: { ...lap.car, id: undefined }, track: { ...lap.track, id: undefined } }, {
      id: undefined, game: 'lmu', track: { id: undefined, name: 'Fresh Ring' }, car: { id: undefined, name: 'Fresh Car' }, sessionId: undefined, lapNumber: 1, timeMs: 99_000, valid: true,
      startedAt: '2026-11-12T09:00:00.000Z', sectorsMs: null, topSpeedKmh: 252, fuelUsedL: null, inLap: null, outLap: null, sampleCount: 3, sizeBytes: lap.sizeBytes, reduced: false,
      formatVersion: 1, createdAt: undefined, deviceName: 'Sim PC',
    });
    assert.match(lap.id, /^[0-9a-f-]{36}$/);
    assert.match(lap.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    // A seeded lap was linked by the database all the same.
    assert.ok(everything[1].track.id && everything[1].car.id && everything[1].sessionId);
    assert.equal(everything[1].deviceName, null);
    // A cursor is not tied to anything else: one made on a smaller page continues the same list.
    const cont = await api(`/laps?limit=100&cursor=${five.body.nextCursor}`);
    assert.deepEqual(cont.body.laps.slice(0, 3).map((l) => l.id), everything.slice(5, 8).map((l) => l.id));
  });

  await check('v1 laps: the filters game, track, car, session and valid narrow the list and combine', async () => {
    const tracksList = (await api('/tracks')).body.tracks;
    const paging = tracksList.find((t) => t.name === 'Paging Ring'), second = tracksList.find((t) => t.name === 'Second Ring');
    assert.ok(paging && second);
    const lmu = await allIds('/laps', 'laps', 20, '&game=lmu');
    assert.equal(lmu.length, 125 + 1, 'Paging Ring (125) and the Fresh Ring lap, both lmu');
    assert.ok(lmu.every((l) => l.game === 'lmu'));
    assert.equal((await allIds('/laps', 'laps', 20, '&game=acc')).length, 125);
    assert.equal((await allIds('/laps', 'laps', 20, '&game=nogame')).length, 0);
    const onTrack = await allIds('/laps', 'laps', 20, `&track=${second.id}`);
    assert.equal(onTrack.length, 125);
    assert.ok(onTrack.every((l) => l.track.id === second.id));
    const carTwo = (await api(`/cars?game=lmu`)).body.cars.find((c) => c.name === 'Car Two');
    assert.ok(carTwo);
    const both = await allIds('/laps', 'laps', 20, `&track=${paging.id}&car=${carTwo.id}`);
    assert.equal(both.length, seed.filter((l) => l.track === 'Paging Ring' && l.car === 'Car Two').length);
    const invalid = await allIds('/laps', 'laps', 20, '&valid=false');
    assert.equal(invalid.length, 25, 'every tenth lap is invalid');
    assert.ok(invalid.every((l) => l.valid === false));
    assert.equal((await allIds('/laps', 'laps', 20, '&valid=true')).length, SEED + 1 - 25);
    assert.equal((await allIds('/laps', 'laps', 20, `&valid=0&game=acc`)).length, 25, 'the invalid laps are all on the acc track');
    assert.equal((await allIds('/laps', 'laps', 20, `&valid=false&game=lmu`)).length, 0);
    const session = (await api(`/sessions?track=${paging.id}&car=${carTwo.id}&limit=1`)).body.sessions[0];
    const inSession = await allIds('/laps', 'laps', 20, `&session=${session.id}`);
    assert.equal(inSession.length, session.lapCount);
    assert.ok(inSession.every((l) => l.sessionId === session.id));
    assert.equal((await allIds('/laps', 'laps', 20, `&session=00000000-0000-4000-8000-000000000000`)).length, 0);
    // Parameters of another person's data find nothing, and say nothing about it.
    const theirs = (await api('/laps', { bearer: D })).body.laps;
    assert.ok(theirs.length > 0);
    assert.equal((await api(`/laps?session=${theirs[0].sessionId}`)).body.laps.length, 0);
  });

  await check('v1 sessions: listed newest first with their counters and filters, and one comes with its laps in driving order', async () => {
    const all = await allIds('/sessions', 'sessions');
    assert.equal(all.length, 40 + 1, '10 days x 4 (track, car) combinations, and the Fresh Ring one');
    assert.deepEqual(all.map((s) => s.startedAt), [...all.map((s) => s.startedAt)].sort().reverse());
    assert.equal(all.reduce((sum, s) => sum + s.lapCount, 0), SEED + 1);
    assert.deepEqual(Object.keys(all[0]).sort(), ['airTempC', 'bestLapMs', 'car', 'endedAt', 'game', 'id', 'kind', 'lapCount', 'origin', 'startedAt', 'trackTempC', 'track', 'weather'].sort());
    const fresh = all[0];
    assert.deepEqual({ ...fresh, id: undefined, track: { ...fresh.track, id: undefined }, car: { ...fresh.car, id: undefined } }, {
      id: undefined, game: 'lmu', track: { id: undefined, name: 'Fresh Ring' }, car: { id: undefined, name: 'Fresh Car' }, kind: 'unknown', origin: 'inferred',
      startedAt: '2026-11-12T09:00:00.000Z', endedAt: '2026-11-12T09:01:39.000Z', weather: null, airTempC: null, trackTempC: null, lapCount: 1, bestLapMs: 99_000,
    });
    // Pages of 15.
    const pages = []; let cursor = null;
    do {
      const r = await api(`/sessions?limit=15${cursor ? `&cursor=${cursor}` : ''}`);
      pages.push(r.body.sessions); cursor = r.body.nextCursor;
    } while (cursor);
    assert.deepEqual(pages.map((p) => p.length), [15, 15, 11]);
    assert.deepEqual(pages.flat().map((s) => s.id), all.map((s) => s.id));
    // Filters.
    assert.equal((await allIds('/sessions', 'sessions', 20, '&game=acc')).length, 20);
    const track = (await api('/tracks?game=acc')).body.tracks[0];
    assert.equal((await allIds('/sessions', 'sessions', 20, `&track=${track.id}`)).length, 20);
    // One session, with its laps.
    const one = all.find((s) => s.lapCount > 2 && s.game === 'lmu' && s.bestLapMs !== null);
    const detail = await api(`/sessions/${one.id}`);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.deepEqual(Object.keys(detail.body).sort(), ['laps', 'session']);
    assert.deepEqual(detail.body.session, one);
    assert.equal(detail.body.laps.length, one.lapCount);
    assert.ok(detail.body.laps.every((l) => l.sessionId === one.id && l.track.id === one.track.id && l.car.id === one.car.id));
    assert.deepEqual(detail.body.laps.map((l) => l.startedAt), [...detail.body.laps.map((l) => l.startedAt)].sort(), 'in driving order');
    assert.equal(one.bestLapMs, Math.min(...detail.body.laps.filter((l) => l.valid).map((l) => l.timeMs)));
    // A Companion session carries its details.
    const rig = await deviceFor(C, 'Sim PC 2');
    const raced = await put(rig, { track: 'Fresh Ring', car: 'Fresh Car', number: 2, startedAt: '2026-11-13T09:00:00.000Z', sessionId: 'race-1', sessionKind: 'race', weather: 'Overcast', airTempC: 18, trackTempC: 24 });
    const rid = (await lapRow(raced)).session_id;
    const companion = (await api(`/sessions/${rid}`)).body;
    assert.deepEqual([companion.session.origin, companion.session.kind, companion.session.weather, companion.session.airTempC, companion.session.trackTempC], ['companion', 'race', 'Overcast', 18, 24]);
  });

  await check('v1 tracks and cars: listed with totals, and one comes with its progress (best per day, laps per day, best per car)', async () => {
    const list = await allIds('/tracks', 'tracks');
    assert.deepEqual(list.map((t) => `${t.game}|${t.name}`).sort(), ['acc|Second Ring', 'lmu|Fresh Ring', 'lmu|Paging Ring']);
    const paging = list.find((t) => t.name === 'Paging Ring');
    assert.deepEqual(Object.keys(paging).sort(), ['bestLapMs', 'carCount', 'game', 'id', 'lapCount', 'lastDrivenAt', 'lengthM', 'name', 'sessionCount', 'validLapCount']);
    const mine = seed.filter((l) => l.track === 'Paging Ring');
    assert.deepEqual({ ...paging, id: undefined, lengthM: undefined, lastDrivenAt: undefined }, {
      id: undefined, game: 'lmu', name: 'Paging Ring', lengthM: undefined, lapCount: 125, validLapCount: mine.filter((l) => l.valid).length, sessionCount: 20, carCount: 2,
      bestLapMs: Math.min(...mine.filter((l) => l.valid).map((l) => l.timeMs)), lastDrivenAt: undefined,
    });
    assert.equal(paging.lastDrivenAt, mine.at(-1).startedAt);
    assert.deepEqual(list.map((t) => t.lastDrivenAt), [...list.map((t) => t.lastDrivenAt)].sort().reverse(), 'most recently driven first');
    assert.deepEqual((await allIds('/tracks', 'tracks', 5, '&game=acc')).map((t) => t.name), ['Second Ring']);
    const pages = [(await api('/tracks?limit=2')).body, null];
    pages[1] = (await api(`/tracks?limit=2&cursor=${pages[0].nextCursor}`)).body;
    assert.deepEqual([pages[0].tracks.length, pages[1].tracks.length, pages[1].nextCursor], [2, 1, null]);

    const detail = (await api(`/tracks/${paging.id}`)).body;
    assert.deepEqual(Object.keys(detail).sort(), ['bestPerCar', 'progress', 'totals', 'track']);
    assert.deepEqual(detail.track, { id: paging.id, game: 'lmu', name: 'Paging Ring', lengthM: detail.track.lengthM });
    assert.deepEqual(detail.totals, { lapCount: 125, validLapCount: mine.filter((l) => l.valid).length, sessionCount: 20, carCount: 2, bestLapMs: paging.bestLapMs, lastDrivenAt: paging.lastDrivenAt });
    // Laps per day: ten days, 12 or 13 laps of this track a day.
    assert.deepEqual(Object.keys(detail.progress).sort(), ['bestPerDay', 'lapsPerDay']);
    assert.equal(detail.progress.lapsPerDay.length, 10);
    const day = (iso) => iso.slice(0, 10);
    for (const d of detail.progress.lapsPerDay) {
      const rows = mine.filter((l) => day(l.startedAt) === d.day);
      assert.deepEqual(d, { day: d.day, laps: rows.length, validLaps: rows.filter((l) => l.valid).length });
    }
    assert.deepEqual(detail.progress.lapsPerDay.map((d) => d.day), [...detail.progress.lapsPerDay.map((d) => d.day)].sort(), 'oldest day first');
    // Best valid lap per day, with the car and the lap.
    assert.equal(detail.progress.bestPerDay.length, 10);
    for (const d of detail.progress.bestPerDay) {
      const rows = mine.filter((l) => day(l.startedAt) === d.day && l.valid);
      assert.equal(d.bestMs, Math.min(...rows.map((l) => l.timeMs)));
      assert.match(d.lapId, /^[0-9a-f-]{36}$/);
      assert.ok(['Car One', 'Car Two'].includes(d.car.name));
      assert.equal(rows.find((l) => l.timeMs === d.bestMs).car, d.car.name);
    }
    // Best per car.
    assert.equal(detail.bestPerCar.length, 2);
    for (const entry of detail.bestPerCar) {
      const rows = mine.filter((l) => l.car === entry.car.name);
      assert.deepEqual(Object.keys(entry).sort(), ['achievedAt', 'bestMs', 'car', 'lapCount', 'lapId', 'validLapCount']);
      assert.equal(entry.lapCount, rows.length);
      assert.equal(entry.validLapCount, rows.filter((l) => l.valid).length);
      assert.equal(entry.bestMs, Math.min(...rows.filter((l) => l.valid).map((l) => l.timeMs)));
      assert.equal(entry.achievedAt, rows.filter((l) => l.valid).find((l) => l.timeMs === entry.bestMs).startedAt);
    }
    assert.ok(detail.bestPerCar[0].bestMs <= detail.bestPerCar[1].bestMs, 'fastest car first');
    // A track nobody drove of the person is still a catalog row: empty progress, not an error.
    const theirs = (await api('/tracks', { bearer: D })).body.tracks;
    assert.equal(theirs.length, 2, 'D drove the first 30 laps: Paging Ring and Second Ring');
    const notMine = (await api(`/tracks/${list.find((t) => t.name === 'Fresh Ring').id}`, { bearer: D })).body;
    assert.deepEqual([notMine.totals.lapCount, notMine.progress.lapsPerDay, notMine.progress.bestPerDay, notMine.bestPerCar], [0, [], [], []]);
    assert.equal((await api(`/tracks/${paging.id}`, { bearer: D })).body.totals.lapCount, 15, 'D sees their own laps on it, not C\'s');

    // Cars.
    const cars = await allIds('/cars', 'cars');
    assert.deepEqual(cars.map((c) => `${c.game}|${c.name}`).sort(), ['acc|Car One', 'acc|Car Two', 'lmu|Car One', 'lmu|Car Two', 'lmu|Fresh Car']);
    const two = cars.find((c) => c.game === 'lmu' && c.name === 'Car Two');
    assert.deepEqual(Object.keys(two).sort(), ['bestLapMs', 'brand', 'class', 'game', 'id', 'lapCount', 'lastDrivenAt', 'name', 'sessionCount', 'trackCount', 'validLapCount']);
    const twoLaps = seed.filter((l) => l.game === 'lmu' && l.car === 'Car Two');
    assert.equal(two.lapCount, twoLaps.length);
    assert.equal(two.trackCount, 1);
    assert.equal(two.bestLapMs, Math.min(...twoLaps.filter((l) => l.valid).map((l) => l.timeMs)));
    assert.deepEqual((await allIds('/cars', 'cars', 5, '&game=acc')).map((c) => c.name).sort(), ['Car One', 'Car Two']);
    const carDetail = (await api(`/cars/${two.id}`)).body;
    assert.deepEqual(Object.keys(carDetail).sort(), ['bestPerTrack', 'car', 'progress', 'totals']);
    assert.deepEqual(carDetail.car, { id: two.id, game: 'lmu', name: 'Car Two', brand: null, class: null });
    assert.equal(carDetail.totals.lapCount, twoLaps.length);
    assert.equal(carDetail.bestPerTrack.length, 1);
    assert.equal(carDetail.bestPerTrack[0].track.name, 'Paging Ring');
    assert.equal(carDetail.bestPerTrack[0].bestMs, two.bestLapMs);
    assert.ok(carDetail.progress.lapsPerDay.length >= 1);
  });

  await check('v1 pbs: one per track and car, newest first, filtered, and kept in step with the laps', async () => {
    const all = await allIds('/pbs', 'pbs');
    assert.equal(all.length, 5, 'Paging x 2 cars, Second x 2 cars, Fresh x 1');
    assert.deepEqual(Object.keys(all[0]).sort(), ['achievedAt', 'bestMs', 'car', 'game', 'lapId', 'track']);
    assert.deepEqual(all.map((p) => p.achievedAt), [...all.map((p) => p.achievedAt)].sort().reverse());
    for (const pb of all.filter((p) => p.track.name !== 'Fresh Ring')) {
      const rows = seed.filter((l) => l.track === pb.track.name && l.car === pb.car.name && l.valid);
      assert.equal(pb.bestMs, Math.min(...rows.map((l) => l.timeMs)), `${pb.track.name} / ${pb.car.name}`);
      assert.equal(pb.achievedAt, rows.find((l) => l.timeMs === pb.bestMs).startedAt);
      assert.equal(pb.game, rows[0].game);
    }
    assert.equal((await allIds('/pbs', 'pbs', 5, '&game=acc')).length, 2);
    const trackId = (await api('/tracks')).body.tracks.find((t) => t.name === 'Paging Ring').id;
    assert.equal((await allIds('/pbs', 'pbs', 5, `&track=${trackId}`)).length, 2);
    assert.equal((await allIds('/pbs', 'pbs', 5, `&track=${trackId}&car=${all.find((p) => p.track.id === trackId).car.id}`)).length, 1);
    const paged = [(await api('/pbs?limit=2')).body]; paged.push((await api(`/pbs?limit=2&cursor=${paged[0].nextCursor}`)).body); paged.push((await api(`/pbs?limit=2&cursor=${paged[1].nextCursor}`)).body);
    assert.deepEqual([paged[0].pbs.length, paged[1].pbs.length, paged[2].pbs.length, paged[2].nextCursor], [2, 2, 1, null]);
    assert.deepEqual(paged.flatMap((p) => p.pbs).map((p) => p.lapId), all.map((p) => p.lapId));
    // A faster lap moves the best, and the API shows it at once.
    const before = (await api(`/pbs?track=${trackId}`)).body.pbs.find((p) => p.car.name === 'Car One');
    const rig = await deviceFor(C, 'Sim PC 3');
    const faster = await put(rig, { track: 'Paging Ring', car: 'Car One', number: 900, timeMs: before.bestMs - 1000, startedAt: '2026-11-20T10:00:00.000Z' });
    const after = (await api(`/pbs?track=${trackId}`)).body.pbs.find((p) => p.car.name === 'Car One');
    assert.deepEqual([after.lapId, after.bestMs, after.achievedAt], [faster, before.bestMs - 1000, '2026-11-20T10:00:00.000Z']);
    assert.equal((await api(`/laps/${faster}`, { method: 'DELETE' })).status, 204);
    assert.equal((await api(`/pbs?track=${trackId}`)).body.pbs.find((p) => p.car.name === 'Car One').lapId, before.lapId, 'deleted again: the old best is back');
  });

  await check('v1 overview: the 5 latest sessions and bests and laps per game, in one call', async () => {
    forgetAllOverviews();
    const r = await api('/overview');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body).sort(), ['companion', 'lapsPerGame', 'latestPersonalBests', 'latestSessions', 'storage']);
    assert.equal(r.body.latestSessions.length, 5);
    assert.deepEqual(r.body.latestSessions.map((s) => s.startedAt), [...r.body.latestSessions.map((s) => s.startedAt)].sort().reverse());
    assert.deepEqual(r.body.latestSessions.map((s) => s.id), (await api('/sessions?limit=5')).body.sessions.map((s) => s.id), 'the same five as the list');
    assert.equal(r.body.latestPersonalBests.length, 5);
    assert.deepEqual(Object.keys(r.body.latestPersonalBests[0]).sort(), ['achievedAt', 'bestMs', 'car', 'game', 'lapId', 'track']);
    assert.deepEqual(r.body.latestPersonalBests.map((p) => p.lapId), (await api('/pbs?limit=5')).body.pbs.map((p) => p.lapId), 'the same five as the list');
    const games = Object.fromEntries(r.body.lapsPerGame.map((g) => [g.game, g]));
    assert.deepEqual(Object.keys(games).sort(), ['acc', 'lmu']);
    assert.deepEqual(Object.keys(games.acc).sort(), ['game', 'lapCount', 'lastDrivenAt', 'sessions', 'validLaps'].map((k) => (k === 'lapCount' ? 'laps' : k)).sort());
    assert.deepEqual([games.acc.laps, games.acc.validLaps, games.acc.sessions], [125, 100, 20]);
    assert.equal(games.lmu.laps, (await allIds('/laps', 'laps', 20, '&game=lmu')).length);
    assert.ok(games.lmu.laps >= 127);
    assert.deepEqual(r.body.lapsPerGame.map((g) => g.laps), [...r.body.lapsPerGame.map((g) => g.laps)].sort((a, b) => b - a), 'the most played first');
  });

  await check('v1 overview: the Companion status lists the live devices with last seen and the last lap received', async () => {
    forgetAllOverviews();
    const r = (await api('/overview')).body;
    const names = r.companion.devices.map((d) => d.name);
    assert.ok(names.includes('Sim PC') && names.includes('Sim PC 2'));
    assert.deepEqual(Object.keys(r.companion.devices[0]).sort(), ['id', 'lastLapAt', 'lastSeenAt', 'name', 'pairedAt']);
    const rig = r.companion.devices.find((d) => d.name === 'Sim PC');
    assert.ok(rig.lastSeenAt && rig.lastLapAt, 'the device has been seen and sent a lap');
    assert.equal(r.companion.lastLap.game, 'lmu');
    assert.match(r.companion.lastLap.createdAt, /Z$/);
    assert.equal(r.companion.lastLap.deviceName === null || typeof r.companion.lastLap.deviceName === 'string', true);
    assert.deepEqual(Object.keys(r.companion.lastLap).sort(), Object.keys((await api('/laps?limit=1')).body.laps[0]).sort(), 'a lap, as everywhere else');
    assert.equal(r.storage.limitBytes, 20 * 1024 ** 3);
    assert.equal(r.storage.lapCount, (await allIds('/laps')).length);
    assert.equal(r.storage.usedBytes, Number((await direct.query('SELECT sum(size_bytes)::bigint AS n FROM public.sim_laps WHERE user_id = $1', [ids.C])).rows[0].n));
    // A device that was revoked is not listed.
    const gone = await deviceFor(C, 'Sim PC gone');
    await direct.query('UPDATE public.sim_devices SET revoked_at = now() WHERE id = $1', [gone.deviceId]);
    forgetAllOverviews();
    assert.ok(!(await api('/overview')).body.companion.devices.some((d) => d.name === 'Sim PC gone'));
    // A person with no laps and no devices gets empty lists, not an error.
    const empty = (await api('/overview', { bearer: await token('uid-nobody', { phone_number: '+15550009999' }) }));
    assert.equal(empty.status, 401, 'an account that was never created is not signed in here');
    const quiet = await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${await token('uid-quiet', { phone_number: '+15550000010' })}` } }));
    assert.equal(quiet.status, 200);
    const nothing = (await api('/overview', { bearer: await token('uid-quiet', { phone_number: '+15550000010' }) })).body;
    assert.deepEqual([nothing.latestSessions, nothing.latestPersonalBests, nothing.lapsPerGame, nothing.companion.devices, nothing.companion.lastLap, nothing.storage.usedBytes], [[], [], [], [], null, 0]);
  });

  await check('v1 overview: cached for 10 seconds per person; an upload or a deletion shows at once, and the cache never mixes people', async () => {
    forgetAllOverviews();
    const count = async (who = C) => (await api('/overview', { bearer: who })).body.storage.lapCount;
    const base = await count();
    await seedFor(ids.C, [{ i: 5000, game: 'lmu', track: 'Cache Ring', car: 'Car One', timeMs: 100_000, valid: true, startedAt: '2026-11-21T10:00:00.000Z' }], 'cache');
    assert.equal(await count(), base, 'a lap written behind the API\'s back is not seen for 10 seconds');
    const rig = await deviceFor(C, 'Sim PC 4');
    const uploaded = await put(rig, { track: 'Cache Ring', car: 'Car One', number: 5001, timeMs: 101_000, startedAt: '2026-11-21T10:05:00.000Z' });
    assert.equal(await count(), base + 2, 'an upload drops the person\'s cache: both laps show');
    await seedFor(ids.C, [{ i: 5002, game: 'lmu', track: 'Cache Ring', car: 'Car One', timeMs: 102_000, valid: true, startedAt: '2026-11-21T10:10:00.000Z' }], 'cache');
    assert.equal(await count(), base + 2);
    assert.equal((await api(`/laps/${uploaded}`, { method: 'DELETE' })).status, 204);
    assert.equal(await count(), base + 2, 'a deletion drops the cache: the uploaded lap is gone and the hidden one shows (+1 -1 +1)');
    assert.equal(await count(D), 30, 'another person has their own entry');
    // The cache itself: 10 seconds, per person.
    assert.equal(OVERVIEW_TTL_MS, 10_000);
    forgetAllOverviews();
    rememberOverview('x', { n: 1 }, 1_000);
    assert.deepEqual(cachedOverview('x', 1_000 + 9_999), { n: 1 });
    assert.equal(cachedOverview('x', 1_000 + 10_000), undefined, 'expired after 10 seconds');
    assert.equal(cachedOverview('y', 1_000), undefined);
  });

  await check('v1 isolation: nobody reads, lists, downloads or deletes another person\'s laps, sessions or progress', async () => {
    const cLaps = await allIds('/laps', 'laps', 20, '&game=acc');
    const dLaps = (await api('/laps?limit=100', { bearer: D })).body.laps;
    assert.equal(dLaps.length, 30);
    assert.ok(dLaps.every((l) => !cLaps.some((c) => c.id === l.id)), 'D\'s laps are not C\'s');
    const cSession = (await api('/sessions?limit=1')).body.sessions[0];
    for (const [path, error] of [[`/sessions/${cSession.id}`, 'session_not_found'], [`/laps/${cLaps[0].id}/file`, 'lap_not_found']]) {
      const r = await api(path, { bearer: D });
      assert.deepEqual([r.status, r.body], [404, { error, retryable: false }], path);
    }
    assert.equal((await api(`/laps/${cLaps[0].id}`, { method: 'DELETE', bearer: D })).status, 404);
    assert.equal((await direct.query('SELECT count(*)::int AS n FROM public.sim_laps WHERE id = $1', [cLaps[0].id])).rows[0].n, 1, 'D deleted nothing');
    assert.equal((await api(`/laps?session=${cSession.id}`, { bearer: D })).body.laps.length, 0);
    assert.equal((await api('/sessions?limit=100', { bearer: D })).body.sessions.every((s) => s.id !== cSession.id), true);
    // Even with the other person's cursor: a cursor is only a place in the list of whoever asks.
    const cCursor = (await api('/laps?limit=5')).body.nextCursor;
    assert.ok((await api(`/laps?limit=100&cursor=${cCursor}`, { bearer: D })).body.laps.every((l) => dLaps.some((d) => d.id === l.id)));
    // B has laps of their own from the earlier checks and sees none of C's or D's.
    const bLaps = (await api('/laps?limit=100', { bearer: B })).body.laps;
    assert.ok(bLaps.length > 0 && bLaps.every((l) => !cLaps.some((c) => c.id === l.id) && !dLaps.some((d) => d.id === l.id)));
    assert.equal((await api('/pbs', { bearer: D })).body.pbs.every((p) => p.lapId && dLaps.some((l) => l.id === p.lapId)), true, 'D\'s bests point at D\'s laps');
  });

  await check('v1 laps: the file is the stored bytes with the same immutable cache as the unversioned path, and deleting one removes row and file', async () => {
    const rig = await deviceFor(C, 'Sim PC 5');
    const bytes = await makeLap({ track: 'File Ring', car: 'File Car', number: 1, startedAt: '2026-11-22T10:00:00.000Z', speed: [10, 20, 30] });
    const sentLap = await upload(rig.token, bytes);
    assert.equal(sentLap.status, 201);
    const file = await v1(new Request(`http://x/api/sim/v1/laps/${sentLap.body.id}/file`, { headers: { authorization: `Bearer ${C}`, origin: 'https://xpeed.test' } }));
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'application/gzip');
    assert.equal(file.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(file.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    const body = new Uint8Array(await file.arrayBuffer());
    assert.deepEqual(body, new Uint8Array(bytes), 'the same bytes');
    const old = await laps(new Request(`http://x/api/sim/laps/${sentLap.body.id}/file`, { headers: { authorization: `Bearer ${C}` } }));
    assert.deepEqual(new Uint8Array(await old.arrayBuffer()), body, 'the same bytes as the unversioned path');
    const path = resolve(filesRoot, 'sim-laps', (await lapRow(sentLap.body.id)).storage_path);
    assert.ok(existsSync(path));
    const gone = await api(`/laps/${sentLap.body.id}`, { method: 'DELETE' });
    assert.equal(gone.status, 204);
    assert.equal(gone.body, null);
    assert.ok(!existsSync(path), 'the file is gone too');
    assert.equal((await api(`/laps/${sentLap.body.id}/file`)).status, 404);
    assert.equal((await api(`/laps/${sentLap.body.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await api('/pbs?game=lmu', {})).body.pbs.some((p) => p.track.name === 'File Ring'), false, 'and so is the personal best it was');
  });

  await check('v1 is reached through the real server, with CORS for the app and a preflight', async () => {
    webServer = createXpeedServer({ staticRoot: temp, origin: 'https://xpeed.test' });
    await new Promise((done) => webServer.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${webServer.address().port}`;
    const r = await fetch(`${base}/api/sim/v1/laps?limit=2`, { headers: { authorization: `Bearer ${C}`, origin: 'https://xpeed.test' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    assert.match(r.headers.get('vary') ?? '', /origin/i);
    assert.equal((await r.json()).laps.length, 2);
    const other = await fetch(`${base}/api/sim/v1/laps`, { headers: { authorization: `Bearer ${C}`, origin: 'https://evil.example' } });
    assert.equal(other.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(`${base}/api/sim/v1/overview`, { method: 'OPTIONS', headers: { origin: 'https://xpeed.test', 'access-control-request-method': 'GET' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://xpeed.test');
    assert.equal((await fetch(`${base}/api/sim/v1/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/sim/v1/nothing`, { headers: { authorization: `Bearer ${C}` } })).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/sim/v1/`, { headers: { authorization: `Bearer ${C}` } })).json(), { error: 'not_found', retryable: false });
    // An upload through the real server lands linked, with the new columns, in one go.
    const key = (await deviceFor(C, 'Sim PC 6')).token;
    const up = await fetch(`${base}/api/sim/laps`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/gzip' }, body: await makeLap({ track: 'Server Ring', number: 1, startedAt: '2026-11-23T10:00:00.000Z', sectorsMs: [300, 400, 300] }) });
    assert.equal(up.status, 201);
    const row = await lapRow((await up.json()).id);
    assert.ok(row.track_id && row.car_id && row.session_id);
    assert.deepEqual(row.sector_ms, [300, 400, 300]);
    await new Promise((done) => (webServer.closeAllConnections?.(), webServer.close(done)));
    webServer = undefined;
  });

  await check('the unversioned endpoints keep their contracts: /api/sim/laps (list, file, delete), /me, /devices, pairing', async () => {
    const rig = await deviceFor(B, 'COMPAT');
    const id = await put(rig, { track: 'Compat Ring', car: 'Compat Car', number: 1, startedAt: '2026-11-24T10:00:00.000Z' });
    const dup = await upload(rig.token, await makeLap({ track: 'Compat Ring', car: 'Compat Car', number: 1, startedAt: '2026-11-24T10:00:00.000Z' }));
    assert.deepEqual([dup.status, dup.body], [200, { id, duplicate: true }]);
    const listed = await call(laps, '/api/sim/laps', { bearer: B });
    assert.equal(listed.status, 200);
    assert.deepEqual(Object.keys(listed.body), ['laps']);
    const lap = listed.body.laps.find((l) => l.id === id);
    assert.deepEqual(Object.keys(lap).sort(), ['car', 'createdAt', 'deviceName', 'game', 'id', 'lapNumber', 'sampleCount', 'sizeBytes', 'startedAt', 'timeMs', 'track', 'valid']);
    assert.deepEqual([lap.game, lap.track, lap.car, lap.lapNumber, lap.timeMs, lap.valid, lap.deviceName], ['lmu', 'Compat Ring', 'Compat Car', 1, 1000, true, 'COMPAT']);
    assert.equal((await call(laps, `/api/sim/laps/${id}/file`, { bearer: B })).status, 200);
    assert.equal((await call(laps, `/api/sim/laps/${id}`, { method: 'DELETE', bearer: B })).status, 204);
    assert.equal((await call(laps, '/api/sim/laps', { bearer: B })).body.laps.some((l) => l.id === id), false);
    assert.equal((await upload('xpd_unknown', await makeLap())).status, 401);
    const mine = await call(me, '/api/sim/me', { bearer: rig.token });
    assert.deepEqual([mine.status, mine.body.deviceName], [200, 'COMPAT']);
    const devs = await call(devices, '/api/sim/devices', { bearer: B });
    assert.equal(devs.status, 200);
    assert.ok(devs.body.devices.some((d) => d.id === rig.deviceId));
    assert.equal((await call(laps, '/api/sim/laps', { method: 'PUT', bearer: B })).status, 405);
    // The unversioned list is still capped at 5000 newest laps and C has 250+ : all there, newest first.
    const cList = await call(laps, '/api/sim/laps', { bearer: C });
    assert.ok(cList.body.laps.length >= SEED);
    assert.deepEqual(cList.body.laps.map((l) => l.startedAt), [...cList.body.laps.map((l) => l.startedAt)].sort().reverse());
  });

  console.log(`${checks.length} sim v1 checks passed:\n- ${checks.join('\n- ')}`);
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
