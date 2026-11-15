import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import AdminPage from '@/pages/AdminPage';
import { renderSocial, callsTo } from '@/test/social-render';
import { fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { chooseOption } from '@/test/select';
import type { Problem } from '@/lib/problems-client';
import { ProblemsSection } from './ProblemsSection';

const admin = vi.hoisted(() => ({ status: { isAdmin: true, loading: false } }));
vi.mock('@/hooks/use-admin-status', () => ({ useAdminStatus: () => admin.status }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AIProviderSection', () => ({ default: () => <div>AI provider settings</div> }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'boss' } }) }));

const problem = (id: string, extra: Partial<Problem> = {}): Problem => ({
  id, source: 'site', fingerprint: `fp${id}`, firstSeen: '2026-11-14T10:00:00.000Z', lastSeen: '2026-11-15T10:00:00.000Z', count: 12, last24h: 4,
  message: 'TypeError: x is undefined', stack: 'TypeError: x is undefined\n    at render (https://xpeed.skale.club/assets/index.js:10:2345)', route: '/virtual/sessions/:id',
  version: '6ae3b07a1c2d', agent: 'chrome/131 desktop', worker: null, affectedUsers: 3, resolvedAt: null, reopenedCount: 0, ...extra,
});

const ID1 = '40000000-0000-4000-8000-000000000001', ID2 = '40000000-0000-4000-8000-000000000002', ID3 = '40000000-0000-4000-8000-000000000003';

function seeded(): FakeSocialState {
  const state = fakeSocialState();
  state.admin = true;
  state.problems = [
    problem(ID1, { message: 'Older site problem', lastSeen: '2026-11-13T10:00:00.000Z', count: 2, affectedUsers: 1 }),
    problem(ID2, { source: 'companion', message: 'uploader restarted 3 times in 10 minutes: boom', worker: 'uploader', version: '0.8.0', agent: 'windows x86_64', route: null, count: 7, lastSeen: '2026-11-15T11:00:00.000Z', stack: '' }),
    problem(ID3, { message: 'Fixed long ago', resolvedAt: '2026-11-10T10:00:00.000Z', lastSeen: '2026-11-09T10:00:00.000Z' }),
  ];
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

describe('the admin page: Problems', () => {
  it('lists the open problems newest first with source, count, last seen, version and people, and no resolved ones', async () => {
    renderSocial(<ProblemsSection />, { state: seeded(), route: '/admin' });
    const rows = await screen.findAllByTestId('problem');
    expect(rows.map((row) => row.getAttribute('data-problem-id'))).toEqual([ID2, ID1]);
    const first = within(rows[0]);
    expect(first.getByTestId('problem-source')).toHaveTextContent('Companion');
    expect(first.getByTestId('problem-message')).toHaveTextContent('uploader restarted 3 times');
    expect(first.getByTestId('problem-count')).toHaveTextContent('7 times');
    expect(first.getByTestId('problem-version')).toHaveTextContent('Version 0.8.0');
    expect(first.getByTestId('problem-facts')).toHaveTextContent('Worker uploader');
    expect(first.getByTestId('problem-facts')).toHaveTextContent('Last seen');
    expect(first.getByTestId('problem-facts')).toHaveTextContent('3 people');
    expect(within(rows[1]).getByTestId('problem-source')).toHaveTextContent('Site');
    expect(within(rows[1]).getByTestId('problem-facts')).toHaveTextContent('/virtual/sessions/:id');
    expect(screen.queryByText('Fixed long ago')).not.toBeInTheDocument();
  });

  it('opens the sample stack on demand and closes it again', async () => {
    renderSocial(<ProblemsSection />, { state: seeded(), route: '/admin' });
    const [, site] = await screen.findAllByTestId('problem');
    expect(within(site).queryByTestId('problem-stack')).not.toBeInTheDocument();
    fireEvent.click(within(site).getByTestId('problem-toggle'));
    expect(within(site).getByTestId('problem-stack')).toHaveTextContent('at render (https://xpeed.skale.club/assets/index.js:10:2345)');
    expect(within(site).getByTestId('problem-toggle')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(site).getByTestId('problem-toggle'));
    expect(within(site).queryByTestId('problem-stack')).not.toBeInTheDocument();
    // A report with no stack says so.
    const [companion] = screen.getAllByTestId('problem');
    fireEvent.click(within(companion).getByTestId('problem-toggle'));
    expect(within(companion).getByTestId('problem-stack')).toHaveTextContent('No stack was sent.');
  });

  it('marks a problem resolved: the server is told, the problem leaves the open list and is in the resolved one, where it can be reopened', async () => {
    const { state } = renderSocial(<ProblemsSection />, { state: seeded(), route: '/admin' });
    const [row] = await screen.findAllByTestId('problem');
    fireEvent.click(within(row).getByTestId('problem-resolve'));
    await waitFor(() => expect(screen.getAllByTestId('problem')).toHaveLength(1));
    const posts = callsTo(state, 'POST', `/admin/problems/${ID2}`);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ resolved: true });
    expect(screen.queryByText(/uploader restarted/)).not.toBeInTheDocument();
    chooseOption(screen.getByTestId('problems-status'), 'Resolved');
    await waitFor(() => expect(screen.getAllByTestId('problem')).toHaveLength(2));
    const resolvedRows = screen.getAllByTestId('problem');
    expect(resolvedRows.every((r) => within(r).queryByTestId('problem-resolved') !== null)).toBe(true);
    fireEvent.click(within(resolvedRows[0]).getByTestId('problem-reopen'));
    await waitFor(() => expect(callsTo(state, 'POST', `/admin/problems/${ID2}`)).toHaveLength(2));
    expect(callsTo(state, 'POST', `/admin/problems/${ID2}`)[1].body).toEqual({ resolved: false });
  });

  it('says when a resolved problem came back', async () => {
    const state = seeded();
    state.problems = [problem(ID1, { reopenedCount: 2 })];
    renderSocial(<ProblemsSection />, { state, route: '/admin' });
    expect(await screen.findByTestId('problem-reopened')).toHaveTextContent('Came back after being resolved');
  });

  it('says so when there is nothing to fix', async () => {
    const state = fakeSocialState();
    state.admin = true;
    renderSocial(<ProblemsSection />, { state, route: '/admin' });
    expect(await screen.findByTestId('problems-none')).toHaveTextContent('No problems here.');
  });

  it('is part of the admin page, under the AI settings, for an admin', async () => {
    renderSocial(<AdminPage />, { state: seeded(), route: '/admin' });
    expect(screen.getByText('AI provider settings')).toBeInTheDocument();
    expect(await screen.findByTestId('problems-admin')).toHaveTextContent('Problems');
    expect((await screen.findAllByTestId('problem')).length).toBe(2);
  });

  it('is never shown to anybody else and asks the server for nothing; a refusal from the server (not a moderator) is shown as an error, not as data', async () => {
    admin.status = { isAdmin: false, loading: false };
    const hidden = renderSocial(<AdminPage />, { state: seeded(), route: '/admin' });
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByTestId('problems-admin')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(hidden.state.requests).toHaveLength(0);
    hidden.unmount();

    admin.status = { isAdmin: false, loading: true };
    const loading = renderSocial(<ProblemsSection />, { state: seeded() });
    expect(screen.queryByTestId('problems-admin')).not.toBeInTheDocument();
    expect(loading.state.requests).toHaveLength(0);
    loading.unmount();

    admin.status = { isAdmin: true, loading: false };
    const refused = seeded();
    refused.admin = false;
    renderSocial(<ProblemsSection />, { state: refused });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('problem')).not.toBeInTheDocument();
  });
});
