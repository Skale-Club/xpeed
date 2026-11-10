// The Supabase edge functions, bundled unchanged into the Node server and run against real
// PostgreSQL (PGlite): sign-in, the AI provider key in the database, daily quotas and refunds, the
// car data behind the chat, OAuth client registration and the MCP entry point. The AI provider itself
// is simulated. No .env, network or remote credentials.
// Needs: npm install --prefix node_modules/.xpeed-audit-tools --no-save --ignore-scripts --legacy-peer-deps @electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.18
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'esbuild';
import pg from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ensureIdentityProject, migrate } from '../db/migrate.mjs';
import { edgeFunctions } from './esbuild-edge.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tools = pathToFileURL(resolve(root, 'node_modules/.xpeed-audit-tools/node_modules/@electric-sql/')).href + '/';
const { PGlite } = await import(tools + 'pglite/dist/index.js');
const { PGLiteSocketServer } = await import(tools + 'pglite-socket/dist/index.js');

mkdirSync(resolve(root, 'node_modules/.cache'), { recursive: true });
const temp = mkdtempSync(resolve(root, 'node_modules/.cache/xpeed-functions-'));
const port = 54460;
const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
Object.assign(process.env, {
  DATABASE_URL: databaseUrl, DATABASE_POOL_SIZE: '1', FIREBASE_PROJECT_ID: 'skaleclub', PUBLIC_APP_URL: 'https://xpeed.test',
  DATA_BACKEND: 'own', XPEED_OAUTH_JWT_SECRET: 'test-oauth-secret-test-oauth-secret',
});

await build({
  entryPoints: {
    functions: 'server/functions/index.ts', hook: 'server/functions/invoke-hook.ts', identity: 'server/identity.ts',
    account: 'server/account-route.ts', dbroute: 'server/db-route.ts', mcp: 'api/mcp.ts', register: 'api/oauth/register.ts',
  },
  outdir: temp, bundle: true, splitting: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' },
  external: ['pg', 'jose', '@supabase/supabase-js'], tsconfig: 'tsconfig.app.json', absWorkingDir: root, logLevel: 'error',
  plugins: [edgeFunctions],
});
const load = (name) => import(pathToFileURL(resolve(temp, name)).href);
const { functionNames, invokeFunction } = await load('functions.mjs');
const { setFunctionRunner } = await load('hook.mjs');
const { useKeysForTesting } = await load('identity.mjs');
const { createAccountRoute } = await load('account.mjs');
const { createDbRoute } = await load('dbroute.mjs');
const mcpProxy = (await load('mcp.mjs')).default;
const registerProxy = (await load('register.mjs')).default;
setFunctionRunner(invokeFunction);

const checks = [];
const check = async (name, test) => { if (process.env.VERBOSE) console.log('> ' + name); await test(); checks.push(name); };
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();

// The AI provider is simulated; everything else goes nowhere.
const provider = { calls: [], answer: () => ({ status: 200, body: { choices: [{ message: { content: 'Hello from the model' } }] } }) };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith('https://openrouter.ai/')) {
    provider.calls.push({ headers: init?.headers, body: JSON.parse(init?.body ?? '{}') });
    const { status, body } = provider.answer();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  throw new Error(`Unexpected network call to ${url}`);
};

