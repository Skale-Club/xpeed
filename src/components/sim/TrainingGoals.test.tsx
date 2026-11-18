import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsProvider } from '@/contexts/SettingsContext';
import i18n from '@/lib/i18n';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';
import { TrainingRequestError } from '@/lib/sim/training-client';
import type { TrainingGoal, TrainingGoalList } from '@/lib/sim/training-types';
import TrainingGoals from './TrainingGoals';

const mock = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), status: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/sim/training-client', () => ({
  listTrainingGoals: mock.list,
  createTrainingGoal: mock.create,
  setTrainingGoalStatus: mock.status,
  deleteTrainingGoal: mock.delete,
  TrainingRequestError: class extends Error {
    constructor(readonly kind: string) { super(kind); }
  },
}));

const goal: TrainingGoal = {
  id: 'goal-a', status: 'active', metric: 'best_lap_ms', title: 'Brake with confidence', notes: 'Focus on rhythm',
  target: 89950, createdAt: '2026-11-18T01:00:00Z', baselineSessionId: 'baseline',
  baseline: {
    sessionId: 'baseline', startedAt: '2026-11-18T00:00:00Z', kind: 'practice', value: 90250,
    weather: null, airTempC: null, trackTempC: null, cleanLaps: 3, lapsUsed: 4, totalLaps: 6, partial: true,
  },
  latest: {
    sessionId: 'later', startedAt: '2026-11-18T02:00:00Z', kind: 'practice', value: 89800,
    weather: 'dry', airTempC: 25, trackTempC: null, cleanLaps: 5, lapsUsed: 5, totalLaps: 5, partial: false,
  },
  reached: true, delta: -450,
};

const list = (goals: TrainingGoal[] = []): TrainingGoalList => ({ goals, limit: 20, truncated: false });
const button = (name: string) => screen.getByRole('button', { name });
const panel = (userId = 'driver', sessionId = 'baseline') => (
  <MemoryRouter><SettingsProvider><TrainingGoals userId={userId} sessionId={sessionId} /></SettingsProvider></MemoryRouter>
);

beforeEach(async () => {
  vi.resetAllMocks();
  leaveDemo();
  await i18n.changeLanguage('en');
  mock.list.mockResolvedValue(list());
  mock.create.mockResolvedValue('goal-a');
  mock.status.mockResolvedValue(undefined);
  mock.delete.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); leaveDemo(); });

async function draftGoal() {
  await screen.findByRole('button', { name: 'New goal' });
  fireEvent.click(button('New goal'));
  fireEvent.change(screen.getByLabelText('Goal name'), { target: { value: 'Brake with confidence' } });
  fireEvent.change(screen.getByLabelText('Target in seconds'), { target: { value: '89,950' } });
  fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Focus on rhythm' } });
}

it('opens, creates in milliseconds and displays measured progress separately from manual status', async () => {
  render(panel());
  await draftGoal();
  expect(mock.create).not.toHaveBeenCalled();
  mock.list.mockResolvedValueOnce(list([goal]));
  fireEvent.click(button('Save goal'));
  expect(await screen.findByText('Goal saved.')).toBeVisible();
  expect(mock.create).toHaveBeenCalledWith('driver', 'baseline', {
    title: 'Brake with confidence', notes: 'Focus on rhythm', target: 89950, metric: 'best_lap_ms',
  }, expect.any(AbortSignal));
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('link', { name: 'Baseline session' })).toHaveAttribute('href', '/virtual/sessions/baseline');
  expect(screen.getByRole('link', { name: 'Latest measured session' })).toHaveAttribute('href', '/virtual/sessions/later');
  expect(screen.getByText('90.25 s')).toBeVisible();
  expect(screen.getByText('89.8 s')).toBeVisible();
  expect(screen.getByText('Change from baseline · -0.45 s')).toBeVisible();
  expect(screen.getByText('Latest measurement meets the target.')).toBeVisible();
  expect(screen.getByText('Active')).toBeVisible();
  expect(screen.getByText(/Partial lap data/)).toBeVisible();
  expect(screen.getByText(/Weather and temperatures unknown/)).toBeVisible();
});

