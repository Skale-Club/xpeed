// One guard for every script that truncates, deletes, overwrites or reseeds data.
//
// Why it exists: on 2026-11-10 scripts/cutover-copy.mjs was run against the live production
// database by mistake. It emptied the tables and replaced the files, and data was lost.
// Every destructive script now goes through this module, in two steps:
//
//   1. guardDestructive()   BEFORE touching or even connecting to anything. Refuses a target
//                           whose host is a production host. Overwriting production on purpose
//                           needs `--i-know-this-is-production` AND typing the exact host in an
//                           interactive terminal (no terminal: refused).
//   2. confirmDestructive() right before the destructive step. Prints the target host, database
//                           and what will be emptied or replaced, with counts, then asks for the
//                           target name typed back (skipped by `--yes`, never for production).
//
// Production hosts: the built-in list below (from docs/database/README.md and the cutover
// script) PLUS whatever XPEED_PROD_HOSTS adds (comma separated; it can only add, so a typo in
// the variable can never make production look safe). An entry is a host name (matches itself
// and its subdomains), `host:port` (matches that port only, used for the SSH tunnel to
// production, which looks like localhost), or a fragment of a volume path.
import { createInterface } from 'node:readline/promises';

export const PRODUCTION_FLAG = '--i-know-this-is-production';
export const YES_FLAG = '--yes';

/** Known production targets. Keep in sync with docs/database/README.md. */
export const DEFAULT_PROD_HOSTS = [
  'xpeed-db', // the Coolify database resource (PostgreSQL 17)
  'rutjxwshngfntydynnba9tmm', // its container: the host in the app's DATABASE_URL
  '188.245.112.3', // the Coolify server (SSH host of the cutover tunnel)
  'zcofe6duhppnyg7a7l7gadxe-xpeed-files', // the `xpeed-files` volume
  'xpeed.skale.club', // the public site (and xpeed.app, its future domain)
  'xpeed.app',
  '127.0.0.1:55432', // the cutover script's SSH tunnel to the production database
  'localhost:55432',
];

export class GuardError extends Error {
  constructor(message) { super(message); this.name = 'GuardError'; }
}

/** Every production entry in force: the built-in list plus XPEED_PROD_HOSTS. */
export function productionHosts(env = process.env) {
  const extra = (env.XPEED_PROD_HOSTS ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_PROD_HOSTS.map((h) => h.toLowerCase()), ...extra])];
}

/**
 * Reads a database URL (or ssh/https URL) or a plain path into { host, port, database, label }.
 * `host` is what the owner types back to confirm; `label` is what is shown.
 */
