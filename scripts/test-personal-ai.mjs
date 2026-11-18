// The real credential endpoint/resolver, with only auth, database and global
// configuration boundaries simulated. Never contacts a provider or reads .env.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ids } from './lib/virtual-coach-fixture.mjs';

const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? '.', 'package.json')));
const { build } = require('esbuild');

test('super-admin manages write-only, owner-bound personal OpenRouter credentials', async (t) => {
  const state = { user: ids.other, admin: true, privateReads: 0, globalKey: 'fake-platform-key', rows: [], storageKey: Buffer.alloc(32, 7).toString('base64'), failed: false };
  const oldDeno = globalThis.Deno, oldFetch = globalThis.fetch;
  globalThis.__xpeedPersonalAi = state;
  globalThis.Deno = { env: { get: (name) => name === 'AI_CREDENTIAL_ENCRYPTION_KEY' ? state.storageKey : 'production' } };
  globalThis.fetch = () => { throw Error('No network allowed'); };
  state.db = { from(table) {
    assert(['user_ai_preferences', 'car_profiles', 'app_accounts'].includes(table));
    const filters = []; let action = 'select', values, max = Infinity;
    const run = () => {
      if (state.failed) return { data: null, error: { message: 'offline' } };
      if (table === 'user_ai_preferences') state.privateReads++;
      const source = table === 'car_profiles' ? state.admin ? [{ id: 'admin-profile', user_id: state.user, is_admin: true }] : []
        : table === 'app_accounts' ? [{ id: ids.user, full_name: 'Driver', email: 'driver@test.invalid' }, { id: ids.other, full_name: 'Admin', email: null }] : state.rows;
      let found = source.filter((r) => filters.every(([op, key, value]) => op === 'gt' ? r[key] > value : r[key] === value)).slice(0, max);
      if (action === 'upsert') { state.rows = [...state.rows.filter((r) => r.user_id !== values.user_id), values]; found = [values]; }
      if (action === 'delete') { state.rows = state.rows.filter((r) => !found.includes(r)); found = []; }
      return { data: found, error: null };
    };
    const q = { select() { return q; }, eq(key, value) { filters.push(['eq', key, value]); return q; },
      gt(key, value) { filters.push(['gt', key, value]); return q; }, order() { return q; }, limit(n) { max = n; return q; },
      upsert(v) { action = 'upsert'; values = v; return q; }, delete() { action = 'delete'; return q; },
      async maybeSingle() { const r = run(); return { ...r, data: r.data?.[0] ?? null }; },
      then(ok, fail) { return Promise.resolve(run()).then(ok, fail); } };
    return q;
  } };
  try {
    const built = await build({ stdin: { contents: "import './supabase/functions/ai-preferences/index.ts'; export * from './supabase/functions/_shared/ai-provider.ts';", resolveDir: process.cwd(), loader: 'ts' },
      bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'boundaries', setup(b) {
        b.onResolve({ filter: /^npm:zod@/ }, () => ({ path: require.resolve('zod') }));
        b.onResolve({ filter: /^https:\/\/deno\.land\/.*server\.ts$/ }, () => ({ path: 'serve', namespace: 'mock' }));
        b.onResolve({ filter: /\/(quota|admin-config)\.ts$/ }, (a) => ({ path: /([^/]+)\.ts$/.exec(a.path)[1], namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: {
          serve: 'export const serve=h=>{globalThis.__xpeedPersonalAi.handler=h};',
          quota: 'export const getUserIdFromAuth=async()=>globalThis.__xpeedPersonalAi.user;export const getServiceClient=()=>globalThis.__xpeedPersonalAi.db;',
          'admin-config': 'export const getOpenRouterApiKey=async()=>globalThis.__xpeedPersonalAi.globalKey;export const getDefaultModel=async()=>"global/model";',
        }[a.path], loader: 'js' }));
      } }] });
    const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
    const call = (body) => state.handler(new Request('https://xpeed.test/api/fn/ai-preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: ids.other, targetAccountId: ids.user, ...body }) }));
    await t.test('ordinary users cannot list accounts, read key metadata, save or delete even their own key', async () => {
      state.admin = false; state.user = ids.user;
      const before = state.privateReads;
      for (const action of ['accounts', 'status', 'save', 'delete']) {
        assert.equal((await call({ action, accountId: ids.user, targetAccountId: ids.user, mode: 'personal', model: 'personal/model', apiKey: 'fake-personal-openrouter-key' })).status, 403);
      }
      assert.equal(state.privateReads, before); assert.equal(state.rows.length, 0);
      state.admin = true; state.user = ids.other;
    });
    await t.test('admin sees a bounded account picker and safe target metadata only', async () => {
      const accounts = await (await call({ action: 'accounts', targetAccountId: undefined })).json();
      assert.equal(accounts.accounts.length, 2); assert.equal(accounts.nextCursor, null);
      assert.deepEqual(Object.keys(accounts.accounts[0]).sort(), ['email', 'id', 'name']);
      const status = await (await call({ action: 'status' })).json();
      assert.equal(status.mode, 'global'); assert.equal(status.keyConfigured, false);
      assert(!JSON.stringify(status).includes(state.globalKey));
      assert.deepEqual(Object.keys(status).sort(), ['mode','keyConfigured','keyLast4','model','canSaveKey','globalConfigured','globalModel'].sort());
    });
    await t.test('saves encrypted personal credentials even when no platform key exists', async () => {
      state.globalKey = null;
      const response = await call({ action: 'save', mode: 'personal', model: 'personal/model', apiKey: 'fake-personal-openrouter-key' });
      assert.equal(response.status, 200);
      const status = await response.json(); assert.equal(status.keyLast4, '-key');
      assert.equal(status.mode, 'personal'); assert.equal(status.globalConfigured, false);
      assert(!JSON.stringify(state.rows).includes('fake-personal-openrouter-key'));
      const provider = await api.resolveAiProvider(state.db, ids.user);
      assert.deepEqual(provider, { source: 'personal', apiKey: 'fake-personal-openrouter-key', model: 'personal/model' });
    });
    await t.test('rejects ciphertext tampering, account substitution and missing server encryption key', async () => {
      const row = state.rows[0];
      await assert.rejects(api.decryptPersonalKey({ ...row, user_id: ids.other }), (e) => e.code === 'personal_key_unavailable');
      const wrong = row.api_key_ciphertext[0] === 'A' ? 'B' : 'A';
      await assert.rejects(api.decryptPersonalKey({ ...row, api_key_ciphertext: wrong + row.api_key_ciphertext.slice(1) }), (e) => e.code === 'personal_key_unavailable');
      state.storageKey = '';
      await assert.rejects(api.resolveAiProvider(state.db, ids.user), (e) => e.code === 'credential_storage_unavailable');
      assert.equal((await call({ action: 'save', mode: 'personal', model: 'personal/model', apiKey: 'fake-replacement-user-key' })).status, 503);
      state.storageKey = Buffer.alloc(32, 7).toString('base64');
    });
    await t.test('stale account requests cannot save, read status or remove another account key', async () => {
      state.user = ids.user;
      const before = JSON.stringify(state.rows);
      for (const action of ['status', 'save', 'delete']) assert.equal((await call({ action, mode: 'global' })).status, 401);
      assert.equal(JSON.stringify(state.rows), before);
      state.user = ids.other;
    });
    await t.test('database failure fails closed and explicit global selection/removal are reversible', async () => {
      state.failed = true; state.globalKey = 'fake-platform-key';
      await assert.rejects(api.resolveAiProvider(state.db, ids.user), (e) => e.code === 'ai_preferences_unavailable');
      assert.equal((await call({ action: 'status' })).status, 503);
      state.failed = false;
      assert.equal((await call({ action: 'save', mode: 'global' })).status, 200);
      assert.equal((await api.resolveAiProvider(state.db, ids.user)).source, 'global');
      assert.equal((await call({ action: 'save', mode: 'personal', model: 'personal/model' })).status, 200);
      assert.equal((await api.resolveAiProvider(state.db, ids.user)).source, 'personal');
      assert.equal((await call({ action: 'delete' })).status, 200);
      assert.equal(state.rows.length, 0); assert.equal((await api.resolveAiProvider(state.db, ids.user)).source, 'global');
    });
    await t.test('malformed keys, missing personal model and missing account identity cannot be saved', async () => {
      for (const body of [
        { action: 'save', mode: 'personal', apiKey: 'fake-personal-openrouter-key' },
        { action: 'save', mode: 'personal', model: 'test/model', apiKey: 'bad\nkey' },
        { action: 'save', mode: 'global', apiKey: 'fake-personal-openrouter-key' },
        { action: 'status', accountId: undefined },
        { action: 'status', targetAccountId: undefined },
      ]) assert.equal((await call(body)).status, 400);
      assert.equal(state.rows.length, 0);
    });
  } finally { globalThis.Deno = oldDeno; globalThis.fetch = oldFetch; delete globalThis.__xpeedPersonalAi; }
});
