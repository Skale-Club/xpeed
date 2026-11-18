// Client transport and storage contracts without a browser or installed app
// runtime. Only auth/network/i18n boundaries are simulated; query construction,
// mode filtering, transport payloads and browser preference helpers are real.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? '.', 'package.json')));
const { build } = require('esbuild');
const root = process.cwd();

test('client coach contracts preserve optionality and separate contexts', async (t) => {
  const state = { requests: [], invokes: [], user: { id: 'driver' }, error: null };
  globalThis.__xpeedCoachClient = state;
  const originalStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const load = async (entry) => {
    const built = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
      plugins: [{ name: 'client-boundaries', setup(b) {
        const stubs = {
          '@/integrations/supabase/client': `import { QueryBuilder } from '@/lib/query-builder';
            const state=()=>globalThis.__xpeedCoachClient;
            export const supabase={from:table=>new QueryBuilder(table,async payload=>{state().requests.push(payload);return {data:payload.action==='insert'?{...payload.values,id:'chat'}:[],error:null}}),
              functions:{invoke:async(name,payload)=>{state().invokes.push({name,...payload});return {data:{reply:'Answer'},error:state().error}}}};`,
          '@/lib/auth/session': 'export const getCurrentUser=async()=>({data:{user:globalThis.__xpeedCoachClient.user},error:null});',
          '@/lib/i18n': 'export default {resolvedLanguage:"en"};',
          '@/lib/db': 'export const getSessions=async()=>[];',
          '@/lib/db-issues': 'export const getIssuesForCar=async()=>[];',
          '@/lib/problems': 'export const describeProblem=()=>({});',
          '@/lib/trips': 'export const tripAverageSpeed=()=>0,tripDate=()=>new Date(),tripDistanceKm=()=>0;',
          '@/lib/db-extras': 'export const listMaintenanceEvents=async()=>[];',
          '@/lib/trends': 'export const computeTrends=()=>[];',
        };
        b.onResolve({ filter: /^@\// }, (a) => a.path in stubs ? { path: a.path, namespace: 'mock' } : { path: resolve(root, 'src', a.path.slice(2) + '.ts') });
        b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: stubs[a.path], loader: 'js' }));
      } }],
    });
    return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  };
  try {
    const prefs = await load('src/lib/sim/coach-preferences.ts');
    await t.test('off by default, account-scoped, reversible and safe with blocked storage', () => {
      assert.equal(prefs.isCoachEnabled('a'), false);
      prefs.setCoachEnabled('a', true); assert.equal(prefs.isCoachEnabled('a'), true); assert.equal(prefs.isCoachEnabled('b'), false);
      prefs.setCoachEnabled('a', false); assert.equal(prefs.isCoachEnabled('a'), false);
      const working = globalThis.localStorage;
      globalThis.localStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
      assert.equal(prefs.isCoachEnabled('a'), false);
      assert.doesNotThrow(() => prefs.setCoachEnabled('a', true));
      globalThis.localStorage = working;
    });
    const db = await load('src/lib/chat/db.ts');
    const scope = { mode: 'virtual', sessionId: 'session', label: 'Monza' };
    await t.test('lists only the requested domain and exact Virtual session', async () => {
      await db.getConversations(); await db.getConversations(scope);
      assert.deepEqual(state.requests[0].filters, [{ column: 'mode', op: 'eq', value: 'real' }, { column: 'sim_session_id', op: 'is', value: null }]);
      assert.deepEqual(state.requests[1].filters, [{ column: 'mode', op: 'eq', value: 'virtual' }, { column: 'sim_session_id', op: 'eq', value: 'session' }]);
    });
    await t.test('Virtual creation never carries the selected Real car', async () => {
      await db.createConversation('Real', 'car'); await db.createConversation('Virtual', 'car', scope);
      assert.deepEqual(state.requests.at(-2).values, { title: 'Real', car_profile_id: 'car', mode: 'real', sim_session_id: null, user_id: 'driver' });
      assert.deepEqual(state.requests.at(-1).values, { title: 'Virtual', car_profile_id: null, mode: 'virtual', sim_session_id: 'session', user_id: 'driver' });
      state.user = null; await assert.rejects(db.createConversation('Anonymous', undefined, scope));
    });
    const ai = await load('src/lib/ai-client.ts');
    const virtual = { mode: 'virtual', sessionId: 'session', conversationId: 'chat', messageId: 'question' };
    await t.test('Virtual sends only references; Real keeps the existing payload', async () => {
      const history = [{ role: 'model', parts: 'prior' }];
      await ai.chatViaEdge(history, 'question', { vehicle: 'car' }, 'car');
      assert.deepEqual(state.invokes.at(-1).body, { history, message: 'question', context: { vehicle: 'car' }, language: 'en', carProfileId: 'car' });
      await ai.chatViaEdge(history, 'question', { vehicle: 'car' }, 'car', virtual);
      assert.deepEqual(state.invokes.at(-1).body, { ...virtual, message: 'question', language: 'en' });
    });
    await t.test('distinguishes missing context, development, outage, configuration and quota', async () => {
      for (const [status, code] of [[404, 'context_not_found'], [503, 'development_disabled'], [503, 'unavailable'], [503, 'not_configured'], [429, 'limit_reached']]) {
        state.error = { context: new Response(JSON.stringify({ code }), { status }) };
        await assert.rejects(ai.chatViaEdge([], 'question', {}, undefined, virtual), (e) => e.kind === code);
      }
    });
  } finally {
    globalThis.localStorage = originalStorage; delete globalThis.__xpeedCoachClient;
  }
});
