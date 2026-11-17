#!/usr/bin/env node
// Read-only inventory: manifests are metadata; game asset bytes are never read.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 1024 * 1024, MAX_MANIFESTS = 2000;
export function parseVdf(source) {
  let i = 0;
  function token() {
    while (i < source.length) {
      if (/\s/.test(source[i])) { i++; continue; }
      if (source.slice(i, i + 2) === '//') { while (i < source.length && source[i] !== '\n') i++; continue; }
      break;
    }
    if (i === source.length) return null;
    const ch = source[i++];
    if (ch === '{' || ch === '}') return ch;
    if (ch !== '"') throw Error('Expected quoted VDF string');
    let result = '';
    while (i < source.length) {
      const c = source[i++];
      if (c === '"') return { value: result };
      if (c === '\\') {
        if (i === source.length) break;
        const next = source[i++];
        result += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else result += c;
    }
    throw Error('Unterminated VDF string');
  }
  function object(nested = false, depth = 0) {
    if (depth > 20) throw Error('VDF nesting limit');
    const result = Object.create(null);
    for (;;) {
      const key = token();
      if (key === null) { if (nested) throw Error('Missing closing brace'); return result; }
      if (key === '}') { if (!nested) throw Error('Unexpected closing brace'); return result; }
      if (!key.value || Object.hasOwn(result, key.value)) throw Error('Invalid or duplicate VDF key');
      const value = token();
      if (value === '{') result[key.value] = object(true, depth + 1);
      else if (value && typeof value === 'object') result[key.value] = value.value;
      else throw Error('Missing VDF value');
    }
  }
  return object();
}
async function readMetadata(file) {
  // Refuse metadata aliases before opening, including Steam's library list.
  if (!(await fs.lstat(file)).isFile()) throw Error('Metadata must be a regular file, not a symlink/junction');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw Error('Metadata file size/type limit');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const next = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > MAX_BYTES) throw Error('Metadata file size limit');
    return parseVdf(buffer.toString('utf8', 0, bytesRead));
  } finally { await handle.close(); }
}
export async function canonical(target) {
  const absolute = path.resolve(target);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonical(parent), path.basename(absolute));
  }
}
const inside = (file, root) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const issue = (where, error) => ({ path: where, message: error.message });
export async function inventory({ steamRoots = [], games = [], maxEntries = 10000, maxDepth = 8 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) throw Error('Invalid traversal limits');
  const report = { warning: 'Metadata only. Candidates are unvalidated; no native geometry support is proven. Partial scans never establish absence of geometry.', steam: [], games: [], errors: [], protectedRoots: [] };
  const protect = async root => {
    const p = await canonical(root);
    for (const name of [path.resolve(root), p]) if (!report.protectedRoots.includes(name)) report.protectedRoots.push(name);
    return p;
  };
  const libraries = new Set();
  for (const root of steamRoots) {
    try {
      libraries.add(await protect(root));
      const file = path.join(root, 'steamapps', 'libraryfolders.vdf');
      const data = (await readMetadata(file)).libraryfolders;
      if (!data || typeof data !== 'object') throw Error('Missing libraryfolders object');
      for (const [key, value] of Object.entries(data)) {
        if (!/^\d+$/.test(key)) continue;
        const folder = typeof value === 'string' ? value : value.path;
        if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Invalid library path');
        libraries.add(await protect(folder));
      }
    } catch (error) { report.errors.push(issue(root, error)); }
  }
  for (const root of libraries) {
    const library = { root, apps: [], errors: [], complete: true }; report.steam.push(library);
    const dir = path.join(root, 'steamapps');
    try {
      const entries = await fs.opendir(dir); let count = 0;
      for await (const entry of entries) {
        if (++count > MAX_MANIFESTS) { library.complete = false; library.errors.push(issue(dir, Error('Manifest directory entry limit'))); break; }
        if (!/^appmanifest_\d+\.acf$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        try {
          if (!entry.isFile()) throw Error('Manifest is not a regular file');
          const app = (await readMetadata(file)).AppState;
          if (!app || ['appid', 'name', 'installdir', 'buildid'].some(k => typeof app[k] !== 'string' || !app[k])) throw Error('Missing manifest metadata');
          if (!/^\d+$/.test(app.appid) || entry.name !== `appmanifest_${app.appid}.acf`) throw Error('Manifest appid mismatch');
          if (app.installdir === '.' || app.installdir === '..' || /[\\/:]/.test(app.installdir)) throw Error('Unsafe installdir');
          const installPath = path.join(dir, 'common', app.installdir);
          const resolved = await protect(installPath);
          let installDirectoryPresent = false;
          try { installDirectoryPresent = (await fs.stat(installPath)).isDirectory(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          library.apps.push({ appid: app.appid, name: app.name, installdir: app.installdir, buildid: app.buildid, installPath: resolved, installDirectoryPresent, evidence: 'manifest metadata; directory presence does not validate game assets' });
        } catch (error) { library.complete = false; library.errors.push(issue(file, error)); }
      }
    } catch (error) { library.complete = false; library.errors.push(issue(dir, error)); }
  }
  for (const { id, dir } of games) {
    const game = { id, root: path.resolve(dir), complete: true, entriesVisited: 0, candidates: [], containers: [], errors: [], limits: [] }; report.games.push(game);
    const fail = (p, error) => { game.complete = false; game.errors.push(issue(p, error)); };
    try {
      await protect(dir);
      if (!(await fs.lstat(dir)).isDirectory()) throw Error('Game root must be a real directory, not a symlink/junction');
      async function walk(folder, depth) {
        try {
          for await (const entry of await fs.opendir(folder)) {
            if (game.entriesVisited >= maxEntries) { game.complete = false; if (!game.limits.includes('maxEntries')) game.limits.push('maxEntries'); return; }
            game.entriesVisited++;
            const file = path.join(folder, entry.name);
            if (entry.isSymbolicLink()) { game.complete = false; game.limits.push(`Skipped symlink/junction: ${path.relative(dir, file)}`); continue; }
            if (entry.isDirectory()) {
              if (depth >= maxDepth) { game.complete = false; game.limits.push(`maxDepth: ${path.relative(dir, file)}`); }
              else await walk(file, depth + 1);
            } else if (entry.isFile()) {
              const name = entry.name.toLowerCase();
              const candidate = /^(fast_lane|pit_lane)\.ai$/.test(name) || /\.(aiw|aisplinedata|trackcontrolpoints)$/.test(name);
              const container = /\.(kspkg|mas|bff|pak)$/.test(name);
              if (candidate || container) {
                const stat = await fs.lstat(file);
                if (!stat.isFile()) { fail(file, Error('File type changed during scan')); continue; }
                (candidate ? game.candidates : game.containers).push({ path: path.relative(dir, file), bytes: stat.size, modified: stat.mtime.toISOString(), validation: candidate ? 'unvalidated candidate' : 'container metadata only; not geometry' });
              }
            }
            if (game.entriesVisited >= maxEntries && game.limits.includes('maxEntries')) return;
          }
        } catch (error) { fail(folder, error); }
      }
      await walk(dir, 0);
    } catch (error) { fail(dir, error); }
  }
  return report;
}
export async function writeReport(output, report) {
  const destination = await canonical(output);
  for (const root of report.protectedRoots) if (inside(path.resolve(output), root) || inside(destination, await canonical(root))) throw Error('Report output must be outside every Steam, library and game tree');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.native-tracks-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.close();
    // Hard linking publishes the complete file atomically, refusing an existing name.
    await fs.link(temporary, destination);
  } finally { await handle.close(); await fs.unlink(temporary); }
}
export async function main(args = process.argv.slice(2)) {
  const options = { steamRoots: [], games: [] }; let output;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' || flag === '-h') {
      console.log('Usage: node scripts/inventory-native-tracks.mjs [--steam-root ROOT] [--game ID=DIR] [--max-entries N] [--max-depth N] [--out FILE]\nRepeat --steam-root and --game as needed. Default Steam roots: ProgramFiles(x86)/Steam and ProgramFiles/Steam. Only explicitly supplied --game directories are scanned.\nGame asset content is never read; no packages opened, hashes, extraction or uploads. Game assets remain untouched. Candidates prove no geometry support. Traversal is bounded and skips symlinks/junctions. JSON goes to stdout unless --out is supplied; output is exclusive and outside all game/Steam/library trees. Recommended local report location: .codex-local/native-tracks/.'); return;
    }
    if (!['--steam-root', '--game', '--max-entries', '--max-depth', '--out'].includes(flag) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw Error(`Unknown option or missing value: ${flag}`);
    const value = args[++i];
    if (flag === '--steam-root') options.steamRoots.push(path.resolve(value));
    else if (flag === '--game') { const split = value.indexOf('='); if (split < 1 || split === value.length - 1) throw Error('Expected --game ID=DIR'); options.games.push({ id: value.slice(0, split), dir: path.resolve(value.slice(split + 1)) }); }
    else if (flag === '--out') output = value;
    else options[flag === '--max-depth' ? 'maxDepth' : 'maxEntries'] = Number(value);
  }
  if (!options.steamRoots.length) for (const env of ['ProgramFiles(x86)', 'ProgramFiles']) if (process.env[env]) options.steamRoots.push(path.join(process.env[env], 'Steam'));
  const report = await inventory(options);
  if (output) await writeReport(output, report); else console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