export function describeTarget(target) {
  const raw = String(target ?? '').trim();
  const match = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (match) {
    try {
      const url = new URL(raw);
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (host) return { kind: 'url', raw, host, port: url.port, database: decodeURIComponent(url.pathname.replace(/^\//, '')), label: url.port ? `${host}:${url.port}` : host };
    } catch { /* a password with raw '@' or '#' breaks URL parsing: fall back to the text after the last '@' */ }
    const after = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const hostPart = after.slice(after.lastIndexOf('@') + 1).split(/[/?#]/)[0].toLowerCase();
    const [host, port = ''] = hostPart.split(':');
    return { kind: 'url', raw, host, port, database: '', label: hostPart };
  }
  return { kind: 'path', raw, host: raw, port: '', database: '', label: raw };
}

/** The production entry this target matches, or null. */
export function findProductionMatch(target, env = process.env) {
  const info = describeTarget(target);
  if (!info.host) return null;
  const text = info.raw.toLowerCase();
  for (const entry of productionHosts(env)) {
    if (info.kind === 'path') {
      if (text.includes(entry)) return entry;
      continue;
    }
    if (entry.includes(':')) {
      if (info.port && `${info.host}:${info.port}` === entry) return entry;
    } else if (info.host === entry || info.host.endsWith(`.${entry}`)) return entry;
  }
  return null;
}

const hasTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function defaultAsk(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await rl.question(question); } finally { rl.close(); }
}
const cliArgs = () => process.argv.slice(2);

/**
 * Step 1. Call before connecting to anything.
 * @param {{ target?: string, targets?: string[], action: string, argv?: string[], env?: object,
 *   isTTY?: boolean, ask?: (q: string) => Promise<string>, say?: (m: string) => void }} options
 *   `target` is a database URL or a volume path; pass `targets` when one run touches several
 *   (database, SSH host, volume). Throws GuardError when the run must not go on.
 * @returns {Promise<{ production: boolean, host: string|null }>}
 */
export async function guardDestructive({ target, targets, action, argv = cliArgs(), env = process.env, isTTY = hasTerminal(), ask = defaultAsk, say = console.log }) {
  const list = [...(targets ?? []), ...(target === undefined ? [] : [target])].filter((t) => t !== undefined && t !== null && String(t).trim() !== '');
  if (!action) throw new GuardError('guardDestructive needs a short name for the action');
  if (!list.length) throw new GuardError(`Refused "${action}": no target given, so it cannot be checked against production`);
  const hits = list.map((t) => ({ info: describeTarget(t), entry: findProductionMatch(t, env) })).filter((h) => h.entry);
  if (!hits.length) return { production: false, host: null };

  const shown = hits[0].info.label;
  const why = `${hits.map((h) => `${h.info.label} (matches "${h.entry}")`).join(', ')} is a PRODUCTION host (the built-in list plus XPEED_PROD_HOSTS).`;
  if (!argv.includes(PRODUCTION_FLAG)) {
    throw new GuardError(`REFUSED: "${action}" would overwrite production. ${why}\n`
      + 'This is almost never right: on 2026-11-10 exactly this wiped real data. Point the script at a development or rehearsal database instead.\n'
      + `If you really mean it: pass ${PRODUCTION_FLAG} and type the host when asked, in an interactive terminal.`);
  }
  if (!isTTY) {
    throw new GuardError(`REFUSED: "${action}" targets production (${why}) and there is no interactive terminal to confirm in. Production is never overwritten unattended.`);
  }
  say(`WARNING: "${action}" will OVERWRITE PRODUCTION. ${why}`);
  say('This is almost never right. Production data written since the last copy WILL BE LOST.');
  const typed = String(await ask(`Type the exact production host (${shown}) to continue, anything else aborts: `)).trim();
  if (typed !== shown) throw new GuardError(`REFUSED: what was typed ("${typed}") is not the target host ("${shown}"). Nothing was changed.`);
  return { production: true, host: shown };
}

/**
 * Step 2. Call right before the destructive step, after the plan is known.
 * @param {{ target: string, action: string, plan?: string[], production?: boolean, argv?: string[],
 *   isTTY?: boolean, ask?: (q: string) => Promise<string>, say?: (m: string) => void }} options
 *   `plan` is one line per table or folder, with counts ("sessions: 120 rows will be emptied").
 */
export async function confirmDestructive({ target, action, plan = [], production = false, argv = cliArgs(), isTTY = hasTerminal(), ask = defaultAsk, say = console.log }) {
  const info = describeTarget(target);
  say(`About to: ${action}`);
  say(`  target host: ${info.label}`);
  if (info.database) say(`  database:    ${info.database}`);
  if (plan.length) { say('  affected:'); for (const line of plan) say(`    ${line}`); }
  if (argv.includes(YES_FLAG) && !production) return;
  if (!isTTY) throw new GuardError(`REFUSED: "${action}" needs confirmation and there is no interactive terminal. Pass ${YES_FLAG} to confirm non-interactively (a development target only).`);
  const typed = String(await ask(`Type the target name (${info.label}) to go on, anything else aborts: `)).trim();
  if (typed !== info.label) throw new GuardError(`REFUSED: what was typed ("${typed}") is not the target ("${info.label}"). Nothing was changed.`);
}

/** Runs a script's main(): a GuardError prints its message and exits with 2, never a stack trace. */
export function exitOnGuardError(error) {
  if (error instanceof GuardError) { console.error(`\n${error.message}`); process.exitCode = 2; return true; }
  return false;
}
