// Copies the real data and files from Supabase into the app's own database and file volume.
//
//   node scripts/cutover-copy.mjs            rehearsal: copy, then compare. Safe to repeat.
//   node scripts/cutover-copy.mjs --files    only the files
//   node scripts/cutover-copy.mjs --data     only the database
//   node scripts/cutover-copy.mjs --backup <folder>   also keep a plain copy (JSON lines + the files) in that folder
//   node scripts/cutover-copy.mjs --app      no copy: run the app's own server code on the copy, as the owner, and compare with Supabase
//
// Supabase is only READ (its REST and Storage APIs, with the service role key from .env). The target
// is REPLACED: every table is emptied and refilled, so run it again for the final sync while writes
// are paused. The target database has no public port, so this opens an SSH tunnel through the
// Coolify host and takes the database URL from the Coolify API; nothing secret is printed.
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import pg from 'pg';

const env = process.env;
const SOURCE = (env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const SOURCE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const HOST = env.CUTOVER_SSH_HOST ?? 'root@188.245.112.3';
const DB_CONTAINER = env.CUTOVER_DB_CONTAINER ?? 'rutjxwshngfntydynnba9tmm';
const DB_UUID = env.CUTOVER_DB_UUID ?? DB_CONTAINER;
const VOLUME = env.CUTOVER_VOLUME ?? 'zcofe6duhppnyg7a7l7gadxe-xpeed-files';
const INFRA_ENV = env.CUTOVER_INFRA_ENV ?? 'C:/Users/Vanildo/Dev/skaleclub-apps/.env';
const LOCAL_PORT = Number(env.CUTOVER_LOCAL_PORT ?? 55432);
const PAGE = 1000;
const BATCH = 400;
const args = new Set(process.argv.slice(2));
const backupAt = process.argv.includes('--backup') ? process.argv[process.argv.indexOf('--backup') + 1] : null;
if (process.argv.includes('--backup') && (!backupAt || backupAt.startsWith('--'))) throw new Error('--backup needs a folder');
const PUBLIC_URL = (env.CUTOVER_PUBLIC_URL ?? 'https://xpeed.skale.club').replace(/\/$/, '');
const appOnly = args.has('--app');
const doData = !appOnly && !args.has('--files'), doFiles = !appOnly && !args.has('--data');

if (!SOURCE || !SOURCE_KEY) throw new Error('VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be in .env');
const say = (message) => console.log(message);
const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

// ------------------------------------------------------------------ source (Supabase, read only)
const sourceHeaders = { apikey: SOURCE_KEY, Authorization: `Bearer ${SOURCE_KEY}` };
async function sourceJson(path, init = {}) {
  const response = await fetch(`${SOURCE}${path}`, { ...init, headers: { ...sourceHeaders, ...init.headers } });
  if (!response.ok) throw new Error(`Supabase answered ${response.status} for ${path.split('?')[0]}: ${(await response.text()).slice(0, 200)}`);
  return response;
}
async function* sourceRows(table, order) {
  for (let from = 0; ; from += PAGE) {
    const query = `select=*${order.length ? `&order=${order.map(encodeURIComponent).join(',')}` : ''}`;
    const response = await sourceJson(`/rest/v1/${encodeURIComponent(table)}?${query}`, { headers: { Range: `${from}-${from + PAGE - 1}`, 'Range-Unit': 'items' } });
    const rows = await response.json();
    if (rows.length) yield rows;
    if (rows.length < PAGE) return;
  }
}
async function sourceCount(table, filter = '') {
  const response = await sourceJson(`/rest/v1/${encodeURIComponent(table)}?select=*${filter ? `&${filter}` : ''}`, { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' } });
  return Number((response.headers.get('content-range') ?? '').split('/')[1] ?? 0);
}

// ------------------------------------------------------------------ target (Coolify, through SSH)
const ssh = (command, options = {}) => new Promise((resolve, reject) => {
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, command], { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`ssh failed (${code}): ${err.trim().slice(0, 300)}`))));
});

