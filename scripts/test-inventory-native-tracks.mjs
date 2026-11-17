import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { inventory, writeReport, parseVdf } from './inventory-native-tracks.mjs';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const steam = path.join(root, 'Steam'), external = path.join(root, 'Custom Library');
  for (const folder of [steam, external]) await fs.mkdir(path.join(folder, 'steamapps', 'common'), { recursive: true });
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" ${quote(steam)} } "1" { "path" ${quote(external)} } }`);
  return { root, steam, external };
}
async function manifest(library, id, install, build = '00001234567890123456789') {
  await fs.writeFile(path.join(library, 'steamapps', `appmanifest_${id}.acf`), `"AppState" { "appid" "${id}" "name" "A \\"quoted\\" game" "installdir" ${quote(install)} "buildid" "${build}" }`);
}

test('VDF preserves escaped paths and names and rejects malformed input', () => {
  assert.equal(parseVdf('"a" "C:\\\\Games\\\\a"').a, 'C:\\Games\\a');
  assert.equal(parseVdf('"a" "hello \\"world\\""').a, 'hello "world"');
  for (const source of ['"a" {', '"a" "b" }', '"a" "unterminated', '"a" "b" "a" "c"']) assert.throws(() => parseVdf(source));
});
test('Steam libraries retain exact metadata and distinguish missing directories', async t => {
  const { steam, external } = await fixture(t);
  await manifest(steam, '11', 'Present'); await manifest(external, '22', 'Missing');
  await fs.mkdir(path.join(steam, 'steamapps', 'common', 'Present'));
  const report = await inventory({ steamRoots: [steam] });
  assert.equal(report.steam.length, 2);
  assert.deepEqual(report.errors, []);
  const apps = report.steam.flatMap(l => l.apps);
  assert.equal(apps.length, 2); assert.equal(apps[0].buildid, '00001234567890123456789');
  assert.equal(apps[0].name, 'A "quoted" game');
  assert.equal(apps.find(a => a.appid === '11').installDirectoryPresent, true);
  assert.equal(apps.find(a => a.appid === '22').installDirectoryPresent, false);
  assert.equal(report.games.length, 0);
});
test('Legacy VDF external-library strings are discovered', async t => {
  const { steam, external } = await fixture(t);
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "1" ${quote(external)} }`);
  await manifest(external, '12', 'Legacy');
  const report = await inventory({ steamRoots: [steam] });
  assert.deepEqual(report.errors, []);
  assert.equal(report.steam.flatMap(l => l.apps)[0].appid, '12');
});

test('A malformed middle library does not suppress later libraries and identifies its metadata', async t => {
  const { steam, external } = await fixture(t);
  const folders = path.join(steam, 'steamapps', 'libraryfolders.vdf');
  await fs.writeFile(folders, `"libraryfolders" { "0" { "path" ${quote(steam)} } "1" { "path" "relative-broken-library" } "2" { "path" ${quote(external)} } }`);
  await manifest(external, '22', 'AfterBrokenLibrary');
  const report = await inventory({ steamRoots: [steam] });
  assert.equal(report.steamDiscoveryComplete, false);
  assert.equal(report.steam.flatMap(l => l.apps).find(a => a.appid === '22').installdir, 'AfterBrokenLibrary');
  assert.equal(report.errors.length, 1);
  assert.deepEqual(report.errors[0], { path: 'relative-broken-library', message: 'Invalid library path', metadataPath: folders, libraryKey: '1' });
});

test('A middle library realpath failure does not suppress later libraries', async t => {
  const { root, steam, external } = await fixture(t);
  const broken = path.join(root, 'loop');
  try { await fs.symlink(broken, broken, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Directory links unavailable'); return; } throw error; }
  await fs.writeFile(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders" { "0" { "path" ${quote(steam)} } "1" { "path" ${quote(broken)} } "2" { "path" ${quote(external)} } }`);
  await manifest(external, '23', 'AfterRealpathFailure');
  const report = await inventory({ steamRoots: [steam] });
  assert.equal(report.steamDiscoveryComplete, false);
  assert.equal(report.steam.flatMap(l => l.apps).find(a => a.appid === '23').installdir, 'AfterRealpathFailure');
  assert.equal(report.errors[0].path, broken);
  assert.equal(report.errors[0].libraryKey, '1');
  assert.ok(report.errors[0].code);
});
test('CLI rejects missing or unknown flags and invalid traversal limits', () => {
  const cli = path.join(import.meta.dirname, 'inventory-native-tracks.mjs');
  for (const args of [['--unknown'], ['--out'], ['--out', '--help'], ['--game', 'invalid'], ['--max-entries', '0'], ['--max-depth', '-1'], ['--max-entries', 'NaN']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Unknown option|missing value|Expected --game|Invalid traversal limits/);
  }
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /Game asset content is never read/);
});
test('Steam metadata symlinks are refused without parsing their targets', async t => {
  const { root, steam } = await fixture(t);
  const target = path.join(root, 'outside-metadata'); await fs.writeFile(target, 'not VDF');
  const folders = path.join(steam, 'steamapps', 'libraryfolders.vdf'); await fs.unlink(folders);
  try { await fs.symlink(target, folders, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('File symlinks unavailable'); return; } throw error; }
  await fs.symlink(target, path.join(steam, 'steamapps', 'appmanifest_1.acf'), 'file');
  const report = await inventory({ steamRoots: [steam] });
  assert.match(report.errors[0].message, /regular file.*symlink/);
  assert.equal(report.errors[0].path, folders);
  assert.equal(report.steamDiscoveryComplete, false);
  assert.equal(report.steam[0].apps.length, 0);
  assert.match(report.steam[0].errors[0].message, /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'not VDF');
});
test('Malformed and traversing manifests are reported, never accepted', async t => {
  const { steam } = await fixture(t);
  await manifest(steam, '1', '../escape'); await manifest(steam, '2', 'C:\\escape');
  await fs.writeFile(path.join(steam, 'steamapps', 'appmanifest_3.acf'), 'broken');
  await fs.writeFile(path.join(steam, 'steamapps', 'appmanifest_4.acf'), 'x'.repeat(1024 * 1024 + 1));
  const report = await inventory({ steamRoots: [steam] });
  assert.equal(report.steam[0].apps.length, 0); assert.equal(report.steam[0].complete, false);
  assert.equal(report.steam[0].errors.length, 4);
});
test('Explicit games inventory candidates separately; assets remain byte-identical', async t => {
  const { root } = await fixture(t); const game = path.join(root, 'non-steam'); await fs.mkdir(game);
  const names = ['fast_lane.ai', 'pit_lane.ai', 'track.aiw', 'track.aisplinedata', 'track.trackcontrolpoints', 'assets.kspkg', 'assets.mas', 'assets.bff', 'assets.pak', 'assets.ucas', 'assets.utoc', 'assets.erp', 'assets.rpck', 'unrelated.ai'];
  for (const name of names) await fs.writeFile(path.join(game, name), Buffer.from([0, 255, 1, 10]));
  const before = await Promise.all(names.map(name => fs.readFile(path.join(game, name))));
  const report = await inventory({ games: [{ id: 'custom', dir: game }] });
  assert.equal(report.games[0].candidates.length, 5); assert.equal(report.games[0].containers.length, 8);
  assert.equal(report.games[0].complete, true);
  assert.ok(report.games[0].candidates.every(c => c.validation === 'unvalidated candidate'));
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(path.join(game, name)))), before);
  assert.deepEqual((await fs.readdir(game)).sort(), names.sort());
});
test('Traversal and missing-root limits remain explicitly incomplete', async t => {
  const { root } = await fixture(t); const game = path.join(root, 'game');
  await fs.mkdir(path.join(game, 'nested'), { recursive: true });
  await fs.writeFile(path.join(game, 'nested', 'fast_lane.ai'), 'asset');
  const depth = await inventory({ games: [{ id: 'g', dir: game }], maxDepth: 0 });
  assert.equal(depth.games[0].complete, false); assert.match(depth.games[0].limits[0], /maxDepth/);
  const bounded = await inventory({ games: [{ id: 'g', dir: game }], maxEntries: 1 });
  assert.equal(bounded.games[0].complete, false); assert.equal(bounded.games[0].entriesVisited, 1);
  const missing = await inventory({ games: [{ id: 'g', dir: path.join(root, 'missing') }] });
  assert.equal(missing.games[0].complete, false); assert.equal(missing.games[0].errors.length, 1);
});
test('Output refuses all protected trees, aliases, existing files; publishes outside only', async t => {
  const { root, steam, external } = await fixture(t);
  const game = path.join(root, 'game'); await fs.mkdir(game);
  const report = await inventory({ steamRoots: [steam], games: [{ id: 'g', dir: game }] });
  for (const folder of [steam, external, game]) {
    await assert.rejects(writeReport(path.join(folder, 'new', '..', 'report.json'), report), /outside/);
    assert.equal((await fs.readdir(folder)).includes('report.json'), false);
  }
  const output = path.join(root, 'reports', 'report.json'); await writeReport(output, report);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), report);
  await assert.rejects(writeReport(output, report), /EEXIST/);
  const alias = path.join(root, 'alias');
  try { await fs.symlink(game, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic('Symlinks unavailable'); return; } throw error; }
  await assert.rejects(writeReport(path.join(alias, 'sub', 'report.json'), report), /outside/);
  const linked = await inventory({ games: [{ id: 'alias', dir: alias }] });
  assert.equal(linked.games[0].complete, false);
  const childAlias = path.join(game, 'link'); await fs.symlink(external, childAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const outsideAlias = path.join(game, 'outside'); await fs.symlink(path.dirname(output), outsideAlias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeReport(path.join(outsideAlias, 'escaped-report.json'), report), /outside/);
  const scanned = await inventory({ games: [{ id: 'g', dir: game }] });
  assert.equal(scanned.games[0].complete, false); assert.match(scanned.games[0].limits[0], /symlink/);
});
