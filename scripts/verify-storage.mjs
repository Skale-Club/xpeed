// File storage: the S3-compatible driver against an in-process fake S3 server that checks AWS Signature V4 on its own,
// the contract both drivers (disk and S3) must keep, the copy script, and lap retention (reduce old laps to 10 Hz).
// Nothing here touches a real storage account or a real database: temp folders, a fake S3 on a loopback port and an
// in-memory PostgreSQL (PGlite, installed by the CI step "Install isolated SQL test runtime").
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');

mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-storage-'));

await build({
  entryPoints: {
    files: 'server/files.ts', s3: 'server/s3.ts', driver: 'server/storage-driver.ts', retention: 'server/retention.ts',
    jobs: 'server/jobs.ts', health: 'server/health.ts', lapfile: 'src/lib/sim/lap-file.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error',
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const { DiskStore, FileError, BUCKETS } = await load('files.mjs');
const { S3Store, signV4, s3Url, EMPTY_SHA256 } = await load('s3.mjs');
const { createStore, storageConfigured, storageDriver, s3ConfigFromEnv, assertStorageEnv } = await load('driver.mjs');
const retention = await load('retention.mjs');
const { enabledJobs, scheduleDaily } = await load('jobs.mjs');
const { deepHealth, forgetDeepHealth } = await load('health.mjs');
const { gzipLap, gunzipLap } = await load('lapfile.mjs');

const checks = [];
const check = async (name, test) => { await test(); checks.push(name); };
const sha = (data) => createHash('sha256').update(data).digest('hex');
const bytesOf = (text) => new TextEncoder().encode(text);
const same = (a, b) => a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b));

// ======================================================================= a fake S3 that verifies Signature V4 itself
// Written separately from server/s3.ts on purpose: it recomputes the signature from what actually arrived on the wire.
const rfc = (text) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function startFakeS3({ accessKey = 'AKIAFAKEKEYFORTESTS', secret = 'fake/secret+key/for-tests', region = 'auto', bucket = 'xpeed-test', pageSize = 1000, honourIfNoneMatch = true } = {}) {
  const objects = new Map(); // key -> { data, type, modified }
  const seen = []; // { method, path, query, ok, reason }
  const failures = []; // statuses to answer (before any checking) for the next requests
  const wrong = (req, body) => {
    const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '');
    if (!auth) return 'no or malformed Authorization';
    const [, key, day, scopeRegion, signedList, signature] = auth;
    if (key !== accessKey) return 'InvalidAccessKeyId';
    if (scopeRegion !== region) return 'wrong region in the scope';
    const amzDate = req.headers['x-amz-date'] ?? '';
    if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(day)) return 'bad x-amz-date';
    const when = Date.UTC(+amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8), +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15));
    if (Math.abs(Date.now() - when) > 15 * 60_000) return 'RequestTimeTooSkewed';
    // The declared payload hash must be the hash of the bytes that came in, or a body could be swapped under a good signature.
    const declared = req.headers['x-amz-content-sha256'];
    if (declared !== sha(body)) return 'XAmzContentSHA256Mismatch';
    const signedNames = signedList.split(';');
    for (const must of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!signedNames.includes(must)) return `${must} not signed`;
    if (signedNames.join(';') !== [...signedNames].sort().join(';')) return 'signed headers not sorted';
    const [rawPath, rawQuery = ''] = req.url.split('?');
    // The path must be what S3 itself would produce from the decoded key: one level of RFC 3986 encoding.
    const canonicalPath = rawPath.split('/').map((s) => rfc(decodeURIComponent(s))).join('/');
    if (canonicalPath !== rawPath) return 'path not RFC 3986 encoded';
    const query = rawQuery ? rawQuery.split('&').map((pair) => { const i = pair.indexOf('='); return [decodeURIComponent(pair.slice(0, i)), decodeURIComponent(pair.slice(i + 1))]; }) : [];
    const canonicalQuery = query.map(([k, v]) => [rfc(k), rfc(v)]).sort((a, b) => (a[0] + '=' + a[1] < b[0] + '=' + b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    if (rawQuery && !rawQuery.split('&').every((p) => /^[A-Za-z0-9%._~-]+=[A-Za-z0-9%._~-]*$/.test(p))) return 'query not RFC 3986 encoded';
    const canonicalHeaders = signedNames.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const canonicalRequest = [req.method, canonicalPath, canonicalQuery, canonicalHeaders, signedList, declared].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, `${day}/${region}/s3/aws4_request`, sha(canonicalRequest)].join('\n');
    let k = createHmac('sha256', 'AWS4' + secret).update(day).digest();
    for (const part of [region, 's3', 'aws4_request']) k = createHmac('sha256', k).update(part).digest();
    const expected = createHmac('sha256', k).update(toSign).digest();
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected) ? null : 'SignatureDoesNotMatch';
  };
  const xml = (code) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const listEncode = (t) => encodeURIComponent(t).replace(/%20/g, '+').replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const [rawPath, rawQuery = ''] = req.url.split('?');
    const entry = { method: req.method, path: rawPath, query: rawQuery, ok: false, reason: '' };
    seen.push(entry);
    const send = (status, data = '', headers = {}) => {
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : data);
    };
    // An injected failure is a status for any request, or { status, method } for one kind of request.
    const at = failures.findIndex((f) => typeof f === 'number' || f.method === req.method);
    if (at >= 0) { const [failure] = failures.splice(at, 1); const status = typeof failure === 'number' ? failure : failure.status; entry.reason = `injected ${status}`; return send(status, xml('SlowDown')); }
    const problem = wrong(req, body);
    if (problem) { entry.reason = problem; return send(403, xml(problem === 'SignatureDoesNotMatch' ? problem : 'AccessDenied'), { 'content-type': 'application/xml' }); }
    entry.ok = true;
    const parts = rawPath.split('/').map(decodeURIComponent);
    if (parts[1] !== bucket) return send(404, xml('NoSuchBucket'), { 'content-type': 'application/xml' });
    const key = parts.slice(2).join('/');
    const params = new URLSearchParams(rawQuery);

    if (req.method === 'GET' && params.get('list-type') === '2') {
      const prefix = params.get('prefix') ?? '', delimiter = params.get('delimiter');
      const max = Math.min(Number(params.get('max-keys') ?? 1000), pageSize);
      const names = [...objects.keys()].filter((n) => n.startsWith(prefix)).sort();
      const entries = []; // files and folders in one ordered list, so pages cut across both
      const folders = new Set();
      for (const name of names) {
        const rest = name.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if (cut >= 0) { const folder = prefix + rest.slice(0, cut + 1); if (!folders.has(folder)) { folders.add(folder); entries.push({ folder }); } } else entries.push({ name });
      }
      const after = params.get('continuation-token') ? Number(Buffer.from(params.get('continuation-token'), 'base64url').toString()) : 0;
      const page = entries.slice(after, after + max), more = after + max < entries.length;
      const encode = params.get('encoding-type') === 'url' ? listEncode : esc;
      const contents = page.filter((e) => e.name !== undefined).map((e) => `<Contents><Key>${encode(e.name)}</Key><LastModified>${objects.get(e.name).modified.toISOString()}</LastModified><Size>${objects.get(e.name).data.length}</Size></Contents>`).join('');
      const common = page.filter((e) => e.folder !== undefined).map((e) => `<CommonPrefixes><Prefix>${encode(e.folder)}</Prefix></CommonPrefixes>`).join('');
      return send(200, `<?xml version="1.0"?><ListBucketResult><Name>${bucket}</Name><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${Buffer.from(String(after + max)).toString('base64url')}</NextContinuationToken>` : ''}${contents}${common}</ListBucketResult>`, { 'content-type': 'application/xml' });
    }
    if (req.method === 'PUT') {
      if (honourIfNoneMatch && req.headers['if-none-match'] === '*' && objects.has(key)) return send(412, xml('PreconditionFailed'), { 'content-type': 'application/xml' });
      objects.set(key, { data: body, type: req.headers['content-type'] ?? '', modified: new Date() });
      return send(200, '', { etag: `"${sha(body).slice(0, 32)}"` });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const found = objects.get(key);
      if (!found) return send(404, xml('NoSuchKey'), { 'content-type': 'application/xml' });
      return send(200, found.data, { 'content-type': found.type, 'content-length': String(found.data.length), 'last-modified': found.modified.toUTCString() });
    }
    if (req.method === 'DELETE') { objects.delete(key); return send(204); }
    return send(405, xml('MethodNotAllowed'));
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done({
    endpoint: `http://127.0.0.1:${server.address().port}`, accessKey, secret, region, bucket, objects, seen, failures,
    config: { endpoint: `http://127.0.0.1:${server.address().port}`, region, bucket, accessKeyId: accessKey, secretAccessKey: secret, forcePathStyle: true },
    env: { STORAGE_DRIVER: 's3', S3_ENDPOINT: `http://127.0.0.1:${server.address().port}`, S3_REGION: region, S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKey, S3_SECRET_ACCESS_KEY: secret, S3_FORCE_PATH_STYLE: 'true' },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  })));
}