async function openTunnel() {
  const ip = (await ssh(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${DB_CONTAINER}`)).split(/\s+/)[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Could not find the database container address');
  const tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', `${LOCAL_PORT}:${ip}:5432`, HOST], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    const open = await new Promise((resolve) => { const s = net.connect(LOCAL_PORT, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
    if (open) return tunnel;
    await new Promise((r) => setTimeout(r, 250));
  }
  tunnel.kill();
  throw new Error('The SSH tunnel did not open');
}

async function targetUrl() {
  const infra = Object.fromEntries(readFileSync(INFRA_ENV, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const base = (infra.COOLIFY_BASE ?? '').replace(/\/$/, '');
  const response = await fetch(`${base}/databases/${DB_UUID}`, { headers: { Authorization: `Bearer ${infra.COOLIFY_TOKEN}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Coolify answered ${response.status}`);
  const url = new URL((await response.json()).internal_db_url);
  url.hostname = '127.0.0.1'; url.port = String(LOCAL_PORT);
  return url.toString();
}

const publicTables = async (client) => (await client.query(`SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'xpeed\\_%' ORDER BY table_name`)).rows.map((r) => r.table_name);
const columnsOf = async (client, table) => (await client.query(`SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position`, [table])).rows.map((r) => r.column_name);
const primaryKey = async (client, table) => (await client.query(`SELECT a.attname::text AS c FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = ('public.' || quote_ident($1))::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [table])).rows.map((r) => r.c);

// ------------------------------------------------------------------ data
async function copyData(target) {
  const tables = await publicTables(target);
  const report = [];
  const hashes = new Map();
  await target.query('BEGIN');
  try {
    await target.query("SET LOCAL session_replication_role = 'replica'");
    await target.query(`TRUNCATE ${tables.map((t) => `public.${quote(t)}`).join(', ')} RESTART IDENTITY CASCADE`);
    for (const table of tables) {
      const keys = await primaryKey(target, table);
      const columns = await columnsOf(target, table);
      const list = columns.map(quote).join(', ');
      const insert = `INSERT INTO public.${quote(table)} (${list}) OVERRIDING SYSTEM VALUE
        SELECT ${list} FROM jsonb_populate_recordset(NULL::public.${quote(table)}, $1::jsonb)`;
      let copied = 0, missing = false;
      const hash = createHash('md5');
      try {
        for await (const rows of sourceRows(table, keys)) {
          for (let i = 0; i < rows.length; i += BATCH) await target.query(insert, [JSON.stringify(rows.slice(i, i + BATCH))]);
          if (keys.length) for (const row of rows) hash.update(keys.map((k) => String(row[k])).join('|') + '\n');
          if (backupAt) {
            mkdirSync(join(backupAt, 'db'), { recursive: true });
            appendFileSync(join(backupAt, 'db', `${table}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
          }
          copied += rows.length;
        }
      } catch (error) {
        if (/404/.test(error.message) || /PGRST205|does not exist/.test(error.message)) missing = true; else throw error;
      }
      hashes.set(table, keys.length ? hash.digest('hex') : null);
      report.push({ table, copied, missing });
      say(`  ${table.padEnd(30)} ${missing ? 'not in Supabase' : copied + ' rows'}`);
    }
    // Public asset links saved in settings (brand icons) pointed at Supabase's storage.
    const moved = await target.query("UPDATE public.app_settings SET setting_value = replace(setting_value, $1, $2) WHERE setting_value LIKE '%' || $1 || '%'", [`${SOURCE}/storage/v1/object/public/`, `${PUBLIC_URL}/api/storage/object/`]);
    if (moved.rowCount) say(`  rewrote the storage links in ${moved.rowCount} setting(s) to ${PUBLIC_URL}`);
    const { rows: serials } = await target.query(`SELECT c.table_name AS t, c.column_name AS c FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) IS NOT NULL`);
    for (const { t, c } of serials) {
      await target.query(`SELECT setval(pg_get_serial_sequence(format('public.%I', $1::text), $2::text), GREATEST((SELECT COALESCE(MAX(${quote(c)}), 0) FROM public.${quote(t)}), 1))`, [t, c]);
    }
    await target.query('COMMIT');
  } catch (error) {
    await target.query('ROLLBACK').catch(() => {});
    throw error;
  }
  return { tables, report, hashes };
}

async function verifyData(target, { report, hashes }) {
  say('\nChecking the copy against Supabase…');
  let problems = 0;
  for (const { table, copied, missing } of report) {
    if (missing) continue;
    const expected = await sourceCount(table);
    const actual = (await target.query(`SELECT count(*)::int AS n FROM public.${quote(table)}`)).rows[0].n;
    const keys = await primaryKey(target, table);
    let same = true;
    if (keys.length && hashes.get(table)) {
      const { rows } = await target.query(`SELECT ${keys.map((k) => `${quote(k)}::text`).join(` || '|' || `)} AS k FROM public.${quote(table)} ORDER BY ${keys.map(quote).join(', ')}`);
      const hash = createHash('md5');
      for (const row of rows) hash.update(row.k + '\n');
      same = hash.digest('hex') === hashes.get(table);
    }
    const ok = expected === actual && actual === copied && same;
    if (!ok) problems++;
    say(`  ${ok ? 'OK ' : 'DIFF'} ${table.padEnd(30)} Supabase ${expected}  copy ${actual}${same ? '' : '  (keys differ)'}`);
  }
  return problems;
}

// ------------------------------------------------------------------ files
async function listBucket(bucket, prefix = '') {
  const files = [];
  for (let offset = 0; ; offset += 100) {
    const response = await sourceJson(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 100, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    const items = await response.json();
    for (const item of items) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) files.push(...await listBucket(bucket, path)); else files.push({ path, size: item.metadata?.size ?? 0 });
    }
    if (items.length < 100) return files;
  }
}

async function copyFiles() {
  const buckets = (await (await sourceJson('/storage/v1/bucket')).json()).map((b) => b.id);
  say(`\nBuckets in Supabase: ${buckets.join(', ') || '(none)'}`);
  const staging = mkdtempSync(join(tmpdir(), 'xpeed-files-'));
  const summary = {};
  try {
    for (const bucket of buckets) {
      const files = await listBucket(bucket);
      let bytes = 0;
      for (const file of files) {
        const response = await sourceJson(`/storage/v1/object/${encodeURIComponent(bucket)}/${file.path.split('/').map(encodeURIComponent).join('/')}`);
        const data = Buffer.from(await response.arrayBuffer());
        const destination = join(staging, bucket, ...file.path.split('/'));
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, data);
        bytes += data.length;
      }
      summary[bucket] = { files: files.length, bytes };
      say(`  ${bucket.padEnd(24)} ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
    }
    if (backupAt) cpSync(staging, join(backupAt, 'files'), { recursive: true });
    const mountpoint = await ssh(`docker volume inspect ${VOLUME} -f '{{.Mountpoint}}'`);
    if (!mountpoint.startsWith('/var/lib/docker/volumes/')) throw new Error('Unexpected volume path');
    // Replace what is there so a repeated run leaves exactly the Supabase files.
    await new Promise((resolve, reject) => {
      const pack = spawn('tar', ['-C', staging, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'inherit'] });
      const unpack = spawn('ssh', ['-o', 'BatchMode=yes', HOST, `find ${mountpoint} -mindepth 1 -delete && tar -C ${mountpoint} -xf - && chown -R 1000:1000 ${mountpoint}`], { stdio: ['pipe', 'inherit', 'inherit'] });
      pack.stdout.pipe(unpack.stdin);
      unpack.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`copy to the volume failed (${code})`))));
      pack.on('error', reject); unpack.on('error', reject);
    });
    const remote = await ssh(`cd ${mountpoint} && find . -type f | wc -l && find . -type f -printf '%s\\n' | awk '{s+=$1} END {print s+0}'`);
    const [remoteFiles, remoteBytes] = remote.split(/\s+/).map(Number);
    const files = Object.values(summary).reduce((a, b) => a + b.files, 0), bytes = Object.values(summary).reduce((a, b) => a + b.bytes, 0);
    const ok = remoteFiles === files && remoteBytes === bytes;
    say(`\n${ok ? 'OK ' : 'DIFF'} files: Supabase ${files} (${bytes} bytes), volume ${remoteFiles} (${remoteBytes} bytes)`);
    return ok ? 0 : 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the app on the copy
/** Runs the server's own query code on the copied data as the owner, and compares it with Supabase. */
async function verifyApp(url) {
  const { build } = await import('esbuild');
  const cache = join(process.cwd(), 'node_modules/.cache');
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(join(cache, 'xpeed-cutover-'));
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 15_000 });
  let failures = 0;
  const check = (ok, label, detail = '') => { if (!ok) failures++; say(`  ${ok ? 'OK ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`); };
  try {
    await build({ entryPoints: { query: 'server/db-query.ts' }, outdir: out, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' }, external: ['pg', 'jose'], logLevel: 'error' });
    const { execute } = await import(pathToFileURL(join(out, 'query.mjs')).href);
    const identity = (await pool.query(`SELECT i.account_id, i.issuer, i.subject, p.project_id FROM public.google_auth_identities i
      JOIN public.google_auth_projects p ON i.issuer = 'https://securetoken.google.com/' || p.project_id LIMIT 1`)).rows[0];
    if (!identity) throw new Error('No Google identity was copied');
    const claimsFor = (sub) => ({ sub, iss: identity.issuer, aud: identity.project_id, firebase: { sign_in_provider: 'google.com' } });
    const owner = claimsFor(identity.subject);
    const ask = (caller, body) => execute(pool, caller, body);
    const rows = async (body, caller = owner) => {
      const result = await ask(caller, { kind: 'query', action: 'select', ...body });
      if (result.error) throw new Error(result.error.message);
      return result;
    };
    const userId = identity.account_id;

    say('As the owner (real Google identity row, copied data):');
    const me = await ask(owner, { kind: 'rpc', name: 'current_app_user_id' });
    check(me.data === userId, 'the Google sign-in maps to the same account id', me.error?.message);

    const admin = await ask(owner, { kind: 'rpc', name: 'is_admin_user' });
    check(!admin.error && typeof admin.data === 'boolean', `admin check answers (${admin.data})`, admin.error?.message);

    // An admin can read every car for support (the database policy says so, here as on Supabase).
    const cars = await rows({ table: 'car_profiles', select: 'id, name' });
    const sourceCars = admin.data ? await sourceCount('car_profiles') : await sourceCount('car_profiles', `user_id=eq.${userId}`);
    check(cars.data.length === sourceCars && sourceCars > 0, `cars visible: ${cars.data.length}`, `Supabase ${sourceCars}${admin.data ? ', admin sees all' : ''}`);

    const sessions = await rows({ table: 'sessions', select: 'id, car_profile_id, uploaded_at, source_filename, source_file_path, summary', order: [{ column: 'uploaded_at', ascending: false }, { column: 'id', ascending: false }], limit: 1000 });
    const sourceSessions = await sourceCount('sessions', `user_id=eq.${userId}`);
    check(sessions.data.length === sourceSessions && sourceSessions > 0, `trips visible: ${sessions.data.length}`, `Supabase ${sourceSessions}`);

    const newest = sessions.data[0];
    const readings = await rows({ table: 'session_rows', select: 'id', count: true, head: true, filters: [{ column: 'session_id', op: 'eq', value: newest.id }] });
    const sourceReadings = await sourceCount('session_rows', `session_id=eq.${newest.id}`);
    check(readings.count === sourceReadings && sourceReadings > 0, `readings of the newest trip: ${readings.count}`, `Supabase ${sourceReadings}`);

    const flags = await rows({ table: 'session_flags', select: '*, sessions(source_filename, uploaded_at)', limit: 50 });
    check(flags.data.every((f) => f.sessions && f.sessions.source_filename), `problems with their trip (embedded): ${flags.data.length}`);

    const withCar = cars.data[0].id;
    const dashboard = await ask(owner, { kind: 'rpc', name: 'get_dashboard_stats', args: { p_car_profile_id: withCar } });
    check(!dashboard.error && dashboard.data, 'dashboard statistics', dashboard.error?.message);
    const page = await ask(owner, { kind: 'rpc', name: 'trip_page', args: { p_car: withCar, p_page: 1, p_size: 20, p_day: null, p_zone: 'UTC' } });
    check(!page.error && page.data, 'trip list page', page.error?.message);
    const calendar = await ask(owner, { kind: 'rpc', name: 'trip_calendar', args: { p_car: withCar, p_month: new Date().toISOString().slice(0, 7), p_zone: 'UTC' } });
    check(!calendar.error, 'trip calendar', calendar.error?.message);

    say('\nAs somebody else, and as nobody:');
    const stranger = claimsFor('someone-else-entirely');
    check((await ask(stranger, { kind: 'rpc', name: 'current_app_user_id' })).data === null, 'an unknown Google account is not mapped to any account');
    for (const [who, caller] of [['a stranger', stranger], ['nobody signed in', null]]) {
      const seen = [];
      for (const table of ['car_profiles', 'sessions', 'session_rows', 'session_flags', 'vehicle_issues', 'mcp_tokens', 'app_accounts']) {
        // A table closed to every login (app_accounts) answers "permission denied": also nothing seen.
        const result = await ask(caller, { kind: 'query', action: 'select', table, select: 'id' });
        seen.push(result.error ? 0 : result.data.length);
      }
      check(seen.every((n) => n === 0), `${who} sees no rows`, seen.join(','));
    }

    say('\nFiles against the trips:');
    const paths = (await pool.query('SELECT source_file_path FROM public.sessions WHERE source_file_path IS NOT NULL')).rows.map((r) => r.source_file_path);
    const mountpoint = await ssh(`docker volume inspect ${VOLUME} -f '{{.Mountpoint}}'`);
    const missing = await new Promise((resolve, reject) => {
      const check = 'while IFS= read -r p; do [ -f "$p" ] || echo "$p"; done';
      const child = spawn('ssh', ['-o', 'BatchMode=yes', HOST, `cd ${mountpoint}/session-csv && ${check}`], { stdio: ['pipe', 'pipe', 'inherit'] });
      let output = '';
      child.stdout.on('data', (d) => { output += d; });
      child.on('close', () => resolve(output.split('\n').filter(Boolean)));
      child.on('error', reject);
      child.stdin.end(`${paths.join('\n')}\n`);
    });
    check(missing.length === 0, `every trip's CSV exists on the volume: ${paths.length - missing.length}/${paths.length}`, missing.slice(0, 2).join(', '));
    const folders = (await ssh(`ls ${mountpoint}/session-csv`)).split(/\s+/).filter(Boolean);
    check(folders.every((f) => f === userId), 'the CSV folders belong to the owner account', folders.join(','));

    say('\nSettings that mention Supabase (must be rewritten at the switch):');
    const settings = (await pool.query("SELECT setting_key, (setting_value LIKE '%supabase.co%') AS has_url FROM public.app_settings WHERE user_id IS NULL ORDER BY setting_key")).rows;
    for (const row of settings) say(`  ${row.has_url ? 'REWRITE' : 'ok     '} ${row.setting_key}`);
  } finally {
    await pool.end().catch(() => {});
    rmSync(out, { recursive: true, force: true });
  }
  return failures;
}

// ------------------------------------------------------------------ run
const started = Date.now();
let tunnel, target, problems = 0;
try {
  if (doData) {
    say('Opening the tunnel to the database…');
    tunnel = await openTunnel();
    target = new pg.Client({ connectionString: await targetUrl(), connectionTimeoutMillis: 15_000 });
    await target.connect();
    say('Copying tables (the target is emptied first):');
    const result = await copyData(target);
    problems += await verifyData(target, result);
  }
  if (doFiles) problems += await copyFiles();
  if (appOnly) {
    tunnel = await openTunnel();
    problems += await verifyApp(await targetUrl());
  }
  say(`\n${problems === 0 ? 'Everything matches.' : `${problems} difference(s) found.`} (${Math.round((Date.now() - started) / 1000)} s)`);
  process.exitCode = problems === 0 ? 0 : 1;
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  await target?.end().catch(() => {});
  tunnel?.kill();
}
