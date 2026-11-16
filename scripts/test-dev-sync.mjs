// Offline regression tests. Never load dotenv or contact a database/SSH server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { runDevSync } from '../db/dev-sync.mjs';
import { openProductionTunnel, tunnelSettings } from '../db/prod-tunnel.mjs';
import { assertSafeTarget, pullAnonymized } from '../db/sync.mjs';
import { assertReadOnlySource } from '../db/readonly-source.mjs';
import { findProductionMatch } from '../db/guard-destructive.mjs';

const source = 'postgres://reader:example@container:5432/app';
const env = { DATABASE_URL: 'postgres://dev:example@127.0.0.1:5432/dev', DEV_SYNC_COPY_PRODUCTION: 'true', DEV_SYNC_PROD: 'coolify', PROD_READONLY_DATABASE_URL: source, DEV_SYNC_PROD_SSH: 'operator@example.test', DEV_SYNC_PROD_DB_UUID: 'container' };
const safe = { readonly: true, privileged: false, writable: false };
const never = () => { throw new Error('Unexpected side effect'); };

test('production aliases and configured ports are protected before connecting', () => {
  for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST.', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '127.1', '2130706433', '%31%32%37.0.0.1']) {
    for (const port of [55432, 55433, 60001]) {
      const target = `postgres://dev:example@${host}:${port}/dev`;
      const cfg = { DEV_SYNC_TUNNEL_PORT: '60001' };
      assert.ok(findProductionMatch(target, cfg));
      assert.throws(() => assertSafeTarget(target, undefined, cfg), /production host/);
      assert.throws(() => assertSafeTarget(target, undefined, { ...cfg, DEV_SYNC_ALLOW_TARGET: new URL(target).host }), /production host/);
    }
  }
  assert.throws(() => assertSafeTarget('postgres://localhost:5432/dev?host=production', undefined, {}), /Unsupported/);
  assert.throws(() => assertSafeTarget('postgres://localhost:5432/dev', 'postgres://127.0.0.1/dev', {}), /same server/);
});

test('connected-client defense rejects source aliases without querying', async () => {
  await assert.rejects(pullAnonymized({ host: '::1', port: 5432, query: never }, { host: 'localhost', query: never }), /same server/);
});

test('tunnel settings reject missing credentials, options and shell injection', () => {
  for (const change of [{ PROD_READONLY_DATABASE_URL: '' }, { DEV_SYNC_PROD_SSH: '-oProxyCommand=bad' }, { DEV_SYNC_PROD_DB_UUID: 'container;bad' }, { DEV_SYNC_TUNNEL_PORT: '22' }, { DEV_SYNC_TUNNEL_PORT: 'NaN' }, { PROD_READONLY_DATABASE_URL: source + '?host=other' }, { PROD_READONLY_DATABASE_URL: source.replace('container', 'other') }]) {
    assert.throws(() => tunnelSettings({ ...env, ...change }));
  }
  assert.equal(tunnelSettings(env).port, 55433);
});

test('source role fails closed for app/admin/write roles and accepts a read-only role', async () => {
  for (const row of [undefined, { ...safe, readonly: false }, { ...safe, privileged: true }, { ...safe, writable: true }]) {
    await assert.rejects(assertReadOnlySource({ query: async () => ({ rows: row ? [row] : [] }) }), /dedicated read-only/);
  }
  await assertReadOnlySource({ query: async () => ({ rows: [safe] }) });
});

function fixture(overrides = {}) {
  const calls = [];
  const prod = { query: async () => ({ rows: [safe] }), end: async () => { calls.push('prod.end'); } };
  const dev = { end: async () => { calls.push('dev.end'); } };
  const dependencies = {
    connect: async (_, label) => { const isProd = label.includes('production'); calls.push(isProd ? 'prod.connect' : 'dev.connect'); return isProd ? prod : dev; },
    migrate: async () => { calls.push('migrate'); return { applied: [] }; },
    pull: async () => { calls.push('copy'); return { tables: {} }; },
    openTunnel: async () => { calls.push('open'); return { url: 'postgres://reader:example@127.0.0.1:55433/app', close: async () => { calls.push('close'); } }; },
    ...overrides,
  };
  return { calls, dependencies, prod, dev };
}