const fake = await startFakeS3({ pageSize: 4 });
const newS3 = (overrides = {}, options = {}) => new S3Store({ ...fake.config, ...overrides }, { retryDelayMs: 1, ...options });
const sandbox = mkdtempSync(join(temp, 'disk-'));
let diskCount = 0;
const newDisk = () => new DiskStore(join(sandbox, `d${diskCount++}`));

try {
  // ===================================================================== Signature V4
  await check('SigV4 signing matches the examples published in the AWS documentation (GET with a Range header, PUT with a $ in the name)', async () => {
    const credentials = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z') };
    const got = signV4({ ...credentials, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 });
    assert.equal(got.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    const put = signV4({
      ...credentials, method: 'PUT', url: new URL('https://examplebucket.s3.amazonaws.com/test%24file.text'),
      headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: sha('Welcome to Amazon S3.'),
    });
    assert.equal(put.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  await check('S3Store: put, get, head, delete and a missing key, every request accepted by an independent SigV4 verifier', async () => {
    const store = newS3();
    const before = fake.seen.length;
    await store.put('sim-laps', 'user-1/lap.xlap.gz', bytesOf('hello'), { upsert: false });
    assert.ok(same(await store.get('sim-laps', 'user-1/lap.xlap.gz'), bytesOf('hello')));
    assert.deepEqual(await store.head('sim-laps', 'user-1/lap.xlap.gz'), { size: 5 });
    assert.ok(fake.objects.has('sim-laps/user-1/lap.xlap.gz'), 'the app bucket is a key prefix inside the one S3 bucket');
    assert.equal(fake.objects.get('sim-laps/user-1/lap.xlap.gz').type, 'application/gzip', 'a lap file is stored with the bucket\'s type');
    await store.remove('sim-laps', ['user-1/lap.xlap.gz']);
    assert.equal(await store.get('sim-laps', 'user-1/lap.xlap.gz'), null);
    assert.equal(await store.head('sim-laps', 'user-1/lap.xlap.gz'), null);
    const mine = fake.seen.slice(before);
    assert.ok(mine.length >= 6 && mine.every((r) => r.ok || r.reason === ''), JSON.stringify(mine.filter((r) => !r.ok)));
    assert.ok(['PUT', 'GET', 'HEAD', 'DELETE'].every((m) => mine.some((r) => r.method === m)), 'all four verbs were exercised');
  });

  await check('S3Store: a large object (12 MB) goes in and comes back byte for byte', async () => {
    const store = newS3();
    const big = new Uint8Array(randomBytes(12 * 1024 * 1024));
    await store.put('sim-tracks', 'user-1/big.xtrack.gz', big, { upsert: true });
    assert.deepEqual(await store.head('sim-tracks', 'user-1/big.xtrack.gz'), { size: big.length });
    assert.equal(sha(await store.get('sim-tracks', 'user-1/big.xtrack.gz')), sha(big));
    await store.remove('sim-tracks', ['user-1/big.xtrack.gz']);
  });

  await check('S3Store: a wrong secret key is rejected by the fake (SignatureDoesNotMatch), the store reports a plain error and never prints a key', async () => {
    const bad = newS3({ secretAccessKey: 'not-the-secret' }, { retries: 0 });
    const before = fake.seen.length;
    await assert.rejects(bad.put('sim-laps', 'a/b.xlap.gz', bytesOf('x'), { upsert: true }), (error) => {
      assert.ok(!(error instanceof FileError), 'an auth failure is not a client error of the person who uploaded');
      assert.match(error.message, /^S3 (PUT|HEAD) failed: 403 SignatureDoesNotMatch$/);
      assert.ok(!error.message.includes('a/b') && !error.message.includes('not-the-secret'));
      return true;
    });
    assert.ok(fake.seen.slice(before).some((r) => r.reason === 'SignatureDoesNotMatch'));
    assert.equal(fake.objects.has('sim-laps/a/b.xlap.gz'), false);
    const wrongId = newS3({ accessKeyId: 'AKIAWRONG' }, { retries: 0 });
    await assert.rejects(wrongId.get('sim-laps', 'a/b.xlap.gz'), /403/);
    assert.equal(await newS3({ secretAccessKey: 'not-the-secret' }).probe(), false);
  });

  await check('the fake verifier is not a rubber stamp: a valid signature moved to another path, or over another body, is refused', async () => {
    const sign = (method, path, body = new Uint8Array(0), query = '') => signV4({ method, url: new URL(`${fake.endpoint}${path}${query}`), payloadHash: sha(body), ...{ accessKeyId: fake.accessKey, secretAccessKey: fake.secret, region: fake.region } });
    const good = sign('GET', `/${fake.bucket}/sim-laps/x/one`);
    assert.equal((await fetch(`${fake.endpoint}/${fake.bucket}/sim-laps/x/one`, { headers: good })).status, 404, 'the right path is accepted (the object is just not there)');
    assert.equal((await fetch(`${fake.endpoint}/${fake.bucket}/sim-laps/x/two`, { headers: good })).status, 403, 'same signature, another key');
    const put = sign('PUT', `/${fake.bucket}/sim-laps/x/body`, bytesOf('original'));
    assert.equal((await fetch(`${fake.endpoint}/${fake.bucket}/sim-laps/x/body`, { method: 'PUT', headers: put, body: bytesOf('swapped!') })).status, 403, 'same signature, another body');
    assert.equal((await fetch(`${fake.endpoint}/${fake.bucket}/sim-laps/x/body`, { method: 'DELETE', headers: put })).status, 403, 'same signature, another method');
    const old = signV4({ method: 'GET', url: new URL(`${fake.endpoint}/${fake.bucket}/sim-laps/x/one`), payloadHash: EMPTY_SHA256, accessKeyId: fake.accessKey, secretAccessKey: fake.secret, region: fake.region, date: new Date(Date.now() - 3600_000) });
    assert.equal((await fetch(`${fake.endpoint}/${fake.bucket}/sim-laps/x/one`, { headers: old })).status, 403, 'a request signed an hour ago');
  });

  await check('S3Store: keys with spaces, accents and reserved characters are signed and listed correctly', async () => {
    const store = newS3();
    const odd = ["a b/ü ñ.jpg", "x/!'()*~.csv", 'p/a&b=c+d%e.json', 'p/semi;colon,comma@at$dollar.png'];
    for (const path of odd) {
      await store.put('session-photos', path, bytesOf(path), { upsert: true });
      assert.ok(same(await store.get('session-photos', path), bytesOf(path)), path);
    }
    const found = [];
    for await (const object of store.listAll('session-photos')) found.push(object.path);
    assert.deepEqual(found.sort(), [...odd].sort());
    await store.remove('session-photos', odd);
  });

  await check('S3Store: retries a 503 and succeeds, gives up after the retries, and does not retry what is not safe to repeat', async () => {
    const store = newS3();
    await store.put('sim-laps', 'r/one.xlap.gz', bytesOf('1'), { upsert: true });
    fake.failures.push(503, 503);
    assert.ok(same(await store.get('sim-laps', 'r/one.xlap.gz'), bytesOf('1')), 'two 503s, then the answer');
    fake.failures.push(503, 503, 503);
    await assert.rejects(store.get('sim-laps', 'r/one.xlap.gz'), /S3 GET failed: 503/);
    fake.failures.length = 0;
    // A conditional put is sent once: a retry after a lost answer would report "already exists" for our own object.
    fake.failures.push({ status: 503, method: 'PUT' });
    await assert.rejects(store.put('sim-laps', 'r/two.xlap.gz', bytesOf('2'), { upsert: false }), /S3 PUT failed: 503/);
    await store.remove('sim-laps', ['r/one.xlap.gz', 'r/two.xlap.gz']);
  });

  await check('S3Store: upsert false refuses an existing object, with a provider that enforces If-None-Match and with one that ignores it', async () => {
    const store = newS3();
    await store.put('sim-laps', 'u/x.xlap.gz', bytesOf('first'), { upsert: false });
    await assert.rejects(store.put('sim-laps', 'u/x.xlap.gz', bytesOf('second'), { upsert: false }), (error) => error instanceof FileError && error.status === 409 && error.code === 'already_exists');
    assert.ok(same(await store.get('sim-laps', 'u/x.xlap.gz'), bytesOf('first')));
    const lax = await startFakeS3({ honourIfNoneMatch: false });
    try {
      const store2 = new S3Store(lax.config, { retryDelayMs: 1 });
      await store2.put('sim-laps', 'u/x.xlap.gz', bytesOf('first'), { upsert: false });
      await assert.rejects(store2.put('sim-laps', 'u/x.xlap.gz', bytesOf('second'), { upsert: false }), (error) => error instanceof FileError && error.status === 409);
      assert.ok(same(await store2.get('sim-laps', 'u/x.xlap.gz'), bytesOf('first')), 'still the first');
    } finally { await lax.close(); }
    await store.remove('sim-laps', ['u/x.xlap.gz']);
  });

  await check('S3Store: listing pages through many objects (the fake answers 4 per page): folders and files, limit, offset, search and listAll', async () => {
    const store = newS3();
    const names = [];
    for (let i = 0; i < 11; i++) names.push(`owner/lap-${String(i).padStart(2, '0')}.xlap.gz`);
    for (let i = 0; i < 3; i++) names.push(`owner/season ${i}/lap.xlap.gz`);
    names.push('other/a.xlap.gz');
    for (const name of names) await store.put('sim-laps', name, bytesOf(name), { upsert: true });
    await store.put('sim-laps', 'owner/.hidden', bytesOf('h'), { upsert: true });
    const children = await store.list('sim-laps', 'owner', { limit: 100 });
    assert.equal(children.length, 14, 'eleven files and three folders, the hidden name left out');
    assert.deepEqual(children.slice(0, 2).map((c) => [c.name, c.folder]), [['lap-00.xlap.gz', false], ['lap-01.xlap.gz', false]]);
    assert.deepEqual(children.filter((c) => c.folder).map((c) => c.name), ['season 0', 'season 1', 'season 2']);
    assert.equal(children.find((c) => c.name === 'lap-03.xlap.gz').size, 'owner/lap-03.xlap.gz'.length);
    assert.deepEqual((await store.list('sim-laps', 'owner', { limit: 3, offset: 2 })).map((c) => c.name), ['lap-02.xlap.gz', 'lap-03.xlap.gz', 'lap-04.xlap.gz']);
    assert.deepEqual((await store.list('sim-laps', 'owner', { search: 'season' })).map((c) => c.name), ['season 0', 'season 1', 'season 2']);
    assert.deepEqual(await store.list('sim-laps', 'nobody'), []);
    const all = [];
    for await (const object of store.listAll('sim-laps', 'owner')) all.push(object.path);
    assert.equal(all.length, 14 - 3 + 3, 'every object below owner/, at any depth');
    assert.ok(all.every((p) => p.startsWith('owner/') && !p.includes('.hidden')));
    await store.remove('sim-laps', [...names, 'owner/.hidden']);
  });

  await check('S3Store: virtual hosted style puts the bucket in the host name and still signs it; path style keeps it in the path', async () => {
    const config = { endpoint: 'https://s3.example-region.example.com', bucket: 'my-bucket' };
    assert.equal(s3Url({ ...config, forcePathStyle: true }, 'sim-laps/u/a b.xlap.gz').href, 'https://s3.example-region.example.com/my-bucket/sim-laps/u/a%20b.xlap.gz');
    assert.equal(s3Url({ ...config, forcePathStyle: false }, 'sim-laps/u/a b.xlap.gz').href, 'https://my-bucket.s3.example-region.example.com/sim-laps/u/a%20b.xlap.gz');
    assert.equal(s3Url({ ...config, forcePathStyle: false }, '', { 'list-type': '2', prefix: 'sim-laps/' }).href, 'https://my-bucket.s3.example-region.example.com/?list-type=2&prefix=sim-laps%2F');
    const virtual = signV4({ method: 'GET', url: s3Url({ ...config, forcePathStyle: false }, 'k'), payloadHash: EMPTY_SHA256, accessKeyId: 'A', secretAccessKey: 'B', region: 'r', date: new Date() });
    const path = signV4({ method: 'GET', url: s3Url({ ...config, forcePathStyle: true }, 'k'), payloadHash: EMPTY_SHA256, accessKeyId: 'A', secretAccessKey: 'B', region: 'r', date: new Date() });
    assert.notEqual(virtual.authorization, path.authorization, 'the host is part of what is signed');
    assert.equal(virtual.host, undefined, 'host is left to fetch, which sends the one that was signed');
  });

  // ===================================================================== the contract both drivers keep
  const contract = async (label, make) => {
    await check(`contract (${label}): put, get, head, overwrite rules, missing keys, empty and binary content`, async () => {
      const store = make();
      assert.equal(await store.get('sim-laps', 'who/none.xlap.gz'), null);
      assert.equal(await store.head('sim-laps', 'who/none.xlap.gz'), null);
      await store.put('sim-laps', 'who/one.xlap.gz', bytesOf('one'), { upsert: false });
      assert.ok(same(await store.get('sim-laps', 'who/one.xlap.gz'), bytesOf('one')));
      assert.deepEqual(await store.head('sim-laps', 'who/one.xlap.gz'), { size: 3 });
      await assert.rejects(store.put('sim-laps', 'who/one.xlap.gz', bytesOf('two'), { upsert: false }), (e) => e instanceof FileError && e.status === 409 && e.code === 'already_exists');
      assert.ok(same(await store.get('sim-laps', 'who/one.xlap.gz'), bytesOf('one')), 'a refused put changes nothing');
      await store.put('sim-laps', 'who/one.xlap.gz', bytesOf('three!'), { upsert: true });
      assert.ok(same(await store.get('sim-laps', 'who/one.xlap.gz'), bytesOf('three!')));
      await store.put('sim-laps', 'who/empty.xlap.gz', new Uint8Array(0), { upsert: true });
      assert.deepEqual(await store.head('sim-laps', 'who/empty.xlap.gz'), { size: 0 });
      assert.equal((await store.get('sim-laps', 'who/empty.xlap.gz')).length, 0);
      const everyByte = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
      await store.put('sim-laps', 'who/bytes.xlap.gz', everyByte, { upsert: true });
      assert.ok(same(await store.get('sim-laps', 'who/bytes.xlap.gz'), everyByte));
      assert.equal(await store.get('sim-tracks', 'who/one.xlap.gz'), null, 'buckets are separate');
      await store.remove('sim-laps', ['who/one.xlap.gz', 'who/empty.xlap.gz', 'who/bytes.xlap.gz']);
    });

    await check(`contract (${label}): remove ignores missing objects, removes several, and leaves the rest`, async () => {
      const store = make();
      for (const p of ['a/1.xlap.gz', 'a/2.xlap.gz', 'a/3.xlap.gz']) await store.put('sim-laps', p, bytesOf(p), { upsert: true });
      await store.remove('sim-laps', ['a/9.xlap.gz']);
      await store.remove('sim-laps', ['a/1.xlap.gz', 'a/2.xlap.gz', 'a/never.xlap.gz']);
      assert.equal(await store.get('sim-laps', 'a/1.xlap.gz'), null);
      assert.equal(await store.get('sim-laps', 'a/2.xlap.gz'), null);
      assert.ok(await store.get('sim-laps', 'a/3.xlap.gz'));
      await store.remove('sim-laps', ['a/3.xlap.gz']);
      assert.deepEqual(await store.list('sim-laps', ''), [], 'folders only exist while they hold something');
    });

    await check(`contract (${label}): paths and buckets are checked, with the same error codes`, async () => {
      const store = make();
      for (const bad of ['', '../x', 'a/../b', 'a//b', '/a', 'a/', './a', 'a\\b', 'a/\u0001b', 'x'.repeat(513)]) {
        for (const call of [(p) => store.put('sim-laps', p, bytesOf('x'), { upsert: true }), (p) => store.get('sim-laps', p), (p) => store.head('sim-laps', p), (p) => store.remove('sim-laps', [p])]) {
          await assert.rejects(call(bad), (e) => e instanceof FileError && e.status === 400 && e.code === 'invalid_path', JSON.stringify(bad.slice(0, 20)));
        }
      }
      await assert.rejects(store.get('no-such-bucket', 'a/b'), (e) => e instanceof FileError && e.status === 404 && e.code === 'bucket_not_found');
      await assert.rejects(store.put('__proto__', 'a/b', bytesOf('x'), { upsert: true }), (e) => e instanceof FileError && e.code === 'bucket_not_found');
    });

    await check(`contract (${label}): list gives direct children (folders and files, name order, limit, offset, search) and listAll gives everything below, hidden names left out`, async () => {
      const store = make();
      for (const p of ['u1/b.csv', 'u1/a.csv', 'u1/sub/deep/c.csv', 'u1/sub/d.csv', 'u2/e.csv']) await store.put('session-csv', p, bytesOf(p), { upsert: true });
      const top = await store.list('session-csv', '');
      assert.deepEqual(top.map((e) => [e.name, e.folder]), [['u1', true], ['u2', true]]);
      const u1 = await store.list('session-csv', 'u1');
      assert.deepEqual(u1.map((e) => [e.name, e.folder, e.size]), [['a.csv', false, 8], ['b.csv', false, 8], ['sub', true, 0]]);
      assert.deepEqual((await store.list('session-csv', 'u1', { limit: 1, offset: 1 })).map((e) => e.name), ['b.csv']);
      assert.deepEqual((await store.list('session-csv', 'u1', { search: 'sub' })).map((e) => e.name), ['sub']);
      assert.deepEqual(await store.list('session-csv', 'missing'), []);
      assert.ok(Number.isFinite(Date.parse(u1[0].updatedAt)));
      const all = [];
      for await (const o of store.listAll('session-csv')) all.push([o.path, o.size]);
      assert.deepEqual(all, [['u1/a.csv', 8], ['u1/b.csv', 8], ['u1/sub/d.csv', 12], ['u1/sub/deep/c.csv', 17], ['u2/e.csv', 8]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
      const below = [];
      for await (const o of store.listAll('session-csv', 'u1/sub')) below.push(o.path);
      assert.deepEqual(below.sort(), ['u1/sub/d.csv', 'u1/sub/deep/c.csv']);
      await store.remove('session-csv', ['u1/b.csv', 'u1/a.csv', 'u1/sub/deep/c.csv', 'u1/sub/d.csv', 'u2/e.csv']);
    });

    await check(`contract (${label}): probe writes and deletes a tiny object and leaves nothing behind`, async () => {
      const store = make();
      assert.equal(await store.probe(), true);
      const left = [];
      for await (const o of store.listAll('sim-laps')) left.push(o.path);
      assert.deepEqual(left, []);
    });
  };
  await contract('disk', newDisk);
  // A fresh prefix per S3 contract run is not needed: every check removes what it wrote.
  await contract('s3', () => newS3());

  // ===================================================================== choosing the driver
  await check('storage driver: disk unless STORAGE_DRIVER=s3; s3 reads its settings from the environment; wrong or missing settings are named, values never printed', async () => {
    assert.equal(storageDriver({}), 'disk');
    assert.equal(storageDriver({ STORAGE_DRIVER: 'DISK' }), 'disk');
    assert.equal(storageDriver({ STORAGE_DRIVER: 's3' }), 's3');
    assert.throws(() => storageDriver({ STORAGE_DRIVER: 'ftp' }), /must be "disk" or "s3"/);
    assert.ok(createStore({ STORAGE_DIR: sandbox }) instanceof DiskStore);
    assert.ok(createStore({}) instanceof DiskStore, 'the old default folder');
    assert.ok(createStore(fake.env) instanceof S3Store);
    assert.equal(storageConfigured({}), false);
    assert.equal(storageConfigured({ STORAGE_DIR: sandbox }), true);
    assert.equal(storageConfigured({ STORAGE_DRIVER: 's3' }), false);
    assert.equal(storageConfigured(fake.env), true);
    assert.equal(storageConfigured({ STORAGE_DRIVER: 'nonsense', STORAGE_DIR: sandbox }), false, 'a typo is not "configured"');
    assert.throws(() => assertStorageEnv({ STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://x', S3_SECRET_ACCESS_KEY: 'shh-secret' }), (e) => /S3_BUCKET, S3_ACCESS_KEY_ID/.test(e.message) && !e.message.includes('shh-secret'));
    assert.throws(() => assertStorageEnv({ STORAGE_DRIVER: 'x' }));
    assert.doesNotThrow(() => assertStorageEnv({}));
    assert.doesNotThrow(() => assertStorageEnv(fake.env));
    assert.throws(() => s3ConfigFromEnv({ ...fake.env, S3_ENDPOINT: 'not a url' }), /S3_ENDPOINT must be a URL/);
    assert.throws(() => s3ConfigFromEnv({ ...fake.env, S3_FORCE_PATH_STYLE: 'maybe' }), /true or false/);
    const config = s3ConfigFromEnv({ S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com/', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' });
    assert.deepEqual(config, { endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true });
    assert.equal(s3ConfigFromEnv({ ...fake.env, S3_FORCE_PATH_STYLE: 'false' }).forcePathStyle, false);
  });

  await check('/api/health/deep checks the storage through the interface: ok with the S3 driver, down with a wrong secret or an unreachable endpoint, off when unconfigured', async () => {
    forgetDeepHealth();
    const fine = await deepHealth({ ...fake.env }, Date.now());
    assert.deepEqual([fine.storage, fine.database], ['ok', 'off']);
    assert.equal(fake.seen.filter((r) => r.path.includes('/.probe/') && r.method === 'DELETE' && r.ok).length > 0, true, 'the probe object was written and deleted');
    assert.equal([...fake.objects.keys()].some((k) => k.startsWith('.probe/')), false);
    forgetDeepHealth();
    assert.equal((await deepHealth({ ...fake.env, S3_SECRET_ACCESS_KEY: 'wrong' }, Date.now())).storage, 'down');
    forgetDeepHealth();
    assert.equal((await deepHealth({ ...fake.env, S3_ENDPOINT: 'http://127.0.0.1:1' }, Date.now())).storage, 'down');
    forgetDeepHealth();
    assert.equal((await deepHealth({ STORAGE_DRIVER: 's3' }, Date.now())).storage, 'off');
    forgetDeepHealth();
    assert.equal((await deepHealth({ STORAGE_DIR: join(sandbox, 'health') }, Date.now())).storage, 'ok', 'the disk is unchanged');
    forgetDeepHealth();
  });

  // ===================================================================== the copy script
  const run = (args, extraEnv = {}) => new Promise((done) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(SRC_|DST_)?(STORAGE_|S3_)/.test(key) || key === 'XPEED_PROD_HOSTS') delete env[key];
    execFile(process.execPath, [resolve(root, 'scripts/storage-copy.mjs'), ...args], { cwd: root, env: { ...env, ...extraEnv }, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
  const listDisk = (dir) => {
    const found = [];
    const walk = (d, rel) => { if (!existsSync(d)) return; for (const name of readdirSync(d).sort()) { const full = join(d, name); if (statSync(full).isDirectory()) walk(full, rel ? `${rel}/${name}` : name); else found.push(`${rel ? rel + '/' : ''}${name}:${sha(readFileSync(full)).slice(0, 12)}`); } };
    walk(dir, '');
    return found;
  };
  const s3Snapshot = () => [...fake.objects.entries()].map(([k, v]) => `${k}:${sha(v.data).slice(0, 12)}`).sort();
  const seedSource = () => {
    const dir = mkdtempSync(join(sandbox, 'src-'));
    const disk = new DiskStore(dir);
    return { dir, disk };
  };
  const clearFake = () => { fake.objects.clear(); };
  const flush = async (disk) => {
    await disk.put('sim-laps', 'u1/a.xlap.gz', bytesOf('lap a'), { upsert: true });
    await disk.put('sim-laps', 'u1/b.xlap.gz', new Uint8Array(randomBytes(70_000)), { upsert: true });
    await disk.put('session-photos', 'u2/photo one.jpg', new Uint8Array(randomBytes(5000)), { upsert: true });
    await disk.put('car-photos', 'u2/car.png', bytesOf('png'), { upsert: true });
  };
  const copyEnv = () => ({ ...fake.env });
  const dstEnv = () => Object.fromEntries(Object.entries(fake.env).map(([k, v]) => [`DST_${k}`, v]));

  await check('storage-copy dry run (the default) changes nothing on either side and says what it would copy', async () => {
    clearFake();
    const { dir, disk } = seedSource();
    await flush(disk);
    const before = listDisk(dir);
    const start = fake.seen.length;
    const result = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir], dstEnv());
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^DRY RUN: disk .* -> s3/m);
    assert.match(result.stdout, /To copy: 4 objects/);
    assert.match(result.stdout, /DRY RUN: nothing was changed/);
    assert.equal(fake.objects.size, 0, 'nothing written to the destination');
    assert.deepEqual(listDisk(dir), before, 'nothing changed at the source');
    assert.ok(fake.seen.length > start && fake.seen.slice(start).every((r) => r.method === 'GET'), 'it only looked: every request to the destination was a read');
    rmSync(dir, { recursive: true, force: true });
  });

  await check('storage-copy --apply copies every object, verifies the size of each on the destination, and leaves the source untouched', async () => {
    clearFake();
    const { dir, disk } = seedSource();
    await flush(disk);
    const before = listDisk(dir);
    const writes = fake.seen.length;
    const result = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir, '--apply', '--verify-content'], dstEnv());
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Copied 4 of 4/);
    assert.match(result.stdout, /Checked 4 objects on the destination/);
    assert.match(result.stdout, /Done: 4 objects are on the destination with the right size/);
    assert.deepEqual([...fake.objects.keys()].sort(), ['car-photos/u2/car.png', 'session-photos/u2/photo one.jpg', 'sim-laps/u1/a.xlap.gz', 'sim-laps/u1/b.xlap.gz']);
    const store = newS3();
    for (const name of ['u1/a.xlap.gz', 'u1/b.xlap.gz']) assert.equal(sha(await store.get('sim-laps', name)), sha(await disk.get('sim-laps', name)));
    assert.deepEqual(listDisk(dir), before, 'the source is exactly as it was');
    assert.ok(fake.seen.slice(writes).every((r) => r.method !== 'DELETE' || r.path.includes('/.probe/')), 'nothing was deleted on the destination');
    // Run it again: everything is already there with the right size, so nothing is copied and nothing asks anything.
    const again = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir, '--apply'], dstEnv());
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /To copy: 0 objects/);
    assert.match(again.stdout, /Copied 0 of 0/);
    rmSync(dir, { recursive: true, force: true });
  });

  await check('storage-copy refuses a destination that holds unexpected objects, or objects that differ, without confirmation, and changes nothing', async () => {
    clearFake();
    const { dir, disk } = seedSource();
    await flush(disk);
    // Something else already lives on the destination, and one object has the same name as a source object but another size.
    await newS3().put('sim-laps', 'someone-else/old.xlap.gz', bytesOf('keep me'), { upsert: true });
    await newS3().put('sim-laps', 'u1/a.xlap.gz', bytesOf('a different, older lap file'), { upsert: true });
    const before = s3Snapshot();
    const sourceBefore = listDisk(dir);
    const dry = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir], dstEnv());
    assert.equal(dry.code, 0);
    assert.match(dry.stdout, /Would REPLACE 1 objects/);
    assert.match(dry.stdout, /destination holds 1 objects the source does not/);
    assert.match(dry.stdout, /would ask for confirmation first/);
    const refused = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir, '--apply'], dstEnv());
    assert.equal(refused.code, 2, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /REFUSED: .*needs confirmation and there is no interactive terminal/);
    assert.match(refused.stdout, /1 of them REPLACE an object with a different size/);
    assert.deepEqual(s3Snapshot(), before, 'the destination is exactly as it was');
    assert.deepEqual(listDisk(dir), sourceBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  await check('storage-copy refuses a production destination through db/guard-destructive.mjs, with or without --yes', async () => {
    clearFake();
    const { dir, disk } = seedSource();
    await flush(disk);
    await newS3().put('sim-laps', 'someone-else/old.xlap.gz', bytesOf('keep me'), { upsert: true });
    const before = s3Snapshot();
    const hosts = { XPEED_PROD_HOSTS: '127.0.0.1' }; // the fake's host stands in for a production bucket
    for (const extra of [[], ['--yes']]) {
      const refused = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir, '--apply', ...extra], { ...dstEnv(), ...hosts });
      assert.equal(refused.code, 2, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /REFUSED: "copy files into a destination that is not empty" would overwrite production/);
    }
    assert.deepEqual(s3Snapshot(), before);
    rmSync(dir, { recursive: true, force: true });
  });

  await check('storage-copy --yes copies into a non-empty, non-production destination: replaces what differs, never deletes anything on either side', async () => {
    clearFake();
    const { dir, disk } = seedSource();
    await flush(disk);
    await newS3().put('sim-laps', 'someone-else/old.xlap.gz', bytesOf('keep me'), { upsert: true });
    await newS3().put('sim-laps', 'u1/a.xlap.gz', bytesOf('a different, older lap file'), { upsert: true });
    const sourceBefore = listDisk(dir);
    const result = await run(['--from', 'disk', '--to', 's3', '--from-dir', dir, '--apply', '--yes'], dstEnv());
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Done: 4 objects are on the destination/);
    assert.ok(same(await newS3().get('sim-laps', 'someone-else/old.xlap.gz'), bytesOf('keep me')), 'the unexpected object is still there');
    assert.ok(same(await newS3().get('sim-laps', 'u1/a.xlap.gz'), bytesOf('lap a')), 'the different one was replaced by the source\'s');
    assert.deepEqual(listDisk(dir), sourceBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  await check('storage-copy s3 to disk works the other way, and reports a failure (exit 1) when the destination rejects the credentials', async () => {
    clearFake();
    const store = newS3();
    await store.put('sim-laps', 'z/one.xlap.gz', bytesOf('from s3'), { upsert: true });
    const target = join(sandbox, 'restored');
    const result = await run(['--from', 's3', '--to', 'disk', '--to-dir', target, '--apply'], { ...fake.env });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.ok(same(await new DiskStore(target).get('sim-laps', 'z/one.xlap.gz'), bytesOf('from s3')));
    const broken = await run(['--from', 's3', '--to', 'disk', '--to-dir', join(sandbox, 'never')], { ...fake.env, SRC_S3_SECRET_ACCESS_KEY: 'wrong' });
    assert.equal(broken.code, 1, broken.stdout + broken.stderr);
    assert.match(broken.stderr, /Failed: S3 .* failed: 403/);
    assert.equal(existsSync(join(sandbox, 'never')), false);
    const sameSpot = await run(['--from', 'disk', '--to', 'disk', '--from-dir', target, '--to-dir', target]);
    assert.equal(sameSpot.code, 2);
    assert.match(sameSpot.stderr, /same place/);
    clearFake();
  });

  // ===================================================================== retention
  const lapAt = async ({ number = 1, hz = 60, seconds = 90, timeMs = 90_500, valid = true, extra = {} } = {}) => {
    const count = Math.round(hz * seconds);
    const t = new Float32Array(count), dist = new Float32Array(count), speed = new Float32Array(count), throttle = new Float32Array(count), gear = new Float32Array(count), fuel = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      t[i] = i / hz; dist[i] = (i / hz) * 55; speed[i] = 50 + 20 * Math.sin(i / (hz * 3)); throttle[i] = Math.max(0, Math.sin(i / (hz * 2))); gear[i] = 3 + Math.round(Math.sin(i / (hz * 5))); fuel[i] = i % 97 === 0 ? NaN : 60 - i / (hz * 100);
    }
    const header = {
      game: 'lmu', track: { name: 'Test Track', variant: 'GP', lengthM: 4950 }, car: { name: 'Test Car', class: 'GT3' },
      lap: { number, timeMs, valid, sectorsMs: [30_000, 30_500, 30_000] }, startedAt: '2026-01-10T12:00:00.000Z', sampleRateHz: hz, sampleCount: count,
      channels: [{ id: 't', unit: 's' }, { id: 'dist', unit: 'm' }, { id: 'speed', unit: 'm/s' }, { id: 'throttle', unit: 'ratio' }, { id: 'gear', unit: 'gear' }, { id: 'fuel', unit: 'l' }], ...extra,
    };
    return { header, data: { t, dist, speed, throttle, gear, fuel } };
  };

  await check('retention: decimating keeps the first and last sample, every channel, about 10 samples per second, and the clock stays increasing', async () => {
    const lap = await lapAt();
    const reduced = retention.decimateLap(lap, 10);
    const n = reduced.header.sampleCount;
    assert.ok(n >= 895 && n <= 905, `about 900 samples for 90 s at 10 Hz, got ${n}`);
    assert.equal(reduced.header.sampleRateHz, 10);
    assert.deepEqual(Object.keys(reduced.data), Object.keys(lap.data), 'all channels');
    for (const id of Object.keys(lap.data)) {
      assert.equal(reduced.data[id].length, n);
      assert.ok(Object.is(reduced.data[id][0], lap.data[id][0]), `first ${id}`);
      assert.ok(Object.is(reduced.data[id][n - 1], lap.data[id][lap.header.sampleCount - 1]), `last ${id}`);
    }
    for (let i = 1; i < n; i++) assert.ok(reduced.data.t[i] > reduced.data.t[i - 1]);
    assert.deepEqual(reduced.header.lap, lap.header.lap, 'lap time and sectors are the lap\'s');
    assert.equal(retention.decimateLap(await lapAt({ hz: 10 }), 10), null, 'a lap already at 10 Hz has nothing to cut');
    assert.equal(retention.decimateLap(await lapAt({ hz: 5 }), 10), null);
    assert.equal(retention.decimateLap(await lapAt({ hz: 2, seconds: 1 }), 10), null, 'two samples are the two boundaries');
  });

  const SCHEMA = `
    CREATE TABLE public.sim_laps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, storage_path text NOT NULL, size_bytes integer NOT NULL,
      started_at timestamptz NOT NULL, reduced boolean NOT NULL DEFAULT false, marked boolean NOT NULL DEFAULT false);
    CREATE TABLE public.sim_personal_bests (user_id uuid NOT NULL, track_id uuid NOT NULL, car_id uuid NOT NULL, lap_id uuid NOT NULL, PRIMARY KEY (user_id, track_id, car_id));`;
  const world = async (store, { hz = 60 } = {}) => {
    const db = await PGlite.create();
    await db.exec(SCHEMA);
    const user = '11111111-1111-4111-8111-111111111111';
    const lapIds = {};
    const add = async (name, { daysAgo, reduced = false, marked = false, lapHz = hz, number }) => {
      const lap = await gzipLap(await lapAt({ hz: lapHz, number }));
      const path = `${user}/${name}.xlap.gz`;
      await store.put('sim-laps', path, lap, { upsert: true });
      const row = await db.query('INSERT INTO public.sim_laps (user_id, storage_path, size_bytes, started_at, reduced, marked) VALUES ($1,$2,$3, now() - make_interval(days => $4::int),$5,$6) RETURNING id',
        [user, path, lap.length, daysAgo, reduced, marked]);
      lapIds[name] = row.rows[0].id;
      return { id: row.rows[0].id, path, bytes: lap };
    };
    const files = {};
    files.old = await add('old', { daysAgo: 120, number: 1 });
    files.older = await add('older', { daysAgo: 200, number: 2 });
    files.pb = await add('pb', { daysAgo: 150, number: 3 });
    files.marked = await add('marked', { daysAgo: 150, marked: true, number: 4 });
    files.recent = await add('recent', { daysAgo: 10, number: 5 });
    files.done = await add('done', { daysAgo: 300, reduced: true, lapHz: 10, number: 6 });
    await db.query('INSERT INTO public.sim_personal_bests (user_id, track_id, car_id, lap_id) VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2)', [user, files.pb.id]);
    return { db, user, files, ids: lapIds };
  };
  const rowOf = async (db, id) => (await db.query('SELECT id, storage_path, size_bytes, reduced, marked FROM public.sim_laps WHERE id = $1', [id])).rows[0];
  /** Every row says what its file is: size_bytes is the file's size and `reduced` is true exactly when the file is at 10 Hz or less. */
  const inSync = async (db, store) => {
    for (const row of (await db.query('SELECT id, storage_path, size_bytes, reduced FROM public.sim_laps')).rows) {
      const bytes = await store.get('sim-laps', row.storage_path);
      assert.ok(bytes, `file for ${row.storage_path}`);
      assert.equal(bytes.length, row.size_bytes, `size_bytes of ${row.storage_path}`);
      assert.equal((await gunzipLap(bytes)).header.sampleRateHz <= 10, row.reduced, `reduced flag of ${row.storage_path}`);
    }
  };
  const leftovers = async (store) => { const names = []; for await (const o of store.listAll('sim-laps')) names.push(o.path); return names.filter((n) => n.includes('reducing')); };
  const hiddenLeftovers = (dir) => { const found = []; const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (n.startsWith('.reducing-')) found.push(f); } }; walk(dir); return found; };

  await check('retention: reduces an old lap to 10 Hz and keeps the header and the lap time exactly; the row and the file agree', async () => {
    const dir = join(sandbox, 'ret1'); const store = new DiskStore(dir);
    const { db, files, ids } = await world(store);
    const originalLap = await gunzipLap(files.old.bytes);
    const summary = await retention.reduceOldLaps({ db, store, olderThanDays: 90, hz: 10 });
    assert.deepEqual([summary.considered, summary.reduced, summary.failed, summary.alreadyLow], [2, 2, 0, 0], JSON.stringify(summary));
    assert.ok(summary.savedBytes > 0 && summary.savedBytes === (files.old.bytes.length + files.older.bytes.length) - (await store.head('sim-laps', files.old.path)).size - (await store.head('sim-laps', files.older.path)).size);
    const after = await gunzipLap(await store.get('sim-laps', files.old.path));
    assert.equal(after.header.sampleRateHz, 10);
    assert.equal(after.header.lap.timeMs, 90_500);
    const { sampleCount: _a, sampleRateHz: _b, ...beforeHeader } = originalLap.header;
    const { sampleCount: _c, sampleRateHz: _d, ...afterHeader } = after.header;
    assert.deepEqual(afterHeader, beforeHeader, 'track, car, lap, sectors, start time and channels are exactly as they were');
    assert.ok(after.header.sampleCount < 910 && after.header.sampleCount > 890);
    for (const id of Object.keys(originalLap.data)) {
      assert.ok(Object.is(after.data[id][0], originalLap.data[id][0]));
      assert.ok(Object.is(after.data[id][after.header.sampleCount - 1], originalLap.data[id][originalLap.header.sampleCount - 1]));
    }
    const row = await rowOf(db, ids.old);
    assert.equal(row.reduced, true);
    assert.equal(row.size_bytes, (await store.head('sim-laps', files.old.path)).size);
    assert.ok(row.size_bytes < files.old.bytes.length / 4, 'the file is a fraction of the size');
    await inSync(db, store);
    assert.deepEqual(hiddenLeftovers(dir), [], 'the temporary copies are gone');
    await db.close();
  });

  await check('retention: skips a personal best, a marked lap, a recent lap and one that is already reduced; their files are not touched', async () => {
    const store = new DiskStore(join(sandbox, 'ret2'));
    const { db, files, ids } = await world(store);
    await retention.reduceOldLaps({ db, store });
    for (const name of ['pb', 'marked', 'recent', 'done']) {
      assert.ok(same(await store.get('sim-laps', files[name].path), files[name].bytes), `${name}: same bytes`);
      assert.equal((await rowOf(db, ids[name])).size_bytes, files[name].bytes.length);
    }
    assert.equal((await rowOf(db, ids.pb)).reduced, false);
    assert.equal((await rowOf(db, ids.marked)).reduced, false);
    assert.equal((await rowOf(db, ids.recent)).reduced, false);
    assert.equal((await rowOf(db, ids.old)).reduced, true);
    const again = await retention.reduceOldLaps({ db, store });
    assert.equal(again.considered, 0, 'a second run finds nothing: reduced laps are not offered again');
    await inSync(db, store);
    await db.close();
  });

  await check('retention: candidatesForReduction trusts the flags even when the query returns too much (a fake database that ignores the WHERE)', async () => {
    const cutoff = new Date('2026-08-15T00:00:00Z');
    const row = (id, over = {}) => ({ id, user_id: 'u', storage_path: `u/${id}.xlap.gz`, size_bytes: 100, started_at: '2026-01-01T00:00:00Z', reduced: false, marked: false, is_personal_best: false, ...over });
    const asked = [];
    const fakeDb = { query: async (sql, params) => { asked.push(params); return { rows: [row('ok-1'), row('pb', { is_personal_best: true }), row('marked', { marked: true }), row('reduced', { reduced: true }), row('recent', { started_at: '2026-08-20T00:00:00Z' }),
      row('as-text', { reduced: 'f', marked: 'f', is_personal_best: 'f' }), row('pb-text', { is_personal_best: 't' }), row('skipped-by-caller'), row('no-path', { storage_path: '' }), row('ok-2', { started_at: new Date('2026-02-02T00:00:00Z') })] }; } };
    const got = await retention.candidatesForReduction(fakeDb, { cutoff, limit: 10, excludeIds: ['skipped-by-caller'] });
    assert.deepEqual(got.map((c) => c.id), ['ok-1', 'as-text', 'ok-2']);
    assert.deepEqual(got[0], { id: 'ok-1', userId: 'u', storagePath: 'u/ok-1.xlap.gz', sizeBytes: 100 });
    assert.deepEqual(asked[0], [cutoff.toISOString(), 10, ['skipped-by-caller']], 'the contract: cutoff, limit, ids to leave out');
    assert.equal((await retention.candidatesForReduction(fakeDb, { cutoff, limit: 1 })).length, 1, 'never more than the limit');
  });

  await check('retention: the candidates query runs on a real PostgreSQL (PGlite) with the assumed columns, oldest first, and honours the limit and the exclusion list', async () => {
    const store = new DiskStore(join(sandbox, 'ret3'));
    const { db, ids } = await world(store);
    const cutoff = new Date(Date.now() - 90 * 86400_000);
    const all = await retention.candidatesForReduction(db, { cutoff, limit: 25 });
    assert.deepEqual(all.map((c) => c.id), [ids.older, ids.old], 'oldest first; not the personal best, the marked, the recent or the reduced');
    assert.deepEqual((await retention.candidatesForReduction(db, { cutoff, limit: 1 })).map((c) => c.id), [ids.older]);
    assert.deepEqual((await retention.candidatesForReduction(db, { cutoff, limit: 25, excludeIds: [ids.older] })).map((c) => c.id), [ids.old]);
    assert.deepEqual((await retention.candidatesForReduction(db, { cutoff: new Date(Date.now() - 400 * 86400_000), limit: 25 })), []);
    await db.close();
  });

  /** A store whose write to one key can be made to fail, optionally after half the bytes are on the disk. */
  const breakable = (inner) => {
    const state = { failPutOn: null, tear: false, failGetOn: null, puts: [] };
    const wrapper = {
      state,
      put: async (bucket, path, data, options) => {
        state.puts.push(path);
        if (state.failPutOn && state.failPutOn(path, state.puts.filter((p) => p === path).length)) {
          if (state.tear) await inner.put(bucket, path, data.slice(0, Math.floor(data.length / 2)), { upsert: true });
          throw new Error('disk full (simulated)');
        }
        return inner.put(bucket, path, data, options);
      },
      get: async (bucket, path) => { if (state.failGetOn?.(path)) throw new Error('read failed (simulated)'); return inner.get(bucket, path); },
      head: (...a) => inner.head(...a), remove: (...a) => inner.remove(...a), list: (...a) => inner.list(...a), listAll: (...a) => inner.listAll(...a), probe: () => inner.probe(),
    };
    return wrapper;
  };

  await check('retention: a write that fails halfway leaves the original file and the row untouched (row and file never out of sync), and the next run reduces it', async () => {
    const dir = join(sandbox, 'ret4'); const inner = new DiskStore(dir); const store = breakable(inner);
    const { db, files, ids } = await world(inner);
    // The write of the real key tears: half the reduced bytes land, then the error.
    store.state.tear = true;
    const failOnce = () => { let fired = false; return (path) => { if (path !== files.old.path || fired) return false; fired = true; return true; }; };
    store.state.failPutOn = failOnce();
    const summary = await retention.reduceOldLaps({ db, store });
    assert.equal(summary.failed, 1, JSON.stringify(summary));
    assert.equal(summary.reduced, 1, 'the other lap was reduced');
    assert.ok(same(await inner.get('sim-laps', files.old.path), files.old.bytes), 'the original is back, whole');
    const row = await rowOf(db, ids.old);
    assert.deepEqual([row.reduced, row.size_bytes], [false, files.old.bytes.length]);
    await inSync(db, inner);
    assert.deepEqual(hiddenLeftovers(dir), []);
    // And a write that fails before anything lands.
    store.state.tear = false;
    store.state.failPutOn = failOnce();
    const second = await retention.reduceOldLaps({ db, store });
    assert.equal(second.failed, 1);
    await inSync(db, inner);
    store.state.failPutOn = null;
    const third = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([third.reduced, third.failed], [1, 0]);
    await inSync(db, inner);
    await db.close();
  });

  await check('retention: a failing temporary write, or a failing read-back of it, changes nothing', async () => {
    const dir = join(sandbox, 'ret5'); const inner = new DiskStore(dir); const store = breakable(inner);
    const { db, files, ids } = await world(inner);
    store.state.failPutOn = (path) => path.includes('.reducing-');
    store.state.tear = true;
    const one = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([one.failed, one.reduced], [2, 0], JSON.stringify(one));
    for (const name of ['old', 'older']) { assert.ok(same(await inner.get('sim-laps', files[name].path), files[name].bytes)); assert.equal((await rowOf(db, ids[name])).reduced, false); }
    assert.deepEqual(hiddenLeftovers(dir), [], 'the half-written temporary copy was cleaned up');
    store.state.failPutOn = null;
    store.state.failGetOn = (path) => path.includes('.reducing-');
    const two = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([two.failed, two.reduced], [2, 0]);
    for (const name of ['old', 'older']) assert.ok(same(await inner.get('sim-laps', files[name].path), files[name].bytes));
    await inSync(db, inner);
    await db.close();
  });

  await check('retention: if the row update fails after the file was replaced, the original file is put back', async () => {
    const dir = join(sandbox, 'ret6'); const store = new DiskStore(dir);
    const { db, files, ids } = await world(store);
    const failing = { query: (sql, params) => (/UPDATE public\.sim_laps/.test(sql) && params[0] === ids.old ? Promise.reject(new Error('connection lost (simulated)')) : db.query(sql, params)) };
    const summary = await retention.reduceOldLaps({ db: failing, store });
    assert.deepEqual([summary.failed, summary.reduced], [1, 1], JSON.stringify(summary));
    assert.ok(same(await store.get('sim-laps', files.old.path), files.old.bytes), 'full detail again');
    assert.equal((await rowOf(db, ids.old)).reduced, false);
    assert.equal((await rowOf(db, ids.old)).size_bytes, files.old.bytes.length);
    assert.equal((await rowOf(db, ids.older)).reduced, true);
    await inSync(db, store);
    assert.deepEqual(hiddenLeftovers(dir), []);
    await db.close();
  });

  await check('retention: an unreadable file is left alone, a missing file is skipped, a deleted row is not resurrected', async () => {
    const dir = join(sandbox, 'ret7'); const store = new DiskStore(dir);
    const { db, files, ids } = await world(store);
    await store.put('sim-laps', files.old.path, bytesOf('this is not gzip'), { upsert: true });
    await store.remove('sim-laps', [files.older.path]);
    const summary = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([summary.unreadable, summary.missingFile, summary.reduced, summary.failed], [1, 1, 0, 0], JSON.stringify(summary));
    assert.ok(same(await store.get('sim-laps', files.old.path), bytesOf('this is not gzip')), 'untouched');
    assert.equal((await rowOf(db, ids.old)).reduced, false);
    // The person deletes a lap while the run is between its read and its update.
    await store.put('sim-laps', files.old.path, files.old.bytes, { upsert: true });
    const deleting = { query: async (sql, params) => { if (/UPDATE public\.sim_laps/.test(sql) && params[0] === ids.old) await db.query('DELETE FROM public.sim_laps WHERE id = $1', [ids.old]); return db.query(sql, params); } };
    const run2 = await retention.reduceOldLaps({ db: deleting, store });
    assert.equal(run2.failed, 0, JSON.stringify(run2));
    assert.equal(await rowOf(db, ids.old), undefined, 'the row stays deleted');
    await db.close();
  });

  await check('retention: honours the time budget and the lap limit, and a lap already at 10 Hz is only marked, not rewritten', async () => {
    const store = new DiskStore(join(sandbox, 'ret8'));
    const { db, ids } = await world(store);
    let clock = 0;
    const tick = () => { clock += 1000; return clock; };
    const limited = await retention.reduceOldLaps({ db, store, budgetMs: 1500, now: tick });
    assert.equal(limited.budgetReached, true);
    assert.ok(limited.reduced <= 1, JSON.stringify(limited));
    const capped = await retention.reduceOldLaps({ db, store, maxLaps: 1 });
    assert.ok(capped.considered <= 1);
    await retention.reduceOldLaps({ db, store });
    assert.equal((await rowOf(db, ids.old)).reduced, true);
    assert.equal((await rowOf(db, ids.older)).reduced, true);
    // A lap recorded at 10 Hz is old enough but has nothing to cut.
    const user = '22222222-2222-4222-8222-222222222222';
    const low = await gzipLap(await lapAt({ hz: 10, number: 9 }));
    await store.put('sim-laps', `${user}/low.xlap.gz`, low, { upsert: true });
    const inserted = await db.query("INSERT INTO public.sim_laps (user_id, storage_path, size_bytes, started_at) VALUES ($1, $2, $3, now() - interval '200 days') RETURNING id", [user, `${user}/low.xlap.gz`, low.length]);
    const result = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([result.alreadyLow, result.reduced], [1, 0]);
    assert.ok(same(await store.get('sim-laps', `${user}/low.xlap.gz`), low), 'file untouched');
    assert.equal((await rowOf(db, inserted.rows[0].id)).reduced, true);
    await db.close();
  });

  await check('retention: the same scenario on the S3 store, signed requests and all', async () => {
    clearFake();
    const store = newS3();
    const { db, files, ids } = await world(store);
    const start = fake.seen.length;
    const summary = await retention.reduceOldLaps({ db, store });
    assert.deepEqual([summary.reduced, summary.failed], [2, 0], JSON.stringify(summary));
    assert.ok(same(await store.get('sim-laps', files.pb.path), files.pb.bytes));
    const row = await rowOf(db, ids.old);
    assert.deepEqual([row.reduced, row.size_bytes], [true, (await store.head('sim-laps', files.old.path)).size]);
    assert.equal((await gunzipLap(await store.get('sim-laps', files.old.path))).header.sampleRateHz, 10);
    assert.deepEqual([...fake.objects.keys()].filter((k) => k.includes('reducing')), [], 'no temporary copy left');
    assert.ok(fake.seen.slice(start).every((r) => r.ok), 'every request was correctly signed');
    await inSync(db, store);
    await db.close();
    clearFake();
  });

  // ===================================================================== schedule
  await check('jobs: retention is off unless RETENTION_ENABLED=true, the orphan sweeper is scheduled only when sweepOrphanLaps exists, and a job runs after a random offset, then daily, never overlapping', async () => {
    const db = { DATABASE_URL: 'postgres://x' };
    assert.deepEqual(enabledJobs({ ...db }, {}).map((j) => j.name), []);
    assert.deepEqual(enabledJobs({ ...db, RETENTION_ENABLED: 'false' }, {}).map((j) => j.name), []);
    assert.deepEqual(enabledJobs({ ...db, RETENTION_ENABLED: 'true' }, {}).map((j) => j.name), ['retention']);
    assert.deepEqual(enabledJobs({ RETENTION_ENABLED: 'true' }, {}).map((j) => j.name), [], 'no database, nothing to do');
    assert.deepEqual(enabledJobs({ ...db }, { sweepOrphanLaps: 'not a function' }).map((j) => j.name), []);
    const swept = [];
    const jobs = enabledJobs({ ...db, RETENTION_ENABLED: 'true' }, { sweepOrphanLaps: async () => { swept.push(1); return { removed: 3 }; } });
    assert.deepEqual(jobs.map((j) => j.name), ['retention', 'orphan_sweeper']);
    assert.deepEqual(await jobs[1].run(), { removed: 3 });

    const timers = [];
    const setTimer = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; };
    const ran = [];
    let release;
    const slow = { name: 'slow', run: () => new Promise((done) => { ran.push('start'); release = () => done({ n: 1 }); }) };
    const originalLog = console.log; const lines = [];
    console.log = (line) => lines.push(line);
    try {
      const first = scheduleDaily(slow, { random: () => 0.5, maxOffsetMs: 1000, setTimer });
      assert.equal(first.delay, 500, 'a random offset of up to maxOffsetMs');
      assert.equal(scheduleDaily({ name: 'x', run: async () => {} }, { random: () => 0, setTimer }).delay, 0);
      assert.ok(scheduleDaily({ name: 'x', run: async () => {} }, { random: () => 0.999999, setTimer }).delay < 3 * 3600 * 1000);
      timers[0].fn();
      timers[0].fn(); // fires again while the first run is still going
      assert.deepEqual(ran, ['start'], 'never overlaps itself');
      release();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.ok(timers.some((t) => t.ms === 24 * 3600 * 1000), 'the next run is in 24 hours');
      const summary = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'job_done');
      assert.deepEqual([summary.job, summary.n], ['slow', 1], 'one line per run');
    } finally { console.log = originalLog; }
    const errors = []; const originalError = console.error; console.error = (line) => errors.push(line);
    try {
      scheduleDaily({ name: 'boom', run: async () => { throw new Error('exploded'); } }, { random: () => 0, setTimer });
      timers.at(-1).fn();
      await new Promise((r) => setImmediate(r));
      assert.equal(JSON.parse(errors[0]).event, 'job_failed', 'a failing job is logged and does not throw into the process');
    } finally { console.error = originalError; }
  });

  console.log(`\nverify-storage: ${checks.length} checks passed`);
  for (const name of checks) console.log(`  ok  ${name}`);
} finally {
  await fake.close();
  rmSync(temp, { recursive: true, force: true });
}
