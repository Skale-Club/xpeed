import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import AdminPage from '@/pages/AdminPage';
import { renderSocial, callsTo } from '@/test/social-render';
import { fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { chooseOption } from '@/test/select';
import type { AdminLap, AdminReport } from '@/lib/sim/social-client';
import { RacingAdmin } from './RacingAdmin';

const admin = vi.hoisted(() => ({ status: { isAdmin: true, loading: false } }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => admin.status }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AIProviderSection', () => ({ default: () => <div>AI provider settings</div> }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'boss' } }) }));

const LAP = '10000000-0000-4000-8000-000000000099';
const report = (id: string, extra: Partial<AdminReport> = {}): AdminReport => ({
  id, kind: 'lap', status: 'open', reason: 'cheating', details: 'Impossible sector two', createdAt: '2026-11-12T10:00:00.000Z', decidedAt: null,
  reporter: { handle: 'sharp_eyes', displayName: 'Sharp Eyes' },
  target: { lapId: LAP, game: 'lmu', track: { id: 't1', name: 'Monza' }, car: { id: 'c1', name: 'Ferrari 499P' }, timeMs: 88_000, plausible: false, hidden: false, owner: { handle: 'suspect', displayName: 'Suspect' } },
  ...extra,
});
const profileReport = (id: string): AdminReport => ({
  id, kind: 'profile', status: 'open', reason: 'offensive_name', details: null, createdAt: '2026-11-11T10:00:00.000Z', decidedAt: null,
  reporter: { handle: 'sharp_eyes', displayName: null }, target: { handle: 'rude_one', displayName: 'Rude One', visibility: 'public', hidden: false },
});
const adminLap: AdminLap = {
  lap: {
    id: LAP, game: 'lmu', track: { id: 't1', name: 'Monza' }, car: { id: 'c1', name: 'Ferrari 499P' }, lapNumber: 5, timeMs: 88_000, valid: true, startedAt: '2026-11-10T12:00:00.000Z',
    sectorsMs: [28_000, 20_000, 40_000], topSpeedKmh: 612, sampleCount: 3000, sizeBytes: 100_000, formatVersion: 2, createdAt: '2026-11-10T12:05:00.000Z', marked: false, plausible: false,
    plausibility: { v: 1, failed: [{ check: 'speed_range', detail: { maxSpeed: 170.2, limit: 150 } }, { check: 'sector_sum', detail: { sumMs: 88_000, lapMs: 99_000 } }] }, hidden: false,
  },
  owner: { handle: 'suspect', displayName: 'Suspect', visibility: 'public', hidden: false }, onLeaderboard: false,
  reports: [{ id: 'r1', status: 'open', reason: 'cheating', createdAt: '2026-11-12T10:00:00.000Z' }],
};

function seeded(): FakeSocialState {
  const state = fakeSocialState();
  state.admin = true;
  state.reports = [report('30000000-0000-4000-8000-000000000001'), profileReport('30000000-0000-4000-8000-000000000002'), report('30000000-0000-4000-8000-000000000003', { status: 'dismissed', decidedAt: '2026-11-12T12:00:00.000Z' })];
  state.adminLaps.set(LAP, adminLap);
  return state;
}

beforeEach(async () => {
  admin.status = { isAdmin: true, loading: false };
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reportCards = () => screen.getAllByTestId('admin-report');

describe('the admin page: racing games', () => {
  it('is shown to an admin, under the other admin sections', async () => {
    renderSocial(<AdminPage />, { state: seeded(), route: '/admin' });
    expect(screen.getByText('AI provider settings')).toBeInTheDocument();
    expect(await screen.findByTestId('racing-admin')).toHaveTextContent('Racing games');
    expect(await screen.findByTestId('admin-report-list')).toBeInTheDocument();
  });

  it('is never shown to anybody else, and asks the server for nothing', async () => {
    admin.status = { isAdmin: false, loading: false };
    const { state } = renderSocial(<AdminPage />, { state: seeded(), route: '/admin' });
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByTestId('racing-admin')).not.toBeInTheDocument();
    expect(screen.queryByText('Racing games')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.requests).toHaveLength(0);
  });

  it('is not shown on its own either while the admin check runs or when it says no', async () => {
    admin.status = { isAdmin: false, loading: true };
    const { state, unmount } = renderSocial(<RacingAdmin />, { state: seeded() });
    expect(screen.queryByTestId('racing-admin')).not.toBeInTheDocument();
    unmount();
    admin.status = { isAdmin: false, loading: false };
    renderSocial(<RacingAdmin />, { state });
    expect(screen.queryByTestId('racing-admin')).not.toBeInTheDocument();
    expect(state.requests).toHaveLength(0);
  });

  it('shows the server\'s refusal as an error when someone gets past the check but is not a moderator', async () => {
    const state = seeded();
    state.admin = false;
    renderSocial(<RacingAdmin />, { state });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-report')).not.toBeInTheDocument();
  });
});

describe('the reports', () => {
  it('lists the open reports with the reason, the reporter and the target, by handle and name only', async () => {
    renderSocial(<RacingAdmin />, { state: seeded() });
    await screen.findByTestId('admin-report-list');
    expect(reportCards()).toHaveLength(2); // the dismissed one is not "open"
    expect(reportCards()[0]).toHaveTextContent('Cheating or an impossible time');
    expect(reportCards()[0]).toHaveTextContent('Reported by Sharp Eyes @sharp_eyes');
    expect(reportCards()[0]).toHaveTextContent('Impossible sector two');
    expect(reportCards()[0]).toHaveTextContent('Monza');
    expect(reportCards()[0]).toHaveTextContent('1:28.000');
    expect(reportCards()[0]).toHaveTextContent('@suspect');
    expect(reportCards()[1]).toHaveTextContent('Rude One @rude_one');
    expect(reportCards()[1]).toHaveTextContent('Reported by @sharp_eyes');
    expect(screen.getByTestId('racing-admin').textContent).not.toMatch(/\S+@\S+\.\S+/);
  });

  it('filters by status', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    // The status filter is a compact drop-down with its name inside it.
    const status = screen.getByRole('combobox', { name: 'Show' });
    expect(status).toBe(screen.getByTestId('admin-status'));
    expect(status).toHaveClass('h-8', 'text-xs');
    expect(status).toHaveTextContent(/^ShowOpen$/);
    chooseOption(screen.getByTestId('admin-status'), 'All');
    await waitFor(() => expect(reportCards()).toHaveLength(3));
    expect(callsTo(state, 'GET', '/admin/reports').some((call) => call.params.status === 'all')).toBe(true);
    chooseOption(screen.getByTestId('admin-status'), 'Actioned');
    expect(await screen.findByTestId('admin-no-reports')).toBeInTheDocument();
  });

  it('dismisses a report', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(within(reportCards()[1]).getByTestId('report-dismiss'));
    await waitFor(() => expect(reportCards()).toHaveLength(1));
    expect(callsTo(state, 'POST', '/admin/reports/30000000-0000-4000-8000-000000000002')[0].body).toEqual({ action: 'dismiss' });
  });

  it('marks a report as actioned without hiding anything', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(within(reportCards()[0]).getByTestId('report-action'));
    await waitFor(() => expect(reportCards()).toHaveLength(1));
    expect(callsTo(state, 'POST', '/admin/reports/30000000-0000-4000-8000-000000000001')[0].body).toEqual({ action: 'action' });
  });

  it('actions a report and hides the target', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(within(reportCards()[1]).getByTestId('report-hide'));
    await waitFor(() => expect(reportCards()).toHaveLength(1));
    expect(callsTo(state, 'POST', '/admin/reports/30000000-0000-4000-8000-000000000002')[0].body).toEqual({ action: 'action', hideTarget: true });
    expect(state.reports[1].target).toMatchObject({ hidden: true });
  });

  it('shows a hidden target again from a decided report', async () => {
    const state = seeded();
    state.reports = [{ ...profileReport('30000000-0000-4000-8000-000000000005'), status: 'actioned', target: { handle: 'rude_one', displayName: 'Rude One', visibility: 'public', hidden: true } }];
    renderSocial(<RacingAdmin />, { state });
    chooseOption(await screen.findByTestId('admin-status'), 'Actioned');
    fireEvent.click(await screen.findByTestId('report-unhide'));
    await waitFor(() => expect(callsTo(state, 'POST', '/admin/reports/30000000-0000-4000-8000-000000000005')).toHaveLength(1));
    expect(callsTo(state, 'POST', '/admin/reports/30000000-0000-4000-8000-000000000005')[0].body).toEqual({ action: 'unhide' });
  });

  it('says in words when a report was already decided elsewhere', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    state.reports[0].status = 'dismissed';
    fireEvent.click(within(reportCards()[0]).getByTestId('report-action'));
    expect(await within(reportCards()[0]).findByRole('alert')).toHaveTextContent('This report was already decided.');
  });
});

