// Optional development tunnel: explicit read-only credentials, never the app's Coolify credential.
import { spawn } from 'node:child_process';
import net, { isIP } from 'node:net';

export function tunnelSettings(env) {
  const host = env.DEV_SYNC_PROD_SSH;
  const dbUuid = env.DEV_SYNC_PROD_DB_UUID;
  const port = Number(env.DEV_SYNC_TUNNEL_PORT || 55433);
  if (!host || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(host)) throw new Error('Set DEV_SYNC_PROD_SSH to an explicit SSH host or user@host');
  if (!dbUuid || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(dbUuid)) throw new Error('Set DEV_SYNC_PROD_DB_UUID to a container name');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DEV_SYNC_TUNNEL_PORT must be an integer from 1024 to 65535');
  let url;
  try { url = new URL(env.PROD_READONLY_DATABASE_URL); } catch { throw new Error('Set PROD_READONLY_DATABASE_URL to a dedicated read-only PostgreSQL connection string'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || url.hostname !== dbUuid || (url.port && url.port !== '5432')) {
    throw new Error('PROD_READONLY_DATABASE_URL must use the configured database container on port 5432');
  }
  if ([...url.searchParams.keys()].some((key) => !['sslmode', 'application_name'].includes(key))) throw new Error('Unsupported source connection option');
  return { host, dbUuid, port, url };
}

const sshOptions = ['-F', 'none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'GatewayPorts=no'];
function inspect(host, dbUuid) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshOptions, host, `docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' ${dbUuid}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Production container lookup timed out')); }, 15_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start SSH')); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error('Production container lookup failed')); });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

export async function openProductionTunnel(env = process.env, dependencies = {}) {
  const config = tunnelSettings(env);
  const probe = dependencies.portOpen || portOpen;
  const lookup = dependencies.inspect || inspect;
  const start = dependencies.spawn || spawn;
  const wait = dependencies.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (await probe(config.port)) throw new Error('The configured production tunnel port is already in use');
  const ip = String(await lookup(config.host, config.dbUuid)).split(/\s+/)[0];
  if (isIP(ip) !== 4) throw new Error('Could not find the production database container address');
  const child = start('ssh', [...sshOptions, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-L', `127.0.0.1:${config.port}:${ip}:5432`, config.host], { stdio: 'ignore' });
  let failed = false;
  child.once('error', () => { failed = true; });
  child.once('exit', () => { failed = true; });
  const killOnExit = () => { if (!child.killed && child.exitCode == null) child.kill(); };
  let closing;
  const close = () => {
    process.off('exit', killOnExit);
    return closing ||= new Promise((resolve) => {
      if (child.exitCode != null || child.pid == null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  };
  process.once('exit', killOnExit);
  try {
    for (let i = 0; i < 40; i++) {
      if (failed || child.exitCode != null) throw new Error('The production SSH tunnel exited');
      if (await probe(config.port)) {
        if (failed || child.exitCode != null) throw new Error('The production SSH tunnel exited');
        const url = new URL(config.url);
        url.hostname = '127.0.0.1';
        url.port = String(config.port);
        return { url: url.toString(), close };
      }
      await wait(250);
    }
    throw new Error('The SSH tunnel to the production database did not open');
  } catch (error) { await close(); throw error; }
}
