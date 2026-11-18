import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeDb, fixture, ids } from './lib/virtual-coach-fixture.mjs';

const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? '.', 'package.json')));
const { build } = require('esbuild');

test('trip summaries and receipt OCR obey the same explicit billing choice', async (t) => {
  const state = {};
  const oldDeno = globalThis.Deno, oldFetch = globalThis.fetch;
  globalThis.__xpeedConsumerTest = state;
  globalThis.Deno = { env: { get: (name) => name === 'NODE_ENV' ? state.environment
    : name === 'AI_CREDENTIAL_ENCRYPTION_KEY' ? Buffer.alloc(32, 7).toString('base64') : 'test-placeholder' } };
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: ['global/model', 'personal/model'].map((id) => ({ id,
      architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['structured_outputs'] })) }));
    const body = JSON.parse(options.body); state.calls.push({ body, headers: options.headers });
    const content = state.consumer === 'read-fuel-receipt'
      ? { totalPaid: 20, quantity: 5, currency: 'USD', volumeUnit: 'US gal' }
      : { summary: 'Normal trip.', key_findings: [], recommended_action: 'No action.', warnings: [] };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: state.providerStatus });
  };
  try {
    for (const consumer of ['analyze-session', 'read-fuel-receipt']) {
      const built = await build({ stdin: { contents: `import './supabase/functions/${consumer}/index.ts'; export {encryptPersonalKey} from './supabase/functions/_shared/ai-provider.ts';`, resolveDir: process.cwd(), loader: 'ts' },
        bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'consumer-boundaries', setup(b) {
          b.onResolve({ filter: /^npm:zod@/ }, () => ({ path: require.resolve('zod') }));
          b.onResolve({ filter: /^https:\/\/deno\.land\/.*server\.ts$/ }, () => ({ path: 'serve', namespace: 'mock' }));
          b.onResolve({ filter: /^https:\/\/esm\.sh\/@supabase/ }, () => ({ path: 'supabase', namespace: 'mock' }));
          b.onResolve({ filter: /\/(quota|admin-config)\.ts$/ }, (a) => ({ path: /([^/]+)\.ts$/.exec(a.path)[1], namespace: 'mock' }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({ contents: {
            serve: 'export const serve=h=>{globalThis.__xpeedConsumerTest.handler=h};',
            supabase: 'export const createClient=()=>globalThis.__xpeedConsumerTest.db;',
            quota: 'const s=()=>globalThis.__xpeedConsumerTest;export const getUserIdFromAuth=async()=>s().user;export const getServiceClient=()=>s().db;export const consumeQuota=async()=>{s().spent++};export const refundQuota=async()=>{s().refunded++};',
            'admin-config': 'export const getOpenRouterApiKey=async()=>"fake-platform-key";export const getDefaultModel=async()=>"global/model";',
          }[a.path], loader: 'js' }));
        } }] });
      const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
      for (const source of ['global', 'personal']) {
        for (const providerStatus of [200, 402]) await t.test(`${consumer}: ${source} / upstream ${providerStatus}`, async () => {
          Object.assign(state, { consumer, user: ids.user, spent: 0, refunded: 0, calls: [], environment: 'production', providerStatus });
          const rows = fixture();
          rows.sessions = [{ id: ids.session, user_id: ids.user, car_profile_id: ids.car, report: { vehicle: {}, session: {}, diagnostics: {}, parameters: [] } }];
          rows.vehicle_issues = []; rows.car_profiles = [{ id: ids.car, user_id: ids.user }];
          if (source === 'personal') {
            const encrypted = await api.encryptPersonalKey(ids.user, 'fake-personal-key');
            rows.user_ai_preferences = [{ user_id: ids.user, mode: 'personal', model: 'personal/model', api_key_ciphertext: encrypted.ciphertext, api_key_iv: encrypted.iv }];
          }
          state.db = fakeDb(rows);
          const body = consumer === 'analyze-session' ? { sessionId: ids.session } : { carId: ids.car,
            image: 'data:image/jpeg;base64,' + btoa('\xff\xd8\xff' + 'x'.repeat(20)) };
          const call = () => state.handler(new Request('https://xpeed.test/api/fn/' + consumer, { method: 'POST', body: JSON.stringify(body) }));
          const response = await call();
          assert.equal(response.status, providerStatus === 200 ? 200 : source === 'personal' ? 402 : 502);
          assert.equal(state.calls.length, 1);
          assert.equal(state.calls[0].body.model, source + '/model');
          assert.equal(state.calls[0].headers.Authorization, source === 'personal' ? 'Bearer fake-personal-key' : 'Bearer fake-platform-key');
          assert.equal(state.spent, source === 'global' ? 1 : 0);
          assert.equal(state.refunded, source === 'global' && providerStatus !== 200 ? 1 : 0);
          if (source === 'personal') {
            state.environment = 'development'; state.calls = [];
            assert.equal((await call()).status, 503); assert.equal(state.calls.length, 0);
          }
        });
      }
    }
  } finally { globalThis.Deno = oldDeno; globalThis.fetch = oldFetch; delete globalThis.__xpeedConsumerTest; }
});