test('default startup only migrates fake development data even with legacy source settings', async () => {
  const f = fixture({ openTunnel: never, pull: never });
  await runDevSync({ ...env, DEV_SYNC_COPY_PRODUCTION: '', PROD_DATABASE_URL: source }, f.dependencies);
  assert.deepEqual(f.calls, ['dev.connect', 'migrate', 'dev.end']);
});

test('normal explicit copy verifies production role before touching dev and closes all resources', async () => {
  const f = fixture();
  await runDevSync(env, f.dependencies);
  assert.deepEqual(f.calls, ['open', 'prod.connect', 'dev.connect', 'migrate', 'copy', 'prod.end', 'dev.end', 'close']);
  const direct = fixture({ openTunnel: never });
  await runDevSync({ ...env, DEV_SYNC_PROD: '', PROD_DATABASE_URL: source }, direct.dependencies);
  assert.ok(direct.calls.includes('copy'));
});

test('invalid/matching destinations fail before tunnel or migrations', async () => {
  for (const target of ['postgres://localhost:55433/app', 'postgres://[::1]:55433/app']) {
    await assert.rejects(runDevSync({ ...env, DATABASE_URL: target }, { connect: never, openTunnel: never, migrate: never }), /same server|production host/);
  }
  await assert.rejects(runDevSync({ ...env, PROD_READONLY_DATABASE_URL: '' }, { connect: never, openTunnel: never }), /PROD_READONLY/);
});

test('post-open guard failure closes the acquired tunnel before any connection', async () => {
  const calls = [];
  await assert.rejects(runDevSync(env, { connect: never, openTunnel: async () => ({ url: env.DATABASE_URL, close: async () => { calls.push('close'); } }) }), /same server/);
  assert.deepEqual(calls, ['close']);
});

test('connection, role, migration and copy failures always close clients and tunnel', async () => {
  for (const stage of ['connect', 'role', 'dev-connect', 'migrate', 'copy']) {
    const f = fixture();
    if (stage === 'connect') f.dependencies.connect = async () => { throw new Error(stage); };
    if (stage === 'role') f.prod.query = async () => ({ rows: [{ ...safe, writable: true }] });
    if (stage === 'dev-connect') f.dependencies.connect = async (_, label) => { if (label.includes('production')) return f.prod; throw new Error(stage); };
    if (stage === 'migrate') f.dependencies.migrate = async () => { throw new Error(stage); };
    if (stage === 'copy') f.dependencies.pull = async () => { throw new Error(stage); };
    await assert.rejects(runDevSync(env, f.dependencies));
    assert.equal(f.calls.at(-1), 'close');
    if (stage !== 'connect') assert.ok(f.calls.includes('prod.end'));
    if (stage === 'role') assert.ok(!f.calls.includes('dev.connect'));
  }
});

test('SSH tunnel closes on timeout, startup error and child exit; binds only loopback', async () => {
  for (const mode of ['ready', 'timeout', 'error', 'exit']) {
    const child = new EventEmitter(); Object.assign(child, { pid: 123, exitCode: null, killed: false });
    child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
    let probe = 0, args;
    const deps = {
      inspect: async () => '172.18.0.2',
      portOpen: async () => { probe++; return probe > 1 && mode === 'ready'; },
      spawn: (_, argv) => { args = argv; if (mode === 'error') queueMicrotask(() => child.emit('error', new Error('spawn failed'))); if (mode === 'exit') queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1); }); return child; },
      wait: async () => {},
    };
    if (mode === 'ready') { const tunnel = await openProductionTunnel(env, deps); assert.ok(args.includes('127.0.0.1:55433:172.18.0.2:5432')); await tunnel.close(); await tunnel.close(); }
    else await assert.rejects(openProductionTunnel(env, deps), /exited|did not open/);
    assert.ok(child.killed || child.exitCode != null);
  }
});
