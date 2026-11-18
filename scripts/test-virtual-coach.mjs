// Pure, network-free checks; Node 24 can load the erasable TypeScript helper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVirtualCoachPrompt, loadVirtualCoachContext, MAX_COACH_LAPS } from '../supabase/functions/_shared/virtual-coach.ts';

import { ids, request, fixture, fakeDb } from './lib/virtual-coach-fixture.mjs';

test('uses only owned session data, verified clean laps and persisted prior history', async () => {
  const db = fakeDb();
  const { evidence, history } = await loadVirtualCoachContext(db, ids.user, request);
  assert.equal(evidence.session.track, 'Monza');
  assert.equal(evidence.insights.summary.bestLapMs, 90000);
  assert.equal(evidence.insights.summary.consistencyMs, 300);
  assert.equal(evidence.insights.lapsUsed, 3);
  assert.equal(evidence.coverage.excludedLaps, 2);
  assert.equal(evidence.coverage.truncated, false);
  assert.deepEqual(history, [{ role: 'model', parts: 'Earlier advice' }]);
  for (const table of ['chat_conversations', 'sim_sessions', 'sim_laps']) {
    assert(db.reads.find((r) => r.table === table).filters.some((f) => f[1] === 'user_id' && f[2] === ids.user));
  }
  assert(!db.reads.some((r) => ['car_profiles', 'sessions', 'vehicle_issues'].includes(r.table)));
});

test('rejects another user, Real conversation, session mismatch and saved-question mismatch', async () => {
  for (const change of [
    (r) => { r.chat_conversations[0].user_id = ids.other; },
    (r) => { r.chat_conversations[0].mode = 'real'; },
    (r) => { r.chat_conversations[0].sim_session_id = ids.car; },
    (r) => { r.sim_sessions[0].user_id = ids.other; },
    (r) => { r.chat_messages[1].parts[0].text = 'Different question'; },
    (r) => { r.chat_messages[1].conversation_id = 'foreign'; },
  ]) {
    const rows = fixture(); change(rows);
    await assert.rejects(loadVirtualCoachContext(fakeDb(rows), ids.user, request), (e) => e.code === 'context_not_found' && e.status === 404);
  }
});

test('database failures fail closed instead of yielding an empty or fallback context', async () => {
  for (const table of [...Object.keys(fixture()), 'sim_coach_context', 'sim_setup_context']) {
    await assert.rejects(loadVirtualCoachContext(fakeDb(fixture(), table), ids.user, request), (e) => e.code === 'unavailable' && e.status === 503);
  }
});

test('coach reads only active saved goals through an owner/session-bound service RPC and cannot mutate them', async () => {
  const rows = fixture();
  rows.sim_coach_goals = Array.from({ length: 6 }, (_, i) => ({ id: `goal-${i}`, title: 'Brake exercise ' + i, notes: 'x'.repeat(1000),
    status: i === 0 ? 'archived' : 'active', metric: 'best_lap_ms', target: 88000, reached: null, delta: null,
    baseline: { sessionId: ids.session, startedAt: '2026-11-18T12:00:00Z', kind: 'practice', value: 90000, weather: 'x'.repeat(10000), secret: 'MUST_NOT_ESCAPE' }, latest: null }));
  const db = fakeDb(rows), { evidence } = await loadVirtualCoachContext(db, ids.user, request);
  assert.deepEqual(db.reads.find((read) => read.table === 'sim_coach_context').args, { p_user_id: ids.user, p_session_id: ids.session });
  assert.equal(evidence.training.activeGoalCount, 5); assert.equal(evidence.training.activeGoals.length, 3);
  assert.equal(evidence.training.activeGoals[0].id, 'goal-1');
  assert.equal(evidence.training.activeGoals[0].notes.length, 300);
  assert.equal(evidence.training.activeGoals[0].baseline.weather.length, 40);
  assert(!JSON.stringify(evidence.training).includes('MUST_NOT_ESCAPE'));
  const prompt = buildVirtualCoachPrompt(evidence, 'en');
  assert.match(prompt, /chat cannot create or complete them/);
  assert.match(prompt, /does not mean the driver has marked the goal completed/);
  assert(!db.reads.some((read) => /goal_create|goal_status|goal_delete/.test(read.table)));
});

test('setup consultation uses only the explicitly associated snapshot, preserves units and separates experiments from proof', async () => {
  const rows = fixture();
  rows.sim_setup_context = { version: { id: 'revision', label: 'Revision 2', notes: 'Entry understeer', parentId: 'baseline',
    parameters: [{ name: 'Front pressure', value: '27.2', unit: 'psi', secret: 'MUST_NOT_ESCAPE' }], runs: [] },
    parent: { id: 'baseline', label: 'Original', notes: '', parentId: null, parameters: [{ name: 'front pressure', value: '27.5', unit: 'psi' }], runs: [] } };
  const db = fakeDb(rows), { evidence } = await loadVirtualCoachContext(db, ids.user, request);
  assert.deepEqual(db.reads.find((r) => r.table === 'sim_setup_context').args, { p_user_id: ids.user, p_session_id: ids.session });
  assert.deepEqual(evidence.setup.changes, [{ name: 'Front pressure', before: '27.5 psi', after: '27.2 psi' }]);
  assert.equal(evidence.setup.source, 'driver_report'); assert(!JSON.stringify(evidence).includes('MUST_NOT_ESCAPE'));
  const prompt = buildVirtualCoachPrompt(evidence, 'en');
  assert.match(prompt, /never invent supported ranges, clicks, exact numerical targets/);
  assert.match(prompt, /cannot prove a setup improved performance/);
  assert(!db.reads.some((r) => /sim_setup_create|sim_setup_attach|sim_setup_delete/.test(r.table)));
  rows.sim_setup_context = { version: null, parent: null };
  assert.equal((await loadVirtualCoachContext(fakeDb(rows), ids.user, request)).evidence.setup.version, null);
});

test('bounds a large session and explicitly identifies partial coverage', async () => {
  const rows = fixture();
  rows.sim_sessions[0].lap_count = 300;
  rows.sim_laps = Array.from({ length: 300 }, (_, i) => ({ ...rows.sim_laps[0], id: `${i}`, lap_number: i + 1 }));
  const { evidence } = await loadVirtualCoachContext(fakeDb(rows), ids.user, request);
  assert.equal(evidence.coverage.inspectedLaps, MAX_COACH_LAPS);
  assert.equal(evidence.coverage.truncated, true);
});

test('empty and unverified sessions do not invent a best or consistency', async () => {
  const rows = fixture(); rows.sim_laps.forEach((lap) => { lap.plausible = null; });
  const { evidence } = await loadVirtualCoachContext(fakeDb(rows), ids.user, request);
  assert.equal(evidence.insights.summary.bestLapMs, null);
  assert.equal(evidence.insights.summary.consistencyMs, null);
  assert.equal(evidence.links.bestLap, null);
});

test('prompt identifies missing telemetry, uncertainty and unsupported actions, within a bounded size', async () => {
  const { evidence } = await loadVirtualCoachContext(fakeDb(), ids.user, request);
  const prompt = buildVirtualCoachPrompt(evidence, 'Brazilian Portuguese');
  assert.match(prompt, /Reply in Brazilian Portuguese/);
  assert.match(prompt, /ONLY when driving.status is ready/);
  assert.match(prompt, /not a complete verified simulator configuration/);
  assert.match(prompt, /Do not claim to save a training plan/);
  assert.match(prompt, /not a guaranteed achievable lap/);
  assert(prompt.length < 10000);
});
