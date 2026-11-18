// Real client/parser modules with an in-memory RPC boundary; no network or UI runtime.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(pathToFileURL(resolve(process.env.XPEED_TEST_TOOLS_ROOT ?? '.', 'package.json')));
const { build } = require('esbuild');

test('training client binds all work to the displayed account and preserves metric units', async (t) => {
  const state = { user: { id: 'driver-a' }, calls: [], demo: false, error: null };
  globalThis.__trainingClient = state;
  const measurement = { sessionId: 'baseline', startedAt: '2026-11-18T12:00:00Z', kind: 'practice', weather: null, airTempC: null,
    trackTempC: null, value: 90000, lapsUsed: 3, cleanLaps: 3, totalLaps: 3, partial: false };
  const goal = { id: 'goal-a', title: 'Consistent laps', notes: '', metric: 'best_lap_ms', target: 88000, status: 'active',
    createdAt: '2026-11-18T13:00:00Z', baselineSessionId: 'baseline', baseline: measurement, latest: null, reached: null, delta: null };
  state.list = { goals: [goal], limit: 20, truncated: false };
  state.rpc = async (name, args) => {
    state.calls.push({ name, args });
    return { data: name === 'sim_coach_goals' ? state.list : name === 'sim_coach_goal_create' ? 'new-goal' : true, error: state.error };
  };
  const built = await build({ stdin: { contents: "export * from './src/lib/sim/training-client.ts'; export * from './src/lib/sim/training-types.ts';", resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'training-boundary', setup(b) {
      b.onResolve({ filter: /^@\/integrations\/supabase\/client$/ }, () => ({ path: 'db', namespace: 'stub' }));
      b.onResolve({ filter: /^@\/lib\/auth\/session$/ }, () => ({ path: 'auth', namespace: 'stub' }));
      b.onResolve({ filter: /^\.\/demo\/mode$/ }, () => ({ path: 'demo', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: {
        db: 'export const supabase={rpc:(name,args)=>globalThis.__trainingClient.rpc(name,args)};',
        auth: 'export const getCurrentUser=async()=>{const s=globalThis.__trainingClient;return {data:{user:s.users?.length?s.users.shift():s.user}}};',
        demo: 'export const DEMO_USER_ID="demo-driver";export const isDemoMode=()=>globalThis.__trainingClient.demo;',
      }[a.path], loader: 'js' }));
    } }] });
  try {
    const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
    await t.test('duration targets use milliseconds; percentages retain their units', () => {
      for (const [metric, input, expected] of [['best_lap_ms', '88,250', 88250], ['consistency_ms', '0.25', 250],
        ['consistency_ms', '0', 0], ['valid_lap_pct', '92.5', 92.5], ['best_lap_ms', '3600', 3600000],
        ['best_lap_ms', '.9', null], ['consistency_ms', '-1', null], ['valid_lap_pct', '101', null], ['best_lap_ms', '1:30', null],
        ['best_lap_ms', '3601', null], ['best_lap_ms', '', null]]) assert.equal(api.parseTrainingTarget(metric, input), expected);
    });
    await t.test('list parsing strips arbitrary fields and keeps missing progress missing', async () => {
      state.list = { goals: [{ ...goal, secret: 'MUST_NOT_ESCAPE', baseline: { ...measurement, secret: 'MUST_NOT_ESCAPE' } }], limit: 20, truncated: false };
      const result = await api.listTrainingGoals('driver-a', 'session-a');
      assert.deepEqual(state.calls.at(-1), { name: 'sim_coach_goals', args: { p_session_id: 'session-a' } });
      assert.equal(result.goals[0].latest, null); assert.equal(result.goals[0].reached, null);
      assert(!JSON.stringify(result).includes('MUST_NOT_ESCAPE'));
    });
    await t.test('explicit create, status and delete use the expected RPCs without accepting an owner override', async () => {
      assert.equal(await api.createTrainingGoal('driver-a', 'session-a', { title: '  Focus  ', notes: '  Braking  ', metric: 'best_lap_ms', target: 88250 }), 'new-goal');
      assert.deepEqual(state.calls.at(-1), { name: 'sim_coach_goal_create', args: { p_session_id: 'session-a', p_title: 'Focus', p_notes: 'Braking', p_metric: 'best_lap_ms', p_target: 88250 } });
      await api.setTrainingGoalStatus('driver-a', 'goal-a', 'completed');
      assert.deepEqual(state.calls.at(-1), { name: 'sim_coach_goal_status', args: { p_id: 'goal-a', p_status: 'completed' } });
      await api.deleteTrainingGoal('driver-a', 'goal-a');
      assert.deepEqual(state.calls.at(-1), { name: 'sim_coach_goal_delete', args: { p_id: 'goal-a' } });
    });
    await t.test('signed-out, wrong account, demo and pre-aborted work never reaches the server', async () => {
      const before = state.calls.length;
      state.user = null; await assert.rejects(api.listTrainingGoals('driver-a', 'session-a'));
      state.user = { id: 'driver-b' }; await assert.rejects(api.deleteTrainingGoal('driver-a', 'goal-a'));
      state.user = { id: 'driver-a' }; state.demo = true; await assert.rejects(api.listTrainingGoals('driver-a', 'session-a')); state.demo = false;
      const controller = new AbortController(); controller.abort();
      await assert.rejects(api.createTrainingGoal('driver-a', 'session-a', { title: 'Focus', notes: '', metric: 'best_lap_ms', target: 88000 }, controller.signal));
      assert.equal(state.calls.length, before);
    });
    await t.test('late account changes discard results', async () => {
      state.users = [{ id: 'driver-a' }, { id: 'driver-b' }];
      await assert.rejects(api.listTrainingGoals('driver-a', 'session-a'), (e) => e.kind === 'unavailable');
    });
    await t.test('an in-flight cancellation stops waiting without claiming the submitted write was undone', async () => {
      let started, finish;
      const dispatched = new Promise((resolve) => { started = resolve; });
      const oldRpc = state.rpc;
      state.rpc = (name, args) => { state.calls.push({ name, args }); started(); return new Promise((resolve) => { finish = resolve; }); };
      const controller = new AbortController();
      const operation = api.setTrainingGoalStatus('driver-a', 'goal-a', 'archived', controller.signal);
      await dispatched; controller.abort(); await assert.rejects(operation, (e) => e.kind === 'unavailable');
      finish({ data: true, error: null }); state.rpc = oldRpc;
      assert.equal(state.calls.at(-1).name, 'sim_coach_goal_status');
    });
    await t.test('only allowlisted user-action errors escape the database boundary', async () => {
      for (const kind of ['insufficient_laps', 'goal_limit', 'invalid_goal']) {
        state.error = { message: kind, code: 'P0001' };
        await assert.rejects(api.listTrainingGoals('driver-a', 'session-a'), (e) => e.kind === kind);
      }
      state.error = { message: 'internal database SQL with private values' };
      await assert.rejects(api.listTrainingGoals('driver-a', 'session-a'), (e) => e.message === 'unavailable'); state.error = null;
      state.list = { goals: [{ ...goal, baseline: { ...measurement, value: Infinity } }], limit: 20, truncated: false };
      await assert.rejects(api.listTrainingGoals('driver-a', 'session-a'), (e) => e.kind === 'unavailable');
    });
  } finally { delete globalThis.__trainingClient; }
});

