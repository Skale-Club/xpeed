import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { accountLap, stubSimServer } from '@/test/account-laps-fixture';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { SimOverview } from './SimOverview';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

function renderOverview() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/virtual']}>
        <SettingsProvider><SimOverview /></SettingsProvider>
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

describe('with laps in the account', () => {
  beforeEach(() => {
    const laps = [
      // Monza / Ferrari: a slow valid lap, a quick valid one and a quicker one that does not count.
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 101_000, startedAt: '2026-11-10T12:00:00.000Z', createdAt: '2026-11-10T12:05:00.000Z' }),
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 99_500, startedAt: '2026-11-10T12:03:00.000Z', createdAt: '2026-11-10T12:08:00.000Z' }),
      accountLap({ track: 'Monza', car: 'Ferrari 499P', timeMs: 90_000, valid: false, startedAt: '2026-11-10T12:06:00.000Z', createdAt: '2026-11-10T12:10:00.000Z' }),
      // Spa / Porsche: another game, a different day; the last lap the server received.
      accountLap({ game: 'lmu', track: 'Spa', car: 'Porsche 963', timeMs: 135_000, startedAt: '2026-11-12T18:00:00.000Z', createdAt: '2026-11-12T18:30:00.000Z' }),
    ];
    vi.stubGlobal('fetch', vi.fn(stubSimServer(laps, [{ id: 'd1', name: 'Racing PC', last_seen_at: '2026-11-12T18:31:00.000Z' }])));
  });

  it('shows the Companion card with the computers and the last lap received', async () => {
    renderOverview();
    const card = await screen.findByTestId('overview-companion');
    await waitFor(() => expect(within(card).getAllByTestId('overview-device')).toHaveLength(1));
    expect(within(card).getByTestId('overview-device')).toHaveTextContent('Racing PC');
    expect(within(card).getByTestId('overview-last-lap')).toHaveTextContent('Spa · Porsche 963 · 2:15.000');
    expect(within(card).getByRole('link', { name: /Manage Xpeed Companion/ })).toHaveAttribute('href', '/virtual/companion');
  });

  it('lists the recent sessions, linking to Sessions', async () => {
    renderOverview();
    const list = await screen.findAllByTestId('overview-session');
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveTextContent('Spa');
    expect(list[0]).toHaveTextContent('Laps: 1');
    expect(list[1]).toHaveTextContent('Monza');
    expect(list[1]).toHaveTextContent('Laps: 3');
    expect(list[1]).toHaveTextContent('1:39.500');
    expect(within(list[1]).getByRole('link')).toHaveAttribute('href', '/virtual/sessions');
  });

  it('lists the best valid lap of each game, track and car with a Compare link', async () => {
    renderOverview();
    const best = await screen.findAllByTestId('overview-best-lap');
    expect(best).toHaveLength(2);
    expect(best[0]).toHaveTextContent('Spa');
    expect(best[1]).toHaveTextContent('Monza');
    expect(best[1]).toHaveTextContent('1:39.500');
    expect(best[1]).not.toHaveTextContent('1:30.000');
    expect(within(best[1]).getByRole('link', { name: 'Compare' }).getAttribute('href')).toMatch(/^\/virtual\/compare\?a=ana%7Cac%7CMonza%7CFerrari/);
  });

  it('shows the games played with their laps', async () => {
    renderOverview();
    const games = await screen.findAllByTestId('overview-game');
    expect(games).toHaveLength(2);
    expect(games[0]).toHaveTextContent('Assetto Corsa');
    expect(games[0]).toHaveTextContent('Laps: 3');
    expect(games[1]).toHaveTextContent('Le Mans Ultimate');
    expect(games[1]).toHaveTextContent('Laps: 1');
  });
});

describe('with nothing yet', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(stubSimServer([], [])));
  });

  it('asks to connect Xpeed Companion, in the card and in one line below', async () => {
    renderOverview();
    const card = await screen.findByTestId('overview-companion');
    await waitFor(() => expect(within(card).getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion'));
    expect(await screen.findByTestId('overview-empty')).toHaveTextContent('No laps yet. Connect Xpeed Companion and drive');
    expect(screen.queryByTestId('overview-sessions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-best')).not.toBeInTheDocument();
  });
});