describe('the lap inspector', () => {
  it('opens from a lap report and shows the lap, the verdict and every failed check with its numbers', async () => {
    renderSocial(<RacingAdmin />, { state: seeded() });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(within(reportCards()[0]).getByTestId('report-inspect'));
    const dialog = await screen.findByTestId('lap-inspector');
    await within(dialog).findByTestId('inspect-time');
    expect(within(dialog).getByTestId('inspect-time')).toHaveTextContent('1:28.000');
    expect(within(dialog).getByTestId('inspect-plausible')).toHaveTextContent('implausible');
    expect(within(dialog).getByTestId('inspect-owner')).toHaveTextContent('Suspect @suspect');
    const checks = within(dialog).getAllByTestId('inspect-check');
    expect(checks).toHaveLength(2);
    expect(checks[0]).toHaveTextContent('speed_range');
    expect(checks[0]).toHaveTextContent('maxSpeed');
    expect(checks[0]).toHaveTextContent('170.2');
    expect(checks[1]).toHaveTextContent('sector_sum');
    expect(within(dialog).getByTestId('inspect-flags')).toHaveTextContent('not on a leaderboard');
    expect(within(dialog).getByTestId('inspect-reports')).toHaveTextContent('Cheating or an impossible time');
  });

  it('opens from a lap id typed in, and says so for an id that is not a lap', async () => {
    renderSocial(<RacingAdmin />, { state: seeded() });
    await screen.findByTestId('admin-report-list');
    const open = screen.getByTestId('inspect-open');
    expect(open).toBeDisabled();
    fireEvent.change(screen.getByTestId('inspect-id'), { target: { value: 'not-an-id' } });
    expect(open).toBeDisabled();
    fireEvent.change(screen.getByTestId('inspect-id'), { target: { value: '10000000-0000-4000-8000-0000000000ff' } });
    fireEvent.click(open);
    expect(await screen.findByTestId('inspect-not-found')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('lap-inspector'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('lap-inspector')).not.toBeInTheDocument());
    fireEvent.change(screen.getByTestId('inspect-id'), { target: { value: LAP } });
    fireEvent.click(open);
    expect(await screen.findByTestId('inspect-time')).toBeInTheDocument();
  });
});

