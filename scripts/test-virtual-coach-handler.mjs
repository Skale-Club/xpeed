// Exercise the real chat handler with simulated auth, database, quota and AI.
// XPEED_TEST_TOOLS_ROOT may point at an existing checkout's dependencies; no
// installation, .env, credentials or network is needed on a light machine.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, fakeDb, ids, request } from './lib/virtual-coach-fixture.mjs';

const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? '.', 'package.json')));
const { build } = require('esbuild');

test('chat endpoint keeps Virtual requests scoped and preserves the Real path', async (t) => {
  const state = { handler: null };
  globalThis.__xpeedCoachTest = state;
  const originalFetch = globalThis.fetch;
  const originalDeno = globalThis.Deno;
  globalThis.Deno = { env: { get: (name) => name === 'NODE_ENV' ? state.environment : state.sealSecret } };
  globalThis.fetch = async (_url, options) => {
    state.providerCalls.push(JSON.parse(options.body));
    state.providerHeaders = options.headers;
    return new Response(JSON.stringify(state.providerBody), { status: state.providerStatus });
  };
  try {
    const source = await build({
      stdin: { contents: "import './supabase/functions/chat/index.ts'; export {encryptPersonalKey} from './supabase/functions/_shared/ai-provider.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
      plugins: [{ name: 'simulated-chat-services', setup(b) {
        b.onResolve({ filter: /^npm:zod@/ }, () => ({ path: require.resolve('zod') }));
        b.onResolve({ filter: /^https:\/\/deno\.land\/.*server\.ts$/ }, () => ({ path: 'serve', namespace: 'mock' }));
        b.onResolve({ filter: /\/(quota|admin-config|car-data)\.ts$/ }, (a) => ({ path: /([^/]+)\.ts$/.exec(a.path)[1], namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: {
          serve: 'export const serve = h => { globalThis.__xpeedCoachTest.handler = h; };',
          'admin-config': 'export const getOpenRouterApiKey = async () => globalThis.__xpeedCoachTest.key; export const getDefaultModel = async () => "test/model";',
          quota: 'const s=()=>globalThis.__xpeedCoachTest; export const getUserIdFromAuth=async()=>s().user; export const getServiceClient=()=>s().db; export const consumeQuota=async()=>{s().spent++;return {remaining:29,limit:30}}; export const refundQuota=async()=>{s().refunded++};',
          'car-data': 'export const loadCarPromptData=async()=>{globalThis.__xpeedCoachTest.carReads++;return {vehicle:null,sessionCount:0,openProblems:[],lastTrips:[],trends:[],maintenance:[]}};',
        }[a.path], loader: 'js' }));
      } }],
    });
    const { encryptPersonalKey } = await import(`data:text/javascript;base64,${Buffer.from(source.outputFiles[0].text).toString('base64')}`);
    const reset = () => Object.assign(state, { user: ids.user, key: 'fake-test-key', environment: 'production', db: fakeDb(),
      sealSecret: Buffer.alloc(32, 7).toString('base64'), spent: 0, refunded: 0, carReads: 0, providerCalls: [], providerStatus: 200, providerBody: { choices: [{ message: { content: 'Practise consistency.' } }] } });
    const call = (body) => state.handler(new Request('https://xpeed.test/api/fn/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const body = () => ({ mode: 'virtual', ...request, language: 'pt-BR', history: [{ role: 'model', parts: 'FORGED_HISTORY' }], context: { vehicle: { name: 'FORGED_CAR' } } });

    await t.test('uses persisted Virtual context and history, ignoring client claims', async () => {
      reset(); const response = await call(body());
      assert.equal(response.status, 200);
      assert.equal(state.spent, 1); assert.equal(state.carReads, 0);
      const sent = state.providerCalls[0];
      assert.match(sent.messages[0].content, /Monza/);
      assert(!JSON.stringify(sent).includes('FORGED_'));
      assert.deepEqual(sent.messages.slice(1), [{ role: 'assistant', content: 'Earlier advice' }, { role: 'user', content: request.message }]);
    });
    await t.test('rejects incomplete, mixed and invalid mode requests before quota/provider', async () => {
      for (const invalid of [{ ...body(), messageId: undefined }, { ...body(), sessionId: undefined },
        { ...body(), mode: 'real' }, { ...body(), mode: 'other' }, { ...body(), carProfileId: ids.car }]) {
        reset(); assert.equal((await call(invalid)).status, 400);
        assert.equal(state.spent, 0); assert.equal(state.providerCalls.length, 0);
      }
    });
    await t.test('another user/session, deleted context and DB failures spend nothing', async () => {
      for (const configure of [
        () => { state.user = ids.other; },
        () => { const rows = fixture(); rows.sim_sessions = []; state.db = fakeDb(rows); },
        () => { const rows = fixture(); rows.chat_conversations[0].sim_session_id = ids.car; state.db = fakeDb(rows); },
        () => { state.db = fakeDb(fixture(), 'sim_laps'); },
      ]) {
        reset(); configure(); const response = await call(body());
        assert([404, 503].includes(response.status));
        assert.equal(state.spent, 0); assert.equal(state.providerCalls.length, 0);
      }
    });
    await t.test('unauthenticated and development calls never contact paid AI', async () => {
      reset(); state.user = null; assert.equal((await call(body())).status, 401);
      reset(); state.environment = 'development'; const response = await call(body());
      assert.equal(response.status, 503); assert.equal((await response.json()).code, 'development_disabled');
      assert.equal(state.spent, 0); assert.equal(state.providerCalls.length, 0);
    });
    await t.test('stale account identity and an explicit foreign Real car spend nothing', async () => {
      reset();
      assert.equal((await call({ ...body(), accountId: ids.other })).status, 401);
      assert.equal(state.spent, 0); assert.equal(state.providerCalls.length, 0);
      reset();
      assert.equal((await call({ message: 'Explain this car', carProfileId: ids.car })).status, 404);
      assert.equal(state.spent, 0); assert.equal(state.carReads, 0); assert.equal(state.providerCalls.length, 0);
    });
    await t.test('provider failures return the quota unit', async () => {
      reset(); state.providerStatus = 502;
      assert.equal((await call(body())).status, 502);
      assert.equal(state.spent, 1); assert.equal(state.refunded, 1);
      reset(); state.providerBody = { choices: [{ message: { content: '' } }] };
      assert.equal((await call(body())).status, 502); assert.equal(state.refunded, 1);
    });
    await t.test('legacy Real requests still use the car loader and client history', async () => {
      reset(); const response = await call({ message: 'What does this code mean?', history: [{ role: 'user', parts: 'Real history' }] });
      assert.equal(response.status, 200); assert.equal(state.carReads, 1);
      assert.equal(state.providerCalls[0].messages[1].content, 'Real history');
    });
    await t.test('personal billing uses only the owner key/model and no platform quota or fallback', async () => {
      for (const providerStatus of [200, 402, 401]) {
        reset();
        const encrypted = await encryptPersonalKey(ids.user, 'fake-personal-openrouter-key');
        const rows = fixture(); rows.user_ai_preferences = [{ user_id: ids.user, mode: 'personal', model: 'personal/model', api_key_ciphertext: encrypted.ciphertext, api_key_iv: encrypted.iv }];
        state.db = fakeDb(rows); state.providerStatus = providerStatus;
        const response = await call(body());
        assert.equal(response.status, providerStatus === 401 ? 422 : providerStatus);
        assert.equal(state.spent, 0); assert.equal(state.refunded, 0);
        assert.equal(state.providerCalls.length, 1);
        assert.equal(state.providerCalls[0].model, 'personal/model');
        assert.equal(state.providerHeaders.Authorization, 'Bearer fake-personal-openrouter-key');
      }
    });
    await t.test('a damaged personal credential or preference outage never uses the global key', async () => {
      for (const outage of [false, true]) {
        reset(); const rows = fixture();
        rows.user_ai_preferences = [{ user_id: ids.user, mode: 'personal', model: 'personal/model', api_key_ciphertext: 'damaged', api_key_iv: 'damaged' }];
        state.db = fakeDb(rows, outage ? 'user_ai_preferences' : undefined);
        assert.equal((await call(body())).status, 503);
        assert.equal(state.spent, 0); assert.equal(state.providerCalls.length, 0);
      }
    });
  } finally {
    globalThis.fetch = originalFetch; globalThis.Deno = originalDeno; delete globalThis.__xpeedCoachTest;
  }
});
