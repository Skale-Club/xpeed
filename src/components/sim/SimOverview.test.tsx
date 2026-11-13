import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session } from '@/test/v1-fake-server';
import { SimCars } from './SimCars';
import { SimOverview } from './SimOverview';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('Overview', () => {
  it('shows the Companion connection, recent sessions, best laps and games from one call, and downloads no lap file', async () => {
    const session = v1Session({ track: monza, car: ferrari, lapCount: 2, bestLapMs: 99_000 });
    const fast = v1Lap({ track: monza, car: ferrari, sessionId: session.id, timeMs: 99_000, createdAt: '2026-11-12T10:00:00.000Z' });
    const slow = v1Lap({ track: monza, car: ferrari, sessionId: session.id, timeMs: 101_000, createdAt: '2026-11-12T09:00:00.000Z' });
    const state = fakeV1State({
      sessions: [session],
      laps: [fast, slow],
      devices: [{ id: 'd1', name: 'Racing PC', pairedAt: '2026-11-01T00:00:00.000Z', lastSeenAt: new Date().toISOString(), lastLapAt: null }],
    });
    renderSim(<SimOverview />, { state, route: '/virtual' });

    expect(await screen.findByTestId('overview-device')).toHaveTextContent('Racing PC');
    expect(screen.getByTestId('overview-last-lap')).toHaveTextContent('Monza · Ferrari 499P · 1:39.000');
    expect(within(screen.getByTestId('overview-session')).getByRole('link')).toHaveAttribute('href', `/virtual/sessions/${session.id}`);
    expect(screen.getByTestId('overview-best-lap')).toHaveTextContent('1:39.000');
    expect(within(screen.getByTestId('overview-best-lap')).getByRole('link')).toHaveAttribute('href', `/virtual/compare?a=${fast.id}`);
    expect(screen.getByTestId('overview-game')).toHaveTextContent('Le Mans Ultimate');
    expect(state.requests.map((request) => request.path)).toEqual(['/overview']);
  });

  it('invites to connect Xpeed Companion when there is nothing', async () => {
    renderSim(<SimOverview />, { state: fakeV1State(), route: '/virtual' });
    const empty = await screen.findByTestId('overview-empty');
    expect(within(empty).getByRole('link', { name: 'Get Xpeed Companion' })).toHaveAttribute('href', '/companion');
    expect(within(screen.getByTestId('overview-companion')).getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
  });

  it('says the server is not answering, which is not an empty account', async () => {
    const state = fakeV1State();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSim(<SimOverview />, { state, route: '/virtual' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-empty')).not.toBeInTheDocument();
  });
});

describe('Game cars', () => {
  it('lists the cars by game with their best valid lap', async () => {
    const state = fakeV1State({
      cars: [
        { id: ferrari.id, game: 'lmu', name: ferrari.name, brand: null, class: null, lapCount: 8, validLapCount: 6, sessionCount: 2, trackCount: 3, bestLapMs: 99_000, lastDrivenAt: '2026-11-12T10:00:00.000Z' },
        { id: 'c2', game: 'ac', name: 'Porsche 911 GT3 R', brand: null, class: null, lapCount: 1, validLapCount: 0, sessionCount: 1, trackCount: 1, bestLapMs: null, lastDrivenAt: '2026-11-11T10:00:00.000Z' },
      ],
    });
    renderSim(<SimCars />, { state, route: '/virtual/cars' });
    await waitFor(() => expect(screen.getAllByTestId('cars-game')).toHaveLength(2));
    const [lmu, ac] = screen.getAllByTestId('cars-car');
    expect(lmu).toHaveTextContent('Ferrari 499P');
    expect(lmu).toHaveTextContent('Laps: 8');
    expect(lmu).toHaveTextContent('1:39.000');
    expect(ac).toHaveTextContent('Porsche 911 GT3 R');
    expect(ac).toHaveTextContent('–');
  });

  it('invites to connect Xpeed Companion when there are no cars', async () => {
    renderSim(<SimCars />, { state: fakeV1State(), route: '/virtual/cars' });
    expect(await screen.findByTestId('cars-empty')).toHaveTextContent('No cars yet');
  });
});