describe('Recheck laps', () => {
  it('calls recheck again and again until nothing remains, with progress', async () => {
    const state = seeded();
    state.recheckRemaining = 120;
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(screen.getByTestId('recheck-run'));
    await waitFor(() => expect(screen.getByTestId('recheck-progress')).toHaveTextContent('Done: 120 laps checked, none left.'));
    const calls = callsTo(state, 'POST', '/admin/recheck');
    expect(calls).toHaveLength(3); // 50, 50, 20
    expect(calls.map((call) => call.body)).toEqual([{ limit: 50 }, { limit: 50 }, { limit: 50 }]);
    expect(state.recheckRemaining).toBe(0);
    expect(screen.getByTestId('recheck-run')).toBeEnabled();
  });

  it('shows the progress between batches', async () => {
    const state = seeded();
    state.recheckRemaining = 100;
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    const seen: string[] = [];
    const watcher = setInterval(() => {
      const node = screen.queryByTestId('recheck-progress');
      if (node?.textContent) seen.push(node.textContent);
    }, 0);
    fireEvent.click(screen.getByTestId('recheck-run'));
    await waitFor(() => expect(screen.getByTestId('recheck-progress')).toHaveTextContent('Done: 100 laps checked'));
    clearInterval(watcher);
    expect(seen.join('|')).toMatch(/50 checked, 50 left|Done/);
  });

  it('finishes at once when there is nothing to check', async () => {
    const state = seeded();
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    fireEvent.click(screen.getByTestId('recheck-run'));
    await waitFor(() => expect(screen.getByTestId('recheck-progress')).toHaveTextContent('Done: 0 laps checked, none left.'));
    expect(callsTo(state, 'POST', '/admin/recheck')).toHaveLength(1);
  });

  it('says in words when the server fails halfway and lets it be run again', async () => {
    const state = seeded();
    state.recheckRemaining = 120;
    renderSocial(<RacingAdmin />, { state });
    await screen.findByTestId('admin-report-list');
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    fireEvent.click(screen.getByTestId('recheck-run'));
    expect(await screen.findByTestId('recheck-error')).toHaveTextContent('Something went wrong on our side.');
    expect(screen.getByTestId('recheck-run')).toBeEnabled();
  });
});
