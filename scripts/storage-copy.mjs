// Copies every file from one storage driver to another (disk -> s3, s3 -> s3, s3 -> disk), for moving to R2, B2 or Hetzner.
//
//   node scripts/storage-copy.mjs --from disk --to s3             DRY RUN (default): lists what would be copied. Changes nothing.
//   node scripts/storage-copy.mjs --from disk --to s3 --apply     copies, then checks the size of every object on the destination.
//
// Options
//   --bucket <name>        only this app bucket (repeat for several); default: all of them
//   --verify-content       after copying, also read every copied object back and compare its SHA-256 (slower)
//   --yes                  skip the typed confirmation of a non-empty destination (never for a production destination)
//   --from-dir / --to-dir  folder of a disk side (same as SRC_STORAGE_DIR / DST_STORAGE_DIR)
//
// Settings: each side reads the usual variables (STORAGE_DIR, S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE). To give the two sides different ones, prefix with SRC_ (the source) or
// DST_ (the destination): SRC_S3_BUCKET=old DST_S3_BUCKET=new. A prefixed variable wins over the plain one.
//
// Safety, in the order it applies:
//   - The source is only READ. This script never deletes, moves or changes anything there.
//   - It never deletes anything on the destination either: it adds objects and replaces ones that differ.
//   - Without --apply nothing is written, anywhere.
//   - An object already on the destination with the same size is skipped, so a run can be repeated or resumed.
//   - If the destination holds objects the source does not have, or objects with the same name and a different size
//     (a copy that would overwrite something), the run goes through db/guard-destructive.mjs: a production destination
//     is refused (unless --i-know-this-is-production and the host is typed), anything else asks for the destination's
//     name to be typed back (--yes skips that for a non-production destination). With no terminal and no --yes it refuses.
//
// Exit code: 0 when every object is on the destination with the right size, 1 when anything failed or differs, 2 when
// the guard refused.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { confirmDestructive, exitOnGuardError, guardDestructive } from '../db/guard-destructive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
const buckets = argv.flatMap((a, i) => (a === '--bucket' && argv[i + 1] ? [argv[i + 1]] : []));
const say = (message = '') => console.log(message);
const SETTINGS = ['STORAGE_DIR', 'S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_FORCE_PATH_STYLE'];
const apply = flag('--apply');

function usage(message) {
  if (message) console.error(`\n${message}\n`);
  console.error('Usage: node scripts/storage-copy.mjs --from <disk|s3> --to <disk|s3> [--apply] [--bucket name] [--verify-content] [--yes]');
  console.error('Without --apply it only shows what would be copied.');
  process.exit(message ? 2 : 0);
}

function sideEnv(prefix, driver, dir) {
  const env = { STORAGE_DRIVER: driver };
  for (const key of SETTINGS) env[key] = process.env[`${prefix}_${key}`] ?? process.env[key];
  if (dir) env.STORAGE_DIR = dir;
  return env;
}

const from = option('--from'), to = option('--to');
if (flag('--help') || flag('-h')) usage();
if (!['disk', 's3'].includes(from ?? '') || !['disk', 's3'].includes(to ?? '')) usage('--from and --to must each be "disk" or "s3".');
const sourceEnv = sideEnv('SRC', from, option('--from-dir')), destinationEnv = sideEnv('DST', to, option('--to-dir'));
for (const [name, env] of [['source', sourceEnv], ['destination', destinationEnv]]) {
  if (env.STORAGE_DRIVER === 'disk' && !env.STORAGE_DIR) usage(`The ${name} is a disk: set STORAGE_DIR (or SRC_/DST_STORAGE_DIR, or --from-dir/--to-dir). The default folder is not assumed here.`);
}

/** What the guard and the person see as the destination: the folder, or `endpoint/bucket`. */
const describe = (env) => (env.STORAGE_DRIVER === 'disk' ? resolve(env.STORAGE_DIR) : `${String(env.S3_ENDPOINT ?? '').replace(/\/+$/, '')}/${env.S3_BUCKET ?? ''}`);
if (describe(sourceEnv) === describe(destinationEnv)) usage('The source and the destination are the same place.');

// The server's own code (TypeScript) is bundled for this run, so the copy uses exactly the drivers the app uses.
mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const outDir = mkdtempSync(resolve(root, 'node_modules/.cache/storage-copy-'));
let drivers;
try {
  await build({
    stdin: { contents: "export * from './server/storage-driver.ts'; export { BUCKETS } from './server/files.ts';", resolveDir: root, sourcefile: 'storage-copy-entry.ts', loader: 'ts' },
    outfile: resolve(outDir, 'drivers.mjs'), bundle: true, platform: 'node', format: 'esm', absWorkingDir: root, logLevel: 'error', tsconfig: resolve(root, 'tsconfig.app.json'),
  });
  drivers = await import(pathToFileURL(resolve(outDir, 'drivers.mjs')).href);
} finally {
  // The bundle is loaded; nothing else needs the folder.
  rmSync(outDir, { recursive: true, force: true });
}

