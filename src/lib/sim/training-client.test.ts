import { beforeEach, expect, it, vi } from 'vitest';
import { parseTrainingTarget, type TrainingGoal, type TrainingMeasurement } from './training-types';
import { createTrainingGoal, deleteTrainingGoal, listTrainingGoals, setTrainingGoalStatus } from './training-client';

const mock = vi.hoisted(() => ({ userId: 'driver', demo: false, rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mock.rpc } }));
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: async () => ({ data: { user: mock.userId ? { id: mock.userId } : null }, error: null }),
}));
vi.mock('./demo/mode', () => ({ DEMO_USER_ID: 'example', isDemoMode: () => mock.demo }));

const baseline: TrainingMeasurement = {
  sessionId: 'baseline', startedAt: '2026-11-18T00:00:00Z', kind: 'practice',
  weather: null, airTempC: null, trackTempC: null, value: 90233,
  lapsUsed: 5, cleanLaps: 4, totalLaps: 6, partial: false,
};
const goal: TrainingGoal = {
  id: 'goal-id', title: 'First goal', notes: '', metric: 'best_lap_ms', target: 89999, status: 'active',
  createdAt: '2026-11-18T01:00:00Z', baselineSessionId: baseline.sessionId, baseline, latest: null, reached: null, delta: null,
};
const list = { goals: [goal], limit: 20, truncated: false };

beforeEach(() => {
  mock.userId = 'driver';
  mock.demo = false;
  mock.rpc.mockReset();
});

it('converts locale decimals and validates the metric-specific target ranges', () => {
  expect(parseTrainingTarget('best_lap_ms', '89,999')).toBe(89999);
  expect(parseTrainingTarget('best_lap_ms', '0.999')).toBeNull();
  expect(parseTrainingTarget('best_lap_ms', '3600')).toBe(3600000);
  expect(parseTrainingTarget('best_lap_ms', '3600.001')).toBeNull();
  expect(parseTrainingTarget('consistency_ms', '0')).toBe(0);
  expect(parseTrainingTarget('consistency_ms', '.125')).toBe(125);
  expect(parseTrainingTarget('valid_lap_pct', '97,5')).toBe(97.5);
  expect(parseTrainingTarget('valid_lap_pct', '100.01')).toBeNull();
  expect(parseTrainingTarget('valid_lap_pct', '2e1')).toBeNull();
  expect(parseTrainingTarget('valid_lap_pct', '-1')).toBeNull();
});

it('uses the four owner-scoped RPCs with session or goal identifiers', async () => {
  mock.rpc.mockResolvedValueOnce({ data: { ...list, goals: [{ ...goal, ignored: 'internal result field' }] }, error: null });
  expect(await listTrainingGoals('driver', 'baseline')).toEqual(list);
  mock.rpc.mockResolvedValueOnce({ data: 'goal-id', error: null });
  expect(await createTrainingGoal('driver', 'baseline', {
    title: ' First goal ', notes: ' Note ', metric: 'best_lap_ms', target: 89999,
  })).toBe('goal-id');
  mock.rpc.mockResolvedValue({ data: true, error: null });
  await setTrainingGoalStatus('driver', 'goal-id', 'completed');
  await deleteTrainingGoal('driver', 'goal-id');
  expect(mock.rpc.mock.calls).toEqual([
    ['sim_coach_goals', { p_session_id: 'baseline' }],
    ['sim_coach_goal_create', { p_session_id: 'baseline', p_title: 'First goal', p_metric: 'best_lap_ms', p_target: 89999, p_notes: 'Note' }],
    ['sim_coach_goal_status', { p_id: 'goal-id', p_status: 'completed' }],
    ['sim_coach_goal_delete', { p_id: 'goal-id' }],
  ]);
});

it('returns only mapped safe failures and treats a false mutation reply as unavailable', async () => {
  mock.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'insufficient_laps', details: 'private detail' } });
  await expect(listTrainingGoals('driver', 'baseline')).rejects.toMatchObject({ kind: 'insufficient_laps', message: 'insufficient_laps' });
  mock.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'private DB detail' } });
  await expect(listTrainingGoals('driver', 'baseline')).rejects.toMatchObject({ kind: 'unavailable', message: 'unavailable' });
  mock.rpc.mockResolvedValueOnce({ data: false, error: null });
  await expect(deleteTrainingGoal('driver', 'goal-id')).rejects.toMatchObject({ kind: 'unavailable' });
});

it('blocks demo, signed-out or mismatched actors and already-aborted requests', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(listTrainingGoals('driver', 'baseline', controller.signal)).rejects.toMatchObject({ kind: 'unavailable' });
  await expect(listTrainingGoals('another-driver', 'baseline')).rejects.toMatchObject({ kind: 'unavailable' });
  mock.userId = '';
  await expect(deleteTrainingGoal('driver', 'goal-id')).rejects.toMatchObject({ kind: 'unavailable' });
  mock.demo = true;
  mock.userId = 'driver';
  await expect(setTrainingGoalStatus('driver', 'goal-id', 'archived')).rejects.toMatchObject({ kind: 'unavailable' });
  expect(mock.rpc).not.toHaveBeenCalled();
});

it('rejects a response arriving after abort or an actor switch', async () => {
  let finish!: (value: { data: typeof list; error: null }) => void;
  mock.rpc.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const controller = new AbortController();
  const aborted = listTrainingGoals('driver', 'baseline', controller.signal);
  await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ kind: 'unavailable' });
  finish({ data: list, error: null });

  mock.rpc.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const changed = listTrainingGoals('driver', 'baseline');
  await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(2));
  mock.userId = 'new-driver';
  finish({ data: list, error: null });
  await expect(changed).rejects.toMatchObject({ kind: 'unavailable' });
});
