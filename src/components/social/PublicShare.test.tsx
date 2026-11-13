import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { gzipLap } from '@/lib/sim/lap-file';
import { makeLapFixtures } from '@/test/lap-fixture';
import { renderSocial } from '@/test/social-render';
import { fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import type { PublicLapShare, PublicSessionShare } from '@/lib/sim/social-client';
import { PublicSharePage } from './PublicShare';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));
// The page must work with nobody signed in: a sign-in token that is asked for at all fails the test.
const token = vi.hoisted(() => ({ asked: 0 }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => { token.asked++; return 'must-not-be-sent'; } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));

const lap: PublicLapShare = {
  kind: 'lap', createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null,
  driver: { handle: 'lap_fan', displayName: 'Lap Fan' },
  lap: {
    id: '10000000-0000-4000-8000-000000000001', game: 'lmu', track: { name: 'Monza', lengthM: 5793 }, car: { name: 'Ferrari 499P', class: 'Hypercar' }, lapNumber: 4,
    timeMs: 99_432, valid: true, startedAt: '2026-11-10T12:00:00.000Z', sectorsMs: [28_000, 41_000, 30_432], topSpeedKmh: 318.4,
  },
};
const session: PublicSessionShare = {
  kind: 'session', createdAt: '2026-11-13T10:00:00.000Z', expiresAt: null, driver: { handle: 'lap_fan', displayName: 'Lap Fan' },
  session: {
    game: 'lmu', track: { name: 'Spa-Francorchamps', lengthM: 7004 }, car: { name: 'Toyota GR010', class: null }, kind: 'qualifying', startedAt: '2026-11-10T15:00:00.000Z',
    endedAt: '2026-11-10T15:30:00.000Z', weather: 'dry', airTempC: 21, trackTempC: 27, lapCount: 3, bestLapMs: 134_100,
    laps: [
      { id: '10000000-0000-4000-8000-000000000011', lapNumber: 1, timeMs: 140_000, valid: true, startedAt: '2026-11-10T15:00:00.000Z', sectorsMs: [40_000, 60_000, 40_000], topSpeedKmh: 300 },
      { id: '10000000-0000-4000-8000-000000000012', lapNumber: 2, timeMs: 130_000, valid: false, startedAt: '2026-11-10T15:03:00.000Z', sectorsMs: null, topSpeedKmh: null },
      { id: '10000000-0000-4000-8000-000000000013', lapNumber: 3, timeMs: 134_100, valid: true, startedAt: '2026-11-10T15:06:00.000Z', sectorsMs: [39_000, 57_000, 38_100], topSpeedKmh: 305 },
    ],
  },
};

function stateWith(...shares: Array<[string, PublicLapShare | PublicSessionShare]>): FakeSocialState {
  const state = fakeSocialState();
  for (const [name, share] of shares) state.publicTokens.set(name, share);
  return state;
}
const open = (state: FakeSocialState, tokenName: string) =>
  renderSocial(<Routes><Route path="/s/:token" element={<PublicSharePage />} /></Routes>, { state, route: `/s/${tokenName}` });

