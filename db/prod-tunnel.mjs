// Read-only access to the production database for `npm run dev`, without a public port.
//
// With DEV_SYNC_PROD=coolify (and no PROD_DATABASE_URL), dev-sync asks the Coolify API for the
// production database URL and opens an SSH tunnel to its container on the Coolify host, exactly
// as scripts/cutover-copy.mjs does. The URL and its password stay in memory; nothing is printed.
// The sync only reads production (REPEATABLE READ READ ONLY in db/sync.mjs).
//
// Settings (none secret), in .env:
//   DEV_SYNC_PROD=coolify
//   DEV_SYNC_PROD_SSH        ssh target of the Coolify host      (default root@188.245.112.3)
//   DEV_SYNC_PROD_DB_UUID    Coolify database UUID = container    (default rutjxwshngfntydynnba9tmm)
//   DEV_SYNC_INFRA_ENV       file holding COOLIFY_BASE and COOLIFY_TOKEN
//                            (default C:/Users/Vanildo/Dev/skaleclub-apps/.env)
//   DEV_SYNC_TUNNEL_PORT     local port of the tunnel             (default 55433)
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';

function settings(env) {
  return {
    host: env.DEV_SYNC_PROD_SSH || 'root@188.245.112.3',
    dbUuid: env.DEV_SYNC_PROD_DB_UUID || 'rutjxwshngfntydynnba9tmm',
    infraEnv: env.DEV_SYNC_INFRA_ENV || 'C:/Users/Vanildo/Dev/skaleclub-apps/.env',
    port: Number(env.DEV_SYNC_TUNNEL_PORT || 55433),
  };
}

function ssh(host, command) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`ssh failed (${code}): ${err.trim().slice(0, 200)}`))));
  });
}

const portOpen = (port) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
  socket.on('error', () => resolve(false));
});

async function productionUrl({ infraEnv, dbUuid, port }) {
  const infra = Object.fromEntries(readFileSync(infraEnv, 'utf8').split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')]));
  const base = (infra.COOLIFY_BASE ?? '').replace(/\/$/, '');
  if (!base || !infra.COOLIFY_TOKEN) throw new Error(`COOLIFY_BASE and COOLIFY_TOKEN must be in ${infraEnv}`);
  const response = await fetch(`${base}/databases/${dbUuid}`, { headers: { Authorization: `Bearer ${infra.COOLIFY_TOKEN}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Coolify answered ${response.status} for the production database`);
  const url = new URL((await response.json()).internal_db_url);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return url.toString();
}

/**
 * Opens the tunnel and returns `{ url, close }`. `url` points at 127.0.0.1 and reaches the
 * production database through SSH; call `close()` when done.
 */
export async function openProductionTunnel(env = process.env) {
  const config = settings(env);
  if (await portOpen(config.port)) throw new Error(`Local port ${config.port} is already in use; set DEV_SYNC_TUNNEL_PORT to a free port`);
  const url = await productionUrl(config);
  const ip = (await ssh(config.host, `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${config.dbUuid}`)).split(/\s+/)[0];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Could not find the production database container address');
  const tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-L', `${config.port}:${ip}:5432`, config.host], { stdio: 'ignore' });
  const close = () => { if (!tunnel.killed) tunnel.kill(); };
  for (let i = 0; i < 40; i++) {
    if (await portOpen(config.port)) return { url, close };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  close();
  throw new Error('The SSH tunnel to the production database did not open');
}
