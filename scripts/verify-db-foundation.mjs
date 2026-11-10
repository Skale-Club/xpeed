// Real PostgreSQL/WASM served over a socket, so the same `pg` driver and server
// code used in production run against it. No .env, network or remote credentials.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { listMigrations, migrate, versionOf, ensureIdentityProject } from '../db/migrate.mjs';
import { assertSafeTarget, pullAnonymized } from '../db/sync.mjs';
import { scrubJson } from '../db/anonymize.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');
const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');

// The server modules are TypeScript: bundle them once into a temp folder.
// Inside the repo so the bundle can resolve `pg` and `jose` from node_modules.
mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-db-'));
await build({
  entryPoints: { db: 'server/db.ts', identity: 'server/identity.ts', route: 'server/account-route.ts' },
  outdir: temp, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose'], absWorkingDir: root, logLevel: 'error',
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const { asIdentity } = await load('db.mjs');
const { verifyIdentity } = await load('identity.mjs');
const { createAccountRoute } = await load('route.mjs');

let port = 54400;
async function freshDatabase() {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  const url = `postgres://postgres:postgres@127.0.0.1:${port++}/postgres`;
  return { db, url, stop: async () => { await server.stop(); await db.close(); } };
}
const checks = [];
const check = async (name, test) => { await test(); checks.push(name); };
const all = listMigrations();

try {
  // 1. A plain PostgreSQL server (what Coolify runs): compat layer + every migration.
  const plain = await freshDatabase();
  const client = new pg.Client({ connectionString: plain.url });
  await client.connect();
  await check('plain PostgreSQL gets the compatibility layer and all migrations', async () => {
    const first = await migrate(client);
    assert.equal(first.compat, true);
    assert.equal(first.applied.length, all.length);
  });
  await check('running the migrator again changes nothing', async () => {
    const again = await migrate(client);
    assert.deepEqual([again.applied.length, again.adopted.length, again.compat], [0, 0, false]);
  });
  await check('one account can hold several sign-in methods (Google and SMS), each resolving to it', async () => {
    const account = '50000000-0000-4000-8000-000000000001';
    await client.query("INSERT INTO public.app_accounts(id, email) VALUES($1, 'two-methods@example.test')", [account]);
    for (const subject of ['google-uid', 'phone-uid']) {
      await client.query("INSERT INTO public.google_auth_identities(issuer, tenant_id, subject, account_id) VALUES('https://securetoken.google.com/skaleclub', '', $1, $2)", [subject, account]);
    }
    const found = await client.query("SELECT subject FROM public.google_auth_identities WHERE account_id = $1 ORDER BY subject", [account]);
    assert.deepEqual(found.rows.map((r) => r.subject), ['google-uid', 'phone-uid']);
    // The same sign-in identity still cannot belong to two accounts.
    await assert.rejects(client.query("INSERT INTO public.google_auth_identities(issuer, tenant_id, subject, account_id) VALUES('https://securetoken.google.com/skaleclub', '', 'phone-uid', (SELECT id FROM public.app_accounts WHERE id <> $1 LIMIT 1))", [account]));
    await client.query('DELETE FROM public.app_accounts WHERE id = $1', [account]);
  });
  await check('a failing migration rolls back and names the file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'xpeed-bad-'));
    writeFileSync(resolve(dir, '20990101000000_bad.sql'), 'CREATE TABLE public.half_done(id int); SELECT 1/0;');
    await assert.rejects(migrate(client, { dir }), /20990101000000_bad\.sql failed/);
    assert.equal((await client.query("SELECT to_regclass('public.half_done') AS t")).rows[0].t, null);
    rmSync(dir, { recursive: true });
  });

  // 2. Verified Google token -> RLS identity, through the real route.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] });
  const sign = (claims, { iss = 'https://securetoken.google.com/skaleclub', aud = 'skaleclub', exp = '10m', sub = 'firebase-uid-1' } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss).setAudience(aud)
      .setSubject(sub).setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const identity = { projectId: 'skaleclub', keys };
  await ensureIdentityProject(client, 'skaleclub');
  // PGlite serves one connection at a time: hand it over to the pool the server uses.
  await client.end();

  await check('only a correctly signed token for this project is accepted', async () => {
    const good = await sign({ firebase: { sign_in_provider: 'google.com' } });
    assert.equal((await verifyIdentity(good, identity))?.sub, 'firebase-uid-1');
    assert.equal(await verifyIdentity(await sign({}, { iss: 'https://securetoken.google.com/other' }), identity), null);
    assert.equal(await verifyIdentity(await sign({}, { aud: 'other' }), identity), null);
    assert.equal(await verifyIdentity(await sign({}, { exp: '-1m' }), identity), null);
    const { privateKey: stranger } = await generateKeyPair('RS256');
    const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://securetoken.google.com/skaleclub').setAudience('skaleclub').setSubject('x')
      .setExpirationTime('10m').sign(stranger);
    assert.equal(await verifyIdentity(forged, identity), null);
    assert.equal(await verifyIdentity(good.slice(0, -4) + 'AAAA', identity), null);
    assert.equal(await verifyIdentity('', identity), null);
  });

  const pool = new pg.Pool({ connectionString: plain.url, max: 1 });
  const route = createAccountRoute({ ...identity, pool });
  const call = (token, method = 'POST') =>
    route(new Request('http://x/api/account', { method, headers: token ? { authorization: `Bearer ${token}` } : {} }));
  const phoneClaims = { firebase: { sign_in_provider: 'phone' }, phone_number: '+15550001111' };

  await check('POST /api/account creates the account once and returns it on the next sign-in', async () => {
    const token = await sign(phoneClaims);
    const first = await call(token);
    assert.equal(first.status, 200);
    const account = await first.json();
    assert.match(account.id, /^[0-9a-f-]{36}$/);
    assert.equal(account.phone, '+15550001111');
    assert.equal((await (await call(token)).json()).id, account.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.app_accounts')).rows[0].n, 1);
  });
  await check('missing, bad or wrong-method requests never create an account', async () => {
    assert.equal((await call('')).status, 401);
    assert.equal((await call('garbage')).status, 401);
    assert.equal((await call(await sign({}), 'GET')).status, 405);
    assert.equal((await call(await sign({ firebase: { sign_in_provider: 'password' } }, { sub: 'other-uid' }))).status, 403);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.app_accounts')).rows[0].n, 1);
  });
  await check('asIdentity applies row level security to the verified person only', async () => {
    const mine = (await (await call(await sign(phoneClaims))).json()).id;
    const claims = await verifyIdentity(await sign(phoneClaims), identity);
    const seen = await asIdentity(claims, (c) => c.query('SELECT public.current_app_user_id() AS id'), pool);
    assert.equal(seen.rows[0].id, mine);
    const role = await asIdentity(claims, (c) => c.query('SELECT current_user AS u'), pool);
    assert.equal(role.rows[0].u, 'authenticated');
    // The role does not leak back to the next borrower of the same connection.
    assert.equal((await pool.query('SELECT current_user AS u')).rows[0].u, 'postgres');
    // Privileged tables stay closed to the signed-in role.
    await assert.rejects(asIdentity(claims, (c) => c.query('SELECT * FROM public.google_auth_identities'), pool));
  });
  await pool.end(); await plain.stop();

  // 3. A Supabase project the CLI already migrated: adopt its history, never re-run.
  const supa = await freshDatabase();
  const sc = new pg.Client({ connectionString: supa.url });
  await sc.connect();
  await sc.query(`CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY)`);
  for (const name of all) await sc.query('INSERT INTO supabase_migrations.schema_migrations VALUES($1) ON CONFLICT DO NOTHING', [versionOf(name)]);
  await check('an existing Supabase project adopts its history and applies nothing twice', async () => {
    const result = await migrate(sc);
    assert.equal(result.compat, false);
    assert.equal(result.applied.length, 0);
    assert.equal(result.adopted.length, all.length);
    assert.equal((await sc.query("SELECT to_regclass('public.sessions') AS t")).rows[0].t, null);
  });
  await sc.end(); await supa.stop();

  // 4. Development sync: anonymized copy of production into the dev database.
  const prodDb = await freshDatabase();
  const devDb = await freshDatabase();
  const prod = new pg.Client({ connectionString: prodDb.url });
  const dev = new pg.Client({ connectionString: devDb.url });
  await prod.connect(); await dev.connect();
  await migrate(prod); await migrate(dev);
  const OWNER = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
  const CAR = '20000000-0000-4000-8000-000000000001', TRIP = '30000000-0000-4000-8000-000000000001', CHAT = '40000000-0000-4000-8000-000000000001';
  await prod.query(`
    SET session_replication_role = replica;
    INSERT INTO public.app_accounts(id,email,phone,email_verified,phone_verified,full_name) VALUES
      ('${OWNER}','owner@example.test','+15550000001',true,true,'The Owner'),
      ('${OTHER}','other@example.test','+15550000002',true,true,'Other Person');
    INSERT INTO public.google_auth_identities(issuer,tenant_id,subject,account_id) VALUES
      ('https://securetoken.google.com/skaleclub','','uid-owner','${OWNER}'),
      ('https://securetoken.google.com/skaleclub','','uid-other','${OTHER}');
    INSERT INTO public.car_profiles(id,user_id,name,vin,photo_path,notes,make,model,year) VALUES
      ('${CAR}','${OTHER}','Secret Car','JTDKN3DU0A1234567','${OTHER}/car.png','private note','Toyota','Prius',2010);
    INSERT INTO public.sessions(id,car_profile_id,user_id,source_filename,source_csv,source_file_path)
      VALUES('${TRIP}','${CAR}','${OTHER}','my-home-trip.csv','GPS Latitude,GPS Longitude','${OTHER}/trip.csv');
    INSERT INTO public.session_rows(session_id,t_seconds,data)
      VALUES('${TRIP}',0,'{"Coolant":90,"GPS Latitude":12.3,"Longitude":4.5,"nested":{"gps":1,"rpm":800}}');
    INSERT INTO public.chat_conversations(id,user_id,car_profile_id,title) VALUES('${CHAT}','${OTHER}','${CAR}','Where I live');
    INSERT INTO public.chat_messages(conversation_id,role,parts) VALUES('${CHAT}','user','[{"type":"text","text":"my address is 1 Main St"}]');
    INSERT INTO public.mcp_tokens(user_id,name,token_hash,token_prefix) VALUES('${OTHER}','claude','secrethash','xp_');
    SET session_replication_role = origin;`);
  await dev.query(`INSERT INTO public.app_accounts(id,email) VALUES('${OTHER}','stale@example.test')`);
  const counts = "SELECT (SELECT count(*) FROM public.app_accounts)::int a, (SELECT count(*) FROM public.mcp_tokens)::int t";
  const before = (await prod.query(counts)).rows[0];

  await check('production data reaches dev anonymized, and the owner stays recognizable', async () => {
    const summary = await pullAnonymized(prod, dev, { keepEmails: ['Owner@Example.test'] });
    assert.equal(summary.keptAccounts, 1);
    const one = async (sql) => (await dev.query(sql)).rows[0];
    const owner = await one(`SELECT * FROM public.app_accounts WHERE id='${OWNER}'`);
    assert.deepEqual([owner.email, owner.phone, owner.full_name], ['owner@example.test', '+15550000001', 'The Owner']);
    const other = await one(`SELECT * FROM public.app_accounts WHERE id='${OTHER}'`);
    assert.match(other.email, /^driver-[0-9a-f]{10}@example\.test$/);
    assert.equal(other.phone, null);
    assert.match(other.full_name, /^Driver /);
    const subjects = (await dev.query('SELECT subject FROM public.google_auth_identities ORDER BY subject')).rows.map((r) => r.subject);
    assert.ok(subjects.includes('uid-owner'));
    assert.ok(!subjects.includes('uid-other'));
    assert.ok(subjects.some((x) => x.startsWith('dev-')));
    const car = await one(`SELECT * FROM public.car_profiles WHERE id='${CAR}'`);
    assert.deepEqual([car.vin, car.photo_path, car.notes, car.make, car.model, car.year], [null, null, null, 'Toyota', 'Prius', 2010]);
    assert.match(car.name, /^Car /);
    const trip = await one(`SELECT * FROM public.sessions WHERE id='${TRIP}'`);
    assert.deepEqual([trip.source_filename, trip.source_csv, trip.source_file_path], ['trip.csv', null, null]);
    const row = await one(`SELECT data FROM public.session_rows WHERE session_id='${TRIP}'`);
    assert.deepEqual(row.data, { Coolant: 90, nested: { rpm: 800 } });
    assert.equal((await one(`SELECT title FROM public.chat_conversations WHERE id='${CHAT}'`)).title, 'Conversation');
    assert.doesNotMatch(JSON.stringify((await one('SELECT parts FROM public.chat_messages')).parts), /Main St/);
  });
  await check('secrets are never copied, stale dev rows are replaced, production is untouched', async () => {
    assert.equal((await dev.query('SELECT count(*)::int n FROM public.mcp_tokens')).rows[0].n, 0);
    assert.equal((await dev.query("SELECT count(*)::int n FROM public.app_accounts WHERE email='stale@example.test'")).rows[0].n, 0);
    assert.deepEqual((await prod.query(counts)).rows[0], before);
    assert.equal((await prod.query('SELECT email FROM public.app_accounts WHERE id=$1', [OTHER])).rows[0].email, 'other@example.test');
    // The sync opens production in a READ ONLY transaction; a write inside one must fail.
    await prod.query('BEGIN READ ONLY');
    await assert.rejects(prod.query("UPDATE public.app_accounts SET full_name = 'x'"));
    await prod.query('ROLLBACK');
  });
  await check('the sync refuses targets that could be production', () => {
    const prodUrl = 'postgres://u:p@db.internal:5432/xpeed';
    assert.throws(() => assertSafeTarget(prodUrl, prodUrl, {}), /same server/);
    assert.throws(() => assertSafeTarget('postgres://u:p@db.other:5432/other', prodUrl, {}), /not a Supabase or local/);
    assert.throws(() => assertSafeTarget(undefined, prodUrl, {}), /DATABASE_URL/);
    assertSafeTarget('postgres://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres', prodUrl, {});
    assertSafeTarget('postgres://u:p@db.drqmrddxlrlbqnydumjm.supabase.co:5432/postgres', prodUrl, {});
    assertSafeTarget('postgres://u:p@localhost:5432/x', prodUrl, {});
    assertSafeTarget('postgres://u:p@db.other:5432/other', prodUrl, { DEV_SYNC_ALLOW_TARGET: 'db.other:5432' });
  });
  await check('sensitive JSON keys are removed at any depth', () => {
    assert.deepEqual(scrubJson([{ lat: 1, ok: 2, deep: { 'GPS Longitude': 3, user_email: 'x', rpm: 4 } }]), [{ ok: 2, deep: { rpm: 4 } }]);
  });
  await prod.end(); await dev.end(); await prodDb.stop(); await devDb.stop();

  console.log(`${checks.length} database foundation checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