const wanted = buckets.length ? buckets : Object.keys(drivers.BUCKETS);
for (const name of wanted) if (!Object.prototype.hasOwnProperty.call(drivers.BUCKETS, name)) usage(`Unknown bucket "${name}". Known: ${Object.keys(drivers.BUCKETS).join(', ')}.`);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mb = (bytes) => (bytes / 1048576).toFixed(1);

async function main() {
  const source = drivers.createStore(sourceEnv);
  const destination = drivers.createStore(destinationEnv);
  say(`${apply ? 'COPY' : 'DRY RUN'}: ${from} (${describe(sourceEnv)}) -> ${to} (${describe(destinationEnv)})`);

  // ---- look at both sides (reads only)
  const plan = { copy: [], same: [], conflicts: [], extras: [] };
  for (const bucket of wanted) {
    const here = new Map(), there = new Map();
    for await (const object of source.listAll(bucket)) here.set(object.path, object.size);
    for await (const object of destination.listAll(bucket)) there.set(object.path, object.size);
    for (const [path, size] of here) {
      const existing = there.get(path);
      if (existing === undefined) plan.copy.push({ bucket, path, size });
      else if (existing === size) plan.same.push({ bucket, path, size });
      else { plan.copy.push({ bucket, path, size }); plan.conflicts.push({ bucket, path, size, existing }); }
    }
    for (const [path, size] of there) if (!here.has(path)) plan.extras.push({ bucket, path, size });
    say(`  ${bucket}: ${here.size} on the source, ${there.size} on the destination`);
  }
  const bytes = plan.copy.reduce((sum, o) => sum + o.size, 0);
  say(`To copy: ${plan.copy.length} objects (${mb(bytes)} MB). Already there with the same size: ${plan.same.length}.`);
  if (plan.conflicts.length) say(`Would REPLACE ${plan.conflicts.length} objects that exist on the destination with a different size (for example ${plan.conflicts[0].bucket}/${plan.conflicts[0].path}).`);
  if (plan.extras.length) say(`The destination holds ${plan.extras.length} objects the source does not (they are left alone; for example ${plan.extras[0].bucket}/${plan.extras[0].path}).`);
  const unexpected = plan.conflicts.length > 0 || plan.extras.length > 0;

  if (!apply) {
    if (unexpected) say('With --apply this would ask for confirmation first, because the destination is not empty in a way a plain copy would not explain.');
    say('\nDRY RUN: nothing was changed. Run again with --apply to copy.');
    return 0;
  }

  // ---- a destination that holds something unexpected goes through the guard
  if (unexpected) {
    const target = describe(destinationEnv);
    const action = 'copy files into a destination that is not empty';
    const { production } = await guardDestructive({ target, action });
    await confirmDestructive({
      target, action, production,
      plan: [
        `${plan.copy.length} objects will be written (${mb(bytes)} MB)`,
        `${plan.conflicts.length} of them REPLACE an object with a different size`,
        `${plan.extras.length} objects on the destination are not in the source and stay untouched`,
        'nothing is deleted, on either side',
      ],
    });
  }

  // ---- copy
  const failures = [];
  let done = 0;
  const queue = [...plan.copy];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      try {
        const data = await source.get(item.bucket, item.path);
        if (!data) throw new Error('vanished from the source');
        await destination.put(item.bucket, item.path, data, { upsert: true });
        done++;
        if (done % 50 === 0) say(`  copied ${done}/${plan.copy.length}`);
      } catch (error) { failures.push(`${item.bucket}/${item.path}: ${error instanceof Error ? error.message : 'failed'}`); }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  say(`Copied ${done} of ${plan.copy.length}.`);

  // ---- verify: every object of the source is on the destination with the same size (and the same bytes, if asked)
  const copied = new Set(plan.copy.map((o) => `${o.bucket}/${o.path}`));
  const mismatches = [];
  let checked = 0;
  for (const item of [...plan.copy, ...plan.same]) {
    try {
      const head = await destination.head(item.bucket, item.path);
      if (!head) mismatches.push(`${item.bucket}/${item.path}: missing on the destination`);
      else if (head.size !== item.size) mismatches.push(`${item.bucket}/${item.path}: ${item.size} bytes on the source, ${head.size} on the destination`);
      else if (flag('--verify-content') && copied.has(`${item.bucket}/${item.path}`)) {
        const [a, b] = await Promise.all([source.get(item.bucket, item.path), destination.get(item.bucket, item.path)]);
        if (!a || !b || sha(a) !== sha(b)) mismatches.push(`${item.bucket}/${item.path}: content differs`);
      }
      checked++;
    } catch (error) { mismatches.push(`${item.bucket}/${item.path}: ${error instanceof Error ? error.message : 'could not be checked'}`); }
  }
  say(`Checked ${checked} objects on the destination.`);
  for (const line of [...failures, ...mismatches].slice(0, 20)) console.error(`  PROBLEM ${line}`);
  if (failures.length + mismatches.length) {
    console.error(`\n${failures.length} copy failures and ${mismatches.length} mismatches. The source was not touched. Run again to retry what is missing.`);
    return 1;
  }
  say(`\nDone: ${plan.copy.length + plan.same.length} objects are on the destination with the right size. The source was not touched.`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!exitOnGuardError(error)) { console.error(`\nFailed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