it('supports completing, archiving, reopening and confirmed deletion with a refresh after each', async () => {
  mock.list.mockResolvedValueOnce(list([goal]));
  render(panel());
  const complete = await screen.findByRole('button', { name: 'Mark complete' });
  mock.list.mockResolvedValueOnce(list([{ ...goal, status: 'completed' }]));
  fireEvent.click(complete);
  expect(await screen.findByText('Completed manually')).toBeVisible();
  mock.list.mockResolvedValueOnce(list([{ ...goal, status: 'archived' }]));
  fireEvent.click(button('Archive'));
  expect(await screen.findByText('Archived')).toBeVisible();
  mock.list.mockResolvedValueOnce(list([goal]));
  fireEvent.click(button('Reopen goal'));
  expect(await screen.findByText('Active')).toBeVisible();
  expect(mock.status.mock.calls.map(([, id, status]) => [id, status])).toEqual([
    ['goal-a', 'completed'], ['goal-a', 'archived'], ['goal-a', 'active'],
  ]);
  fireEvent.click(button('Delete goal'));
  const confirmation = await screen.findByRole('alertdialog');
  expect(mock.delete).not.toHaveBeenCalled();
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Delete goal' }));
  expect(await screen.findByText('Goal deleted.')).toBeVisible();
  expect(mock.delete).toHaveBeenCalledWith('driver', 'goal-a', expect.any(AbortSignal));
  expect(mock.list).toHaveBeenCalledTimes(5);
  expect(screen.queryByText(goal.title)).not.toBeInTheDocument();
});

it('shows a friendly eligibility error and retains the draft for correction', async () => {
  mock.create.mockRejectedValueOnce(new TrainingRequestError('insufficient_laps'));
  render(panel());
  await draftGoal();
  fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'consistency_ms' } });
  fireEvent.change(screen.getByLabelText('Target in seconds'), { target: { value: '0.125' } });
  fireEvent.click(button('Save goal'));
  expect(await screen.findByRole('alert')).toHaveTextContent('needs more eligible laps');
  expect(screen.getByLabelText('Goal name')).toHaveValue('Brake with confidence');
  expect(mock.list).toHaveBeenCalledTimes(1);
});

it('refreshes follow-up measurements without closing the panel', async () => {
  mock.list.mockResolvedValueOnce(list([{ ...goal, latest: null, reached: null, delta: null }]));
  render(panel());
  expect(await screen.findByText('Waiting for an eligible follow-up session.')).toBeVisible();
  mock.list.mockResolvedValueOnce(list([goal]));
  fireEvent.click(button('Refresh progress'));
  expect(await screen.findByRole('link', { name: 'Latest measured session' })).toHaveAttribute('href', '/virtual/sessions/later');
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect(mock.create).not.toHaveBeenCalled();
});

it.each([
  ['driver changed', 'other-driver', 'baseline'],
  ['session changed', 'driver', 'another-session'],
] as const)('cancels waiting on a write when the %s and skips a stale refresh', async (_name, userId, sessionId) => {
  let finish!: (id: string) => void;
  mock.create.mockReturnValueOnce(new Promise<string>((resolve) => { finish = resolve; }));
  const view = render(panel());
  await draftGoal();
  fireEvent.click(button('Save goal'));
  await waitFor(() => expect(mock.create).toHaveBeenCalledTimes(1));
  const signal = mock.create.mock.calls[0][3] as AbortSignal;
  view.rerender(panel(userId, sessionId));
  expect(signal.aborted).toBe(true);
  await waitFor(() => expect(mock.list).toHaveBeenLastCalledWith(userId, sessionId, expect.any(AbortSignal)));
  await act(async () => finish('saved-old-goal'));
  expect(mock.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Goal saved.')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Goal name')).not.toBeInTheDocument();
});

it('hides goals when signed out or in the example and discards a late list result', async () => {
  let finish!: (value: TrainingGoalList) => void;
  mock.list.mockReturnValueOnce(new Promise<TrainingGoalList>((resolve) => { finish = resolve; }));
  const view = render(panel(''));
  expect(mock.list).not.toHaveBeenCalled();
  view.rerender(panel());
  await waitFor(() => expect(mock.list).toHaveBeenCalledTimes(1));
  const signal = mock.list.mock.calls[0][2] as AbortSignal;
  await act(async () => enterDemo());
  expect(signal.aborted).toBe(true);
  await act(async () => finish(list([goal])));
  expect(screen.queryByRole('region', { name: 'Training goals' })).not.toBeInTheDocument();
});