try {
  const setup = new pg.Client({ connectionString: databaseUrl });
  await setup.connect();
  await migrate(setup);
  await ensureIdentityProject(setup, 'skaleclub');
  await setup.query(`INSERT INTO public.app_settings(setting_key, setting_value) VALUES
    ('admin_secret_openrouter_api_key', 'sk-test-key'), ('admin_openrouter_model', 'test/model')`);
  await setup.end();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  useKeysForTesting(createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'k1' }] }));
  const token = (sub, extra = {}) => new SignJWT({ firebase: { sign_in_provider: 'phone' }, ...extra })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer('https://securetoken.google.com/skaleclub').setAudience('skaleclub')
    .setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
  const A = await token('uid-a', { phone_number: '+15550000001' }), B = await token('uid-b', { phone_number: '+15550000002' });
  const accounts = createAccountRoute();
  for (const t of [A, B]) assert.equal((await accounts(new Request('http://x/api/account', { method: 'POST', headers: { authorization: `Bearer ${t}` } }))).status, 200);
  const dbRoute = createDbRoute();
  const car = async (bearer, name) => (await (await dbRoute(new Request('http://x/api/db', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ kind: 'query', table: 'car_profiles', action: 'insert', values: { name, make: name === 'Prius' ? 'Toyota' : 'Honda' }, returning: true, select: 'id', shape: 'single' }),
  }))).json()).data.id;
  const carA = await car(A, 'Prius'), carB = await car(B, 'Civic');

  const call = async (name, { bearer, body, method = 'POST', rest = '', headers = {} } = {}) => {
    const response = await invokeFunction(name, new Request(`http://x/api/fn/${name}${rest}`, {
      method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), rest);
    const text = await response.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, text, headers: response.headers };
  };

  await check('all nine functions are registered, and the retired ones still answer 410 Gone', async () => {
    assert.deepEqual(functionNames().sort(), ['ai-health', 'analyze-session', 'car-insights-mcp', 'chat', 'manage-mcp-tokens', 'mcp-server', 'read-fuel-receipt', 'xpeed-mcp', 'xpeed-oauth']);
    assert.equal((await call('car-insights-mcp')).status, 410);
    assert.equal((await call('car-insights-mcp', { method: 'OPTIONS' })).status, 204);
    assert.equal((await call('no-such-function')).status, 404);
  });

  await check('chat: needs a valid sign-in and a well-formed message', async () => {
    assert.equal((await call('chat', { body: { message: 'hi' } })).status, 401);
    assert.equal((await call('chat', { bearer: 'garbage', body: { message: 'hi' } })).status, 401);
    assert.equal((await call('chat', { bearer: A, body: { message: '' } })).status, 400);
    assert.equal((await call('chat', { bearer: A, body: { message: 'hi', language: 'xx' } })).status, 400);
    assert.equal(provider.calls.length, 0, 'nothing reached the provider');
  });

  await check('chat: answers with the key and model from the database, and uses only the caller\'s own car', async () => {
    const ok = await call('chat', { bearer: A, body: { message: 'Why is my engine warm?', carProfileId: carA, history: [{ role: 'user', parts: 'earlier' }] } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.reply, 'Hello from the model');
    assert.deepEqual([ok.json.quota.remaining, ok.json.quota.limit], [29, 30]);
    const sent = provider.calls.at(-1);
    assert.equal(sent.headers.Authorization, 'Bearer sk-test-key');
    assert.equal(sent.body.model, 'test/model');
    assert.equal(sent.body.messages.at(-1).content, 'Why is my engine warm?');
    assert.match(sent.body.messages[0].content, /Prius/);
    // Asking about somebody else's car must not leak it into the prompt.
    await call('chat', { bearer: A, body: { message: 'And this one?', carProfileId: carB } });
    assert.doesNotMatch(provider.calls.at(-1).body.messages[0].content, /Civic/);
  });

  await check('chat: a failing provider gives the quota back; the daily limit is enforced', async () => {
    const before = (await call('chat', { bearer: B, body: { message: 'first' } })).json.quota.remaining;
    provider.answer = () => ({ status: 500, body: { error: 'down' } });
    assert.equal((await call('chat', { bearer: B, body: { message: 'fails' } })).status, 502);
    provider.answer = () => ({ status: 200, body: { choices: [{ message: { content: '   ' } }] } });
    assert.equal((await call('chat', { bearer: B, body: { message: 'empty answer' } })).status, 502);
    provider.answer = () => ({ status: 200, body: { choices: [{ message: { content: 'back' } }] } });
    const after = (await call('chat', { bearer: B, body: { message: 'again' } })).json.quota.remaining;
    assert.equal(after, before - 1, 'the two failed attempts cost nothing');
    let last;
    for (let i = 0; i < 40; i++) { last = await call('chat', { bearer: B, body: { message: `m${i}` } }); if (last.status === 429) break; }
    assert.equal(last.status, 429);
    assert.equal(last.json.code, 'limit_reached');
    // The other person's allowance is separate.
    assert.equal((await call('chat', { bearer: A, body: { message: 'still fine' } })).status, 200);
  });

  await check('other functions refuse anonymous callers and answer CORS preflights', async () => {
    assert.equal((await call('read-fuel-receipt', { body: { carId: carA, image: 'x' } })).status, 401);
    assert.equal((await call('analyze-session', { body: { sessionId: carA } })).status, 401);
    for (const name of ['chat', 'read-fuel-receipt', 'analyze-session', 'ai-health']) {
      const preflight = await call(name, { method: 'OPTIONS' });
      assert.ok([200, 204].includes(preflight.status), `${name} ${preflight.status}`);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    }
  });

  await check('OAuth: a client can register and is stored in the app database', async () => {
    const registered = await call('xpeed-oauth', { rest: '/register', body: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' } });
    assert.equal(registered.status, 201, registered.text);
    assert.match(registered.json.client_id, /\S+/);
    // PGlite serves one socket connection at a time and the app holds it, so look through the instance itself.
    const stored = await db.query('SELECT count(*)::int AS n FROM public.oauth_clients');
    assert.equal(stored.rows[0].n, 1);
    assert.equal((await call('xpeed-oauth', { rest: '/token', body: { grant_type: 'authorization_code', code: 'nope', client_id: 'x' } })).status, 400);
  });

  await check('the api proxies reach the functions inside the same process (no Supabase)', async () => {
    const proxied = await registerProxy(new Request('http://x/api/oauth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Second', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    }));
    assert.equal(proxied.status, 201, await proxied.text());
    const mcp = await mcpProxy(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }));
    assert.equal(mcp.status, 401, 'the MCP entry point wants a token');
    assert.ok(mcp.headers.get('www-authenticate'), 'and says where to get one');
  });

  console.log(`${checks.length} edge function checks passed:\n- ${checks.join('\n- ')}`);
} finally {
  globalThis.fetch = realFetch;
  await server.stop().catch(() => {});
  await db.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