beforeEach(async () => {
  token.asked = 0;
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the public share page', () => {
  it('shows a shared lap: track, car, game, time, sectors, the driver, and the Xpeed Companion banner', async () => {
    open(stateWith(['lapone', lap]), 'lapone');
    await screen.findByTestId('public-lap');
    expect(screen.getByTestId('public-track')).toHaveTextContent('Monza');
    expect(screen.getByTestId('public-car')).toHaveTextContent('Ferrari 499P');
    expect(screen.getByTestId('public-time')).toHaveTextContent('1:39.432');
    expect(screen.getByTestId('public-lap')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('public-lap')).toHaveTextContent('Lap 4');
    expect(screen.getByTestId('public-lap')).toHaveTextContent('top speed 318 km/h');
    expect(screen.getByTestId('driver-display-name')).toHaveTextContent('Lap Fan');
    expect(screen.getByTestId('driver-handle')).toHaveTextContent('@lap_fan');
    const sectors = within(screen.getByTestId('sector-strip')).getAllByTestId('sector');
    expect(sectors.map((cell) => cell.textContent)).toEqual(['S128.000', 'S241.000', 'S330.432']);
    const banner = screen.getByTestId('companion-banner');
    expect(banner).toHaveTextContent('Want to record your own laps? Get Xpeed Companion');
    expect(within(banner).getByRole('link')).toHaveAttribute('href', '/companion');
  });

  it('shows "Anonymous driver" when the owner is private (no driver at all in the answer)', async () => {
    open(stateWith(['anon', { ...lap, driver: null }]), 'anon');
    await screen.findByTestId('public-lap');
    expect(screen.getByTestId('driver-anonymous')).toHaveTextContent('Anonymous driver');
    expect(screen.queryByTestId('driver-handle')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('lap_fan');
  });

  it('shows the handle alone for a driver with no display name, and never a name that looks like an e-mail', async () => {
    open(stateWith(['bare', { ...lap, driver: { handle: 'lap_fan', displayName: null } }], ['mail', { ...lap, driver: { handle: 'lap_fan', displayName: 'ana@example.com' } }]), 'bare');
    await screen.findByTestId('public-lap');
    expect(screen.queryByTestId('driver-display-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('driver-handle')).toHaveTextContent('@lap_fan');
    cleanup();
    open(stateWith(['mail', { ...lap, driver: { handle: 'lap_fan', displayName: 'ana@example.com' } }]), 'mail');
    await screen.findByTestId('public-lap');
    expect(document.body.textContent).not.toContain('ana@example.com');
  });

  it('shows a shared session: its header, the laps with sectors and the best lap marked', async () => {
    open(stateWith(['sess', session]), 'sess');
    await screen.findByTestId('public-session');
    expect(screen.getByTestId('public-track')).toHaveTextContent('Spa-Francorchamps');
    expect(screen.getByTestId('public-best')).toHaveTextContent('2:14.100');
    const rows = screen.getAllByTestId('public-lap-row');
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveTextContent('Best lap');
    expect(rows[1]).toHaveTextContent('not valid');
    expect(rows[0]).toHaveTextContent('40.000');
    expect(screen.getByTestId('public-session')).toHaveTextContent('Qualifying');
    expect(screen.getByTestId('companion-banner')).toBeInTheDocument();
  });

  it('shows one neutral "This link is not available" page for a link that does not exist, is revoked or expired', async () => {
    const state = fakeSocialState();
    open(state, 'unknown');
    expect(await screen.findByTestId('public-unavailable')).toHaveTextContent('This link is not available');
    expect(screen.queryByTestId('public-lap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('public-error')).not.toBeInTheDocument();
    // The banner is still there for whoever landed here.
    expect(screen.getByTestId('companion-banner')).toBeInTheDocument();
  });

  it('says in words when too many links are opened from one address, and offers to try again', async () => {
    const state = stateWith(['lapone', lap]);
    state.failing = { status: 429, error: 'too_many_requests', retryable: true };
    open(state, 'lapone');
    expect(await screen.findByTestId('public-error')).toHaveTextContent('Too many people are opening links');
    state.failing = null;
    fireEvent.click(within(screen.getByTestId('public-error')).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('public-lap');
  });

  it('is an error, not "not available", when the server is down', async () => {
    const state = stateWith(['lapone', lap]);
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    open(state, 'lapone');
    expect(await screen.findByTestId('public-error')).toHaveTextContent('The page could not be loaded');
    expect(screen.queryByTestId('public-unavailable')).not.toBeInTheDocument();
  });

  it('sends no Authorization header and never asks for a sign-in, for the page and for the lap file', async () => {
    const [slow] = makeLapFixtures();
    const state = stateWith(['lapone', lap]);
    state.publicFiles.set(lap.lap.id, await gzipLap(slow));
    const { fetchSpy } = open(state, 'lapone');
    await screen.findByTestId('speed-trace');
    const publicCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/sim/public/share/'));
    expect(publicCalls.length).toBeGreaterThanOrEqual(2); // the page and the file
    for (const [, init] of publicCalls as Array<[string, RequestInit | undefined]>) {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      expect(init?.credentials).toBe('omit');
    }
    expect(state.requests.every((request) => request.authorization === null)).toBe(true);
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes('/api/sim/v1/'))).toBe(true);
    expect(token.asked).toBe(0);
  });

  it('draws a speed trace from the lap file, read lazily, with the strict reader', async () => {
    const [slow] = makeLapFixtures();
    const state = stateWith(['lapone', lap]);
    state.publicFiles.set(lap.lap.id, await gzipLap(slow));
    open(state, 'lapone');
    // The page is there before the trace is.
    await screen.findByTestId('public-lap');
    const trace = await screen.findByTestId('speed-trace');
    expect(Number(trace.getAttribute('data-points'))).toBeGreaterThan(50);
    expect(Number(trace.getAttribute('data-points'))).toBeLessThanOrEqual(300);
    expect(state.requests.some((request) => request.path.endsWith(`/file/${lap.lap.id}`))).toBe(true);
  });

  it('keeps the page and says the trace is not available when the file is not a lap file', async () => {
    const state = stateWith(['lapone', lap]);
    state.publicFiles.set(lap.lap.id, new TextEncoder().encode('this is not a lap'));
    open(state, 'lapone');
    expect(await screen.findByTestId('trace-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('public-time')).toHaveTextContent('1:39.432');
  });

  it('on a session, draws the trace of the best lap first and of any lap picked', async () => {
    const [slow, fast] = makeLapFixtures();
    const state = stateWith(['sess', session]);
    state.publicFiles.set(session.session.laps[2].id, await gzipLap(fast));
    state.publicFiles.set(session.session.laps[0].id, await gzipLap(slow));
    open(state, 'sess');
    await screen.findByTestId('speed-trace');
    expect(state.requests.filter((request) => request.path.includes('/file/')).map((request) => request.path.split('/').pop())).toEqual([session.session.laps[2].id]);
    fireEvent.click(screen.getAllByTestId('public-trace-pick')[0]);
    await waitFor(() => expect(state.requests.some((request) => request.path.endsWith(session.session.laps[0].id))).toBe(true));
    expect(await screen.findByTestId('speed-trace')).toBeInTheDocument();
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    open(stateWith(['lapone', lap]), 'lapone');
    await screen.findByTestId('public-lap');
    expect(screen.getByTestId('companion-banner')).toHaveTextContent('Quer gravar suas próprias voltas?');
    expect(screen.getByTestId('sector-strip')).toHaveTextContent('Setores');
  });
});
