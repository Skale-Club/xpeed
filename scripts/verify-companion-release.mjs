// Xpeed Companion's public release endpoints (api/companion/*) against a fake upstream that plays the part of the
// rolling GitHub release: valid shape, the 5-minute cache, upstream down with and without a kept value, a malformed
// latest.json, and a download redirect that can only ever point inside the configured release base.
// Needs nothing installed beyond the repo's dependencies (no database).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { edgeFunctions } from './esbuild-edge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-companion-release-'));

Object.assign(process.env, {
  DATA_BACKEND: 'own', PUBLIC_APP_URL: 'https://xpeed.test', STORAGE_DIR: temp, STORAGE_SECRET: 'test-secret',
  FIREBASE_PROJECT_ID: 'skaleclub', VITE_SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-placeholder',
});
delete process.env.COMPANION_RELEASE_CACHE_MS;

await build({
  entryPoints: { latest: 'api/companion/latest.ts', download: 'api/companion/download.ts', release: 'api/companion/_release.ts', webserver: 'server/index.ts' },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error', plugins: [edgeFunctions],
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const latest = (await load('latest.mjs')).default;
const download = (await load('download.mjs')).default;
const { forgetCompanionRelease, parseManifest, releaseBase, installerUrl, DEFAULT_RELEASE_BASE } = await load('release.mjs');
const { createXpeedServer } = await load('webserver.mjs');

const checks = [];
const check = async (name, test) => { forgetCompanionRelease(); delete process.env.COMPANION_RELEASE_CACHE_MS; await test(); checks.push(name); };

// ---- The fake upstream: GET <base>/latest.json, answered however the test says. Like GitHub, the first hop is a redirect.
const good = {
  version: '0.5.0', build: 'abc1234', file: 'xpeed-companion-setup-0.5.0.exe', sha256: 'a'.repeat(64), size: 3145728,
  releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.4.0', notes: '',
};
let upstream = { status: 200, body: JSON.stringify(good), delay: 0, drop: false };
let hits = 0;
const fake = createServer((req, res) => {
  if (req.url === '/release/latest.json') {
    hits += 1;
    res.writeHead(302, { Location: '/store/latest.json' }).end();
    return;
  }
  if (req.url === '/store/latest.json') {
    if (upstream.drop) { req.socket.destroy(); return; }
    setTimeout(() => res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(upstream.body), upstream.delay);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((done) => fake.listen(0, '127.0.0.1', done));
const BASE = `http://127.0.0.1:${fake.address().port}/release`;
process.env.COMPANION_RELEASE_BASE = BASE;
const serve = (body, status = 200) => { upstream = { status, body: typeof body === 'string' ? body : JSON.stringify(body), delay: 0, drop: false }; };
const call = (handler, path = '/api/companion/latest', init = {}) => handler(new Request(`https://xpeed.test${path}`, init));
const json = async (response) => JSON.parse(await response.text());

let web;
try {
  await check('answers the exact shape, with a download link on its own stable path', async () => {
    serve({ ...good });
    const response = await call(latest);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await json(response), {
      version: '0.5.0', build: 'abc1234', downloadUrl: 'https://xpeed.test/api/companion/download', sha256: 'a'.repeat(64),
      size: 3145728, releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.4.0', signed: false,
    });
  });

  await check('signed is true only when latest.json says so', async () => {
    serve({ ...good, signed: true });
    assert.equal((await json(await call(latest))).signed, true);
    forgetCompanionRelease();
    serve({ ...good, signed: 'yes' });
    assert.equal((await call(latest)).status, 503, 'a non-boolean signed field is a malformed file');
  });

  await check('keeps the answer for five minutes: a second and a third request do not reach the upstream', async () => {
    serve({ ...good });
    hits = 0;
    await call(latest);
    await call(latest);
    await call(download, '/api/companion/download');
    assert.equal(hits, 1);
  });

  await check('many requests at once share one upstream request', async () => {
    serve({ ...good });
    upstream.delay = 60;
    hits = 0;
    const answers = await Promise.all(Array.from({ length: 8 }, () => call(latest)));
    assert.ok(answers.every((answer) => answer.status === 200));
    assert.equal(hits, 1);
  });

  await check('reads the upstream again once the kept answer is old, and shows the new version', async () => {
    process.env.COMPANION_RELEASE_CACHE_MS = '40';
    serve({ ...good });
    hits = 0;
    assert.equal((await json(await call(latest))).version, '0.5.0');
    serve({ ...good, version: '0.5.1', file: 'xpeed-companion-setup-0.5.1.exe' });
    assert.equal((await json(await call(latest))).version, '0.5.0', 'still within the kept time');
    await new Promise((done) => setTimeout(done, 80));
    assert.equal((await json(await call(latest))).version, '0.5.1');
    assert.equal(hits, 2);
  });

  await check('upstream down with a kept value: the last good value is served, even when it is old', async () => {
    process.env.COMPANION_RELEASE_CACHE_MS = '30';
    serve({ ...good });
    assert.equal((await call(latest)).status, 200);
    await new Promise((done) => setTimeout(done, 60));
    for (const failure of [() => serve('oops', 500), () => serve('', 404), () => { upstream = { ...upstream, drop: true }; }]) {
      failure();
      const response = await call(latest);
      assert.equal(response.status, 200);
      assert.equal((await json(response)).version, '0.5.0');
      const target = await call(download, '/api/companion/download');
      assert.equal(target.status, 302, 'the download keeps working from the last good value too');
    }
  });

  await check('upstream down with nothing kept: 503 unavailable, retryable, with Retry-After', async () => {
    for (const failure of [() => serve('oops', 500), () => serve('', 404), () => { upstream = { ...upstream, drop: true }; }]) {
      forgetCompanionRelease();
      failure();
      for (const [handler, path] of [[latest, '/api/companion/latest'], [download, '/api/companion/download']]) {
        const response = await call(handler, path);
        assert.equal(response.status, 503, path);
        assert.deepEqual(await json(response), { error: 'unavailable', retryable: true });
        assert.ok(Number(response.headers.get('retry-after')) > 0, 'Retry-After says when to come back');
        assert.equal(response.headers.get('location'), null);
      }
    }
    // Nothing listens at all: the same answer, not a crash.
    forgetCompanionRelease();
    const dead = createServer();
    await new Promise((done) => dead.listen(0, '127.0.0.1', done));
    const port = dead.address().port;
    await new Promise((done) => dead.close(done));
    process.env.COMPANION_RELEASE_BASE = `http://127.0.0.1:${port}/release`;
    try { assert.equal((await call(latest)).status, 503); } finally { process.env.COMPANION_RELEASE_BASE = BASE; }
  });

  await check('a failure is not kept: the next request after the upstream comes back succeeds', async () => {
    serve('oops', 500);
    assert.equal((await call(latest)).status, 503);
    serve({ ...good });
    assert.equal((await call(latest)).status, 200);
  });

  const malformed = {
    'not JSON': 'this is not json',
    'an array': JSON.stringify([good]),
    'null': 'null',
    'no version': { ...good, version: undefined },
    'version with letters': { ...good, version: '0.5.x' },
    'version with a v': { ...good, version: 'v0.5.0' },
    'bad minVersion': { ...good, minVersion: 'old' },
    'no file': { ...good, file: undefined },
    'file with a slash': { ...good, file: 'dir/setup.exe' },
    'file that climbs out': { ...good, file: '../../evil/setup.exe' },
    'file that is a whole address': { ...good, file: 'https://evil.example/setup.exe' },
    'file that is a protocol-relative address': { ...good, file: '//evil.example/setup.exe' },
    'file with an encoded slash': { ...good, file: '%2e%2e%2fsetup.exe' },
    'file with a query': { ...good, file: 'setup.exe?x=1' },
    'file with a backslash': { ...good, file: 'a\\setup.exe' },
    'file that is not an exe': { ...good, file: 'setup.zip' },
    'sha256 too short': { ...good, sha256: 'abc' },
    'sha256 in capitals': { ...good, sha256: 'A'.repeat(64) },
    'sha256 not hex': { ...good, sha256: 'z'.repeat(64) },
    'size as text': { ...good, size: '3145728' },
    'size zero': { ...good, size: 0 },
    'size negative': { ...good, size: -5 },
    'size fractional': { ...good, size: 1.5 },
    'size absurd': { ...good, size: 5e12 },
    'releasedAt not a date': { ...good, releasedAt: 'yesterday' },
    'releasedAt without a zone': { ...good, releasedAt: '2026-11-13 12:00:00' },
    'build not a hash': { ...good, build: 'main' },
    'notes not text': { ...good, notes: 5 },
    'huge': JSON.stringify({ ...good, notes: 'x'.repeat(40000) }),
  };
  await check(`rejects a malformed latest.json (${Object.keys(malformed).length} kinds): 503, never a redirect`, async () => {
    for (const [name, body] of Object.entries(malformed)) {
      forgetCompanionRelease();
      serve(body);
      const info = await call(latest);
      assert.equal(info.status, 503, `latest: ${name}`);
      const target = await call(download, '/api/companion/download');
      assert.equal(target.status, 503, `download: ${name}`);
      assert.equal(target.headers.get('location'), null, `download: ${name}`);
    }
  });

  await check('a malformed latest.json does not replace a good kept one', async () => {
    process.env.COMPANION_RELEASE_CACHE_MS = '30';
    serve({ ...good });
    assert.equal((await call(latest)).status, 200);
    await new Promise((done) => setTimeout(done, 60));
    serve({ ...good, file: 'https://evil.example/setup.exe' });
    const response = await call(download, '/api/companion/download');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${BASE}/${good.file}`);
  });

  await check('the redirect target is <base>/<file from latest.json>, public for five minutes', async () => {
    serve({ ...good });
    const response = await call(download, '/api/companion/download');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `${BASE}/xpeed-companion-setup-0.5.0.exe`);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    forgetCompanionRelease();
    serve({ ...good, version: '0.6.0', file: 'xpeed-companion-0.6.0-x64.exe' });
    assert.equal((await call(download, '/api/companion/download')).headers.get('location'), `${BASE}/xpeed-companion-0.6.0-x64.exe`, 'a new file name needs no change here');
  });

  await check('the redirect cannot leave the release base, whatever the file says or the environment sets', async () => {
    const manifest = parseManifest(JSON.stringify(good));
    assert.equal(installerUrl('https://github.com/o/r/releases/download/t', manifest), 'https://github.com/o/r/releases/download/t/xpeed-companion-setup-0.5.0.exe');
    for (const file of ['..', 'x/../../y.exe', '//evil.example/a.exe']) {
      assert.equal(parseManifest(JSON.stringify({ ...good, file })), null, file);
    }
    // A forged manifest object (never produced by parseManifest) is still refused by the address check.
    assert.equal(installerUrl('https://github.com/o/r/releases/download/t', { ...manifest, file: '//evil.example/a.exe' }), null);
    assert.equal(installerUrl('https://github.com/o/r/releases/download/t', { ...manifest, file: '../../../evil.exe' }), null);
    // The base itself: https only (http just for a local test server), no credentials, no query; otherwise the built-in default.
    const original = process.env.COMPANION_RELEASE_BASE;
    try {
      for (const bad of ['http://evil.example/x', 'ftp://example.com/x', 'javascript:alert(1)', 'https://user:pass@example.com/x', 'https://example.com/x?a=1', 'not a url']) {
        process.env.COMPANION_RELEASE_BASE = bad;
        assert.equal(releaseBase(), DEFAULT_RELEASE_BASE, bad);
      }
      process.env.COMPANION_RELEASE_BASE = 'https://downloads.example.org/companion/';
      assert.equal(releaseBase(), 'https://downloads.example.org/companion');
      delete process.env.COMPANION_RELEASE_BASE;
      assert.equal(releaseBase(), 'https://github.com/Skale-Club/xpeed/releases/download/companion-latest');
    } finally { process.env.COMPANION_RELEASE_BASE = original; }
  });

  await check('through the real server: both routes are public, the public address is the configured one, Host is ignored, other methods are refused', async () => {
    serve({ ...good });
    web = createXpeedServer({ staticRoot: temp, origin: 'https://xpeed.test' });
    await new Promise((done) => web.listen(0, '127.0.0.1', done));
    const port = web.address().port;
    const get = (path, { method = 'GET', headers = {} } = {}) => new Promise((done, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
        const parts = [];
        res.on('data', (part) => parts.push(part));
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
      });
      req.on('error', fail);
      req.end();
    });
    const info = await get('/api/companion/latest', { headers: { host: 'evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' } });
    assert.equal(info.status, 200);
    assert.equal(JSON.parse(info.text).downloadUrl, 'https://xpeed.test/api/companion/download');
    assert.equal(info.headers['access-control-allow-origin'], '*');
    const target = await get('/api/companion/download/', { headers: { host: 'evil.example' } });
    assert.equal(target.status, 302);
    assert.equal(target.headers.location, `${BASE}/${good.file}`);
    assert.equal(target.headers['cache-control'], 'public, max-age=300');
    for (const method of ['POST', 'DELETE', 'PUT']) {
      const refused = await get('/api/companion/latest', { method });
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.allow, 'GET, HEAD');
    }
    assert.equal((await get('/api/companion/latest', { method: 'HEAD' })).status, 200);
  });

  console.log(`${checks.length} companion release checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  await new Promise((done) => (web ? (web.closeAllConnections?.(), web.close(done)) : done())).catch(() => {});
  fake.closeAllConnections?.();
  await new Promise((done) => fake.close(done));
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
