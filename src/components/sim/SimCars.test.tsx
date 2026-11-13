import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { accountLap, stubSimServer } from '@/test/account-laps-fixture';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { SimCars } from './SimCars';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

function renderCars() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/virtual/cars']}>
        <SettingsProvider><SimCars /></SettingsProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let idb: FakeIdb;
beforeEach(async () => {
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  vi.unstubAllGlobals();
});

describe('the cars driven', () => {
  it('are grouped by game and car, with the best valid lap on each track and the last time driven', async () => {
    vi.stubGlobal('fetch', vi.fn(stubSimServer([
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 101_000, startedAt: '2026-11-10T12:00:00.000Z' }),
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 99_500, startedAt: '2026-11-10T12:03:00.000Z' }),
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 90_000, valid: false, startedAt: '2026-11-10T12:06:00.000Z' }),
      accountLap({ track: 'Spa', car: 'Ferrari 499P', timeMs: 140_250, startedAt: '2026-11-11T12:00:00.000Z' }),
      accountLap({ track: 'Monza', car: 'Porsche 911 GT3', timeMs: 105_000, startedAt: '2026-11-09T12:00:00.000Z' }),
      accountLap({ game: 'lmu', track: 'Bahrain', car: 'Toyota GR010', timeMs: 110_000, startedAt: '2026-11-12T12:00:00.000Z' }),
    ])));
    renderCars();
    const games = await screen.findAllByTestId('cars-game');
    expect(games).toHaveLength(2);
    // Alphabetical by game id: Assetto Corsa, then Le Mans Ultimate.
    expect(games[0]).toHaveTextContent('Assetto Corsa');
    expect(games[1]).toHaveTextContent('Le Mans Ultimate');

    const cars = within(games[0]).getAllByTestId('cars-car');
    expect(cars).toHaveLength(2);
    // Driven last first.
    expect(cars[0]).toHaveTextContent('Ferrari 499P');
    expect(cars[0]).toHaveTextContent('Laps: 4');
    expect(cars[0]).toHaveTextContent('Tracks: 2');
    expect(cars[0]).toHaveTextContent(/Last driven .*2026/);
    const tracks = within(cars[0]).getAllByTestId('cars-track');
    expect(tracks[0]).toHaveTextContent('Monza');
    expect(tracks[0]).toHaveTextContent('1:39.500');
    expect(tracks[0]).not.toHaveTextContent('1:30.000');
    expect(tracks[1]).toHaveTextContent('Spa');
    expect(tracks[1]).toHaveTextContent('2:20.250');
    expect(cars[1]).toHaveTextContent('Porsche 911 GT3');
    expect(cars[1]).toHaveTextContent('Tracks: 1');

    expect(within(games[1]).getByTestId('cars-car')).toHaveTextContent('Toyota GR010');
  });

  it('say how to get some when there are none', async () => {
    vi.stubGlobal('fetch', vi.fn(stubSimServer([])));
    renderCars();
    expect(await screen.findByTestId('cars-empty')).toHaveTextContent('No cars yet');
    expect(screen.getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
  });
});
