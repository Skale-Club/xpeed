import { migrate as migrateDatabase } from './migrate.mjs';
import { assertSafeTarget, databaseEndpoint, pullAnonymized } from './sync.mjs';
import { openProductionTunnel, tunnelSettings } from './prod-tunnel.mjs';
import { assertReadOnlySource } from './readonly-source.mjs';

// Dependency injection keeps safety and lifecycle tests offline, without loading .env.
export async function runDevSync(env, { connect, migrate = migrateDatabase, pull = pullAnonymized, openTunnel = openProductionTunnel, log = () => {} }) {
  if (env.DEV_SYNC === 'off') { log('skipped (DEV_SYNC=off)'); return; }
  if (!env.DATABASE_URL) { log('DATABASE_URL is not set: keeping the development database as it is'); return; }
  const copy = env.DEV_SYNC_COPY_PRODUCTION === 'true';
  const viaSsh = copy && env.DEV_SYNC_PROD === 'coolify';
  if (copy && env.DEV_SYNC_PROD && env.DEV_SYNC_PROD !== 'coolify') throw new Error('Unsupported DEV_SYNC_PROD mode');
  let source = copy ? env.PROD_DATABASE_URL : undefined;
  if (viaSsh) {
    const config = tunnelSettings(env);
    const url = new URL(config.url);
    url.hostname = '127.0.0.1'; url.port = String(config.port);
    source = url.toString();
  }
  if (copy && !source) throw new Error('Production copy requested without a configured read-only source');
  if (source) databaseEndpoint(source);
  // Before opening a tunnel, connecting, or running any migrations.
  assertSafeTarget(env.DATABASE_URL, source || env.PROD_DATABASE_URL, env);
  let dev, prod, tunnel;
  let aborted = false;
  const interrupt = (code) => { aborted = true; process.exitCode = code; void tunnel?.close(); };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  const active = () => { if (aborted) throw new Error('Development sync interrupted'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    if (viaSsh) { tunnel = await openTunnel(env); active(); source = tunnel.url; assertSafeTarget(env.DATABASE_URL, source, env); }
    if (source) {
      prod = await connect(source, 'the read-only production source');
      active();
      await assertReadOnlySource(prod);
      active();
    }
    dev = await connect(env.DATABASE_URL, 'the development database');
    active();
    const result = await migrate(dev, { log });
    active();
    log(`schema up to date (${result.applied.length} migrations applied)`);
    if (!copy) { log('production copy is off: keeping the existing fake development data'); return; }
    const list = (value) => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    const summary = await pull(prod, dev, { keepEmails: list(env.DEV_KEEP_EMAILS), keepPhones: list(env.DEV_KEEP_PHONES), log, env });
    log(`copied anonymized rows into ${Object.keys(summary.tables).length} development tables`);
  } finally {
    try {
      await prod?.end().catch(() => {});
      await dev?.end().catch(() => {});
    } finally {
      await tunnel?.close();
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
    }
  }
}