test('Virtual privacy export includes only the authenticated owner training goals and fails on incomplete reads', async (t) => {
  const state = { user: 'driver-a', filters: [], goalReads: 0, failed: false };
  globalThis.__trainingExport = state;
  const built = await build({ entryPoints: ['api/sim/_social.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{ name: 'privacy-boundary', setup(b) {
      b.onResolve({ filter: /^\.\.\/_backend$/ }, () => ({ path: 'backend', namespace: 'stub' }));
      b.onResolve({ filter: /^\.\/_plausibility$/ }, () => ({ path: 'plausibility', namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: a.path === 'plausibility' ? 'export const recheckLaps=async()=>{};' : `
        const s=()=>globalThis.__trainingExport;
        export const openBackend=()=>({userId:async()=>s().user,service:{
          rpc:async(name,args)=>{if(name==='sim_companion_export_chat'){s().chatExportActor=args.p_user;return{data:{conversations:[{id:'virtual-chat'}],messages:[]},error:null}}return{data:name==='sim_rate_hit'?0:{laps:[],trackLayouts:[],sessions:[]},error:null}},
          from:table=>{const answer=()=>{s().goalReads++;return s().failed?{data:null,error:{message:'simulated database failure'}}:{data:table==='sim_coach_goals'?[{id:'goal-a',title:'Practice focus'}]:[],error:null}};
            const q={select:columns=>{if(table==='sim_coach_goals')s().columns=columns;return q},eq:(column,value)=>{s().filters.push({table,column,value});return q},
            order:async()=>answer(),then:(ok,bad)=>Promise.resolve(answer()).then(ok,bad)};return q}
        }});`, loader: 'js' }));
    } }] });
  try {
    const { handleSocial } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
    const send = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
    const run = () => handleSocial(new Request('https://xpeed.test/api/sim/v1/me/export', { headers: { Authorization: 'Bearer simulated-sign-in' } }), ['me', 'export'],
      { send, problem: (error, status) => send({ error }, status), empty: () => new Response(null, { status: 204 }) });
    await t.test('export keeps existing data and adds an explicitly owner-filtered goal projection', async () => {
      const response = await run(); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.format, 'xpeed-virtual-export'); assert.deepEqual(body.sessions, []);
      assert.deepEqual(body.trainingGoals, [{ id: 'goal-a', title: 'Practice focus' }]);
      assert.deepEqual(state.filters, ['sim_coach_goals','sim_setup_versions','sim_session_setups'].map(table=>({ table, column: 'user_id', value: 'driver-a' })));
      assert.deepEqual(body.setupVersions,[]); assert.deepEqual(body.sessionSetups,[]);
      assert.equal(state.chatExportActor,'driver-a');assert.deepEqual(body.coachChats,{conversations:[{id:'virtual-chat'}],messages:[]});
      assert(!state.columns.includes('*')); assert.match(state.columns, /source_session_id/);
    });
    await t.test('an invalid sign-in cannot read goals', async () => {
      state.user = null; const before = state.goalReads; assert.equal((await run()).status, 401); assert.equal(state.goalReads, before); state.user = 'driver-a';
    });
    await t.test('a goal storage outage does not produce an apparently complete export', async () => {
      state.failed = true; const response = await run(); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'unavailable' });
    });
  } finally { delete globalThis.__trainingExport; }
});
