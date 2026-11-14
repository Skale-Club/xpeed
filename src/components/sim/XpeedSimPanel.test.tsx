import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';
import { fakeV1Fetch, fakeV1State, ref, v1Lap, type FakeV1State } from '@/test/v1-fake-server';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const api = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/sim/xpeed-sim-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/xpeed-sim-api')>()),
  listDevices: api.list,
  revokeDevice: api.revoke,
}));

import { XpeedSimApiError } from '@/lib/sim/xpeed-sim-api';
import { XpeedSimPanel } from './XpeedSimPanel';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const device = (over: Partial<SimDevice> = {}): SimDevice => ({
  id: 'd1', name: 'RIG', created_at: '2026-11-01T10:00:00.000Z', last_seen_at: minutesAgo(2),
  last_lap_at: minutesAgo(30), revoked_at: null, ...over,
});

const release = { version: '0.5.0', build: 'abc1234', downloadUrl: 'https://xpeed.test/api/companion/download', sha256: 'a'.repeat(64), size: 3145728, releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.4.0', signed: false };

/** The racing data API (for the games and the last lap) and the release endpoint, answered from memory. */
function stubFetch(options: { v1?: FakeV1State; release?: object | null; v1Down?: boolean } = {}) {
  const v1 = fakeV1Fetch(options.v1 ?? fakeV1State());
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/companion/latest') {
      return options.release === null ? Promise.reject(new TypeError('offline')) : ({ ok: true, status: 200, json: () => Promise.resolve(options.release ?? release) } as Response);
    }
    if (options.v1Down) return new Response(JSON.stringify({ error: 'unavailable', retryable: true }), { status: 503 });
    return v1(input, init);
  }));
}

const renderPanel = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsProvider><XpeedSimPanel /></SettingsProvider>
    </QueryClientProvider>,
  );

beforeEach(async () => {
  api.list.mockReset().mockResolvedValue([]);
  api.revoke.mockReset().mockResolvedValue({ revoked: true });
  stubFetch();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('connecting a computer', () => {
  it('explains how to connect, and offers no code, command or link to copy', async () => {
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(steps).toHaveTextContent('Install Xpeed Companion on the PC where you play.');
    expect(steps).toHaveTextContent('Open it and click Connect to your account.');
    expect(screen.getByText('How to connect')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pairing code/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new code/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-command')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="xpeedsim"]')).toBeNull();
  });

  it('ticks the steps as the person gets on: nothing connected, then a computer, then laps', async () => {
    renderPanel();
    await screen.findByTestId('devices-empty');
    expect(['step-install', 'step-connect', 'step-drive'].map((id) => screen.getByTestId(id).getAttribute('data-state'))).toEqual(['todo', 'todo', 'todo']);
    cleanup();
    api.list.mockResolvedValue([device()]);
    renderPanel();
    await screen.findByTestId('device');
    expect(['step-connect', 'step-drive'].map((id) => screen.getByTestId(id).getAttribute('data-state'))).toEqual(['done', 'done']); // it sent a lap
  });

  it('tells the story in three parts: it reads your game, it sends each lap, you see it here', async () => {
    renderPanel();
    const how = await screen.findByTestId('companion-how');
    expect(how).toHaveTextContent('It reads your game');
    expect(how).toHaveTextContent('It sends each lap');
    expect(how).toHaveTextContent('You see it here');
  });
});

describe('the computers already connected', () => {
  it('says so when there are none', async () => {
    renderPanel();
    expect(await screen.findByTestId('devices-empty')).toHaveTextContent('No computer is connected yet.');
  });

  it('shows each computer as a card: Online or Offline by when it was last seen, and when it last sent a lap', async () => {
    api.list.mockResolvedValue([
      device(),
      device({ id: 'd2', name: 'LAPTOP', last_seen_at: minutesAgo(60 * 48), last_lap_at: minutesAgo(60 * 49) }),
      device({ id: 'd3', name: 'NEW PC', last_seen_at: null, last_lap_at: null }),
      device({ id: 'd4', name: 'OLD PC', revoked_at: '2026-11-05T10:00:00.000Z', last_seen_at: '2026-11-04T10:00:00.000Z' }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    expect(cards).toHaveLength(4);
    const byName = (name: string) => cards.find((card) => within(card).getByTestId('device-name').textContent === name)!;
    expect(within(byName('RIG')).getByTestId('device-state')).toHaveTextContent('Online');
    expect(byName('RIG')).toHaveAttribute('data-state', 'online');
    expect(byName('RIG')).toHaveTextContent(/Last lap sent/);
    expect(within(byName('LAPTOP')).getByTestId('device-state')).toHaveTextContent('Offline');
    expect(byName('LAPTOP')).toHaveTextContent(/Last seen .*2 days ago/);
    expect(within(byName('NEW PC')).getByTestId('device-state')).toHaveTextContent('Offline');
    expect(byName('NEW PC')).toHaveTextContent('Never seen');
    expect(byName('NEW PC')).toHaveTextContent('No laps sent yet');
    expect(within(byName('OLD PC')).getByTestId('device-state')).toHaveTextContent('Revoked');
    // Only a live computer can be revoked.
    expect(within(byName('RIG')).getByRole('button', { name: /Revoke/ })).toBeInTheDocument();
    expect(within(byName('OLD PC')).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
  });

  it('puts the computers that are online first, and the revoked ones in a fold of their own', async () => {
    api.list.mockResolvedValue([
      device({ id: 'd2', name: 'LAPTOP', last_seen_at: minutesAgo(60 * 48) }),
      device({ id: 'd1', name: 'RIG' }),
      device({ id: 'd4', name: 'OLD PC', revoked_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    renderPanel();
    await screen.findAllByTestId('device');
    const live = within(screen.getByTestId('device-list')).getAllByTestId('device-name').map((node) => node.textContent);
    expect(live).toEqual(['RIG', 'LAPTOP']);
    expect(within(screen.getByTestId('devices-revoked')).getByTestId('device-name')).toHaveTextContent('OLD PC');
    expect(screen.getByTestId('devices-revoked')).toHaveTextContent('Revoked computers: 1');
    expect(screen.getByTestId('devices-summary')).toHaveTextContent('Computers: 2 · online now: 1');
  });

  it('shows the last lap received on the card of the computer that sent it', async () => {
    const state = fakeV1State({ laps: [v1Lap({ track: ref('Monza'), car: ref('Ferrari 499P'), timeMs: 99_432, deviceName: 'RIG' })] });
    stubFetch({ v1: state });
    api.list.mockResolvedValue([device(), device({ id: 'd2', name: 'LAPTOP' })]);
    renderPanel();
    const rig = (await screen.findAllByTestId('device')).find((card) => card.textContent?.includes('RIG'))!;
    expect(await within(rig).findByTestId('device-lap-detail')).toHaveTextContent('Monza · Ferrari 499P · 1:39.432');
    const laptop = screen.getAllByTestId('device').find((card) => card.textContent?.includes('LAPTOP'))!;
    expect(within(laptop).queryByTestId('device-lap-detail')).not.toBeInTheDocument();
  });

  it('revokes one after asking, and reads the list again', async () => {
    api.list.mockResolvedValueOnce([device()]).mockResolvedValue([device({ revoked_at: '2026-11-10T11:00:00.000Z' })]);
    renderPanel();
    fireEvent.click(within(await screen.findByTestId('device')).getByRole('button', { name: /Revoke/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Revoke RIG?');
    expect(api.revoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.getByTestId('device-state')).toHaveTextContent('Revoked'));
  });

  it('keeps the computer when the question is answered with cancel', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    fireEvent.click(within(await screen.findByTestId('device')).getByRole('button', { name: /Revoke/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it('says when the list cannot be read, with a retry, and not "no computer is connected"', async () => {
    api.list.mockRejectedValueOnce(new XpeedSimApiError('unavailable')).mockResolvedValue([device()]);
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached');
    expect(screen.queryByTestId('devices-empty')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('devices-retry'));
    expect(await screen.findByTestId('device')).toBeInTheDocument();
  });

  it('shows a placeholder shaped like the cards while the list is read', async () => {
    api.list.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(await screen.findByTestId('devices-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('devices-empty')).not.toBeInTheDocument();
  });
});

describe('the games Xpeed Companion supports', () => {
  it('lists the certified games first (Assetto Corsa, Automobilista 2), then the beta ones', async () => {
    renderPanel();
    const rows = await screen.findAllByTestId('game-row');
    const certified = within(screen.getByTestId('games-certified')).getAllByTestId('game-row').map((row) => row.getAttribute('data-game'));
    expect(certified).toEqual(['ac', 'ams2']);
    expect(rows.slice(0, 2).map((row) => row.getAttribute('data-tier'))).toEqual(['certified', 'certified']);
    expect(rows.slice(2).every((row) => row.getAttribute('data-tier') === 'beta')).toBe(true);
    expect(within(screen.getByTestId('games-certified')).getByText('Assetto Corsa')).toBeInTheDocument();
    expect(within(screen.getByTestId('games-certified')).getByText('Automobilista 2')).toBeInTheDocument();
    expect(screen.getByTestId('games-beta')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('games-certified')).toHaveTextContent('Certified');
    expect(screen.getByTestId('games-beta')).toHaveTextContent('Beta');
  });

  it('says for each game how many laps the account has and when it was last driven, or that it has none', async () => {
    const state = fakeV1State({ laps: [v1Lap({ game: 'ac', startedAt: minutesAgo(60 * 24 * 3) }), v1Lap({ game: 'ac', startedAt: minutesAgo(60 * 24 * 4) }), v1Lap({ game: 'lmu' })] });
    stubFetch({ v1: state });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-game="ac"]')).toHaveAttribute('data-laps', '2'));
    const ac = document.querySelector('[data-game="ac"]') as HTMLElement;
    expect(within(ac).getByTestId('game-status')).toHaveTextContent(/2 laps · last driven .*3 days ago/);
    expect(within(document.querySelector('[data-game="ams2"]') as HTMLElement).getByTestId('game-status')).toHaveTextContent('No laps yet');
    expect(within(document.querySelector('[data-game="lmu"]') as HTMLElement).getByTestId('game-status')).toHaveTextContent('1 laps');
  });

  it('adds a game the account has laps in that is not on the list, as beta, and keeps the list when the numbers cannot be read', async () => {
    stubFetch({ v1: fakeV1State({ laps: [v1Lap({ game: 'rfactor1' })] }) });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-game="rfactor1"]')).toBeInTheDocument());
    expect(document.querySelector('[data-game="rfactor1"]')).toHaveAttribute('data-tier', 'beta');
    cleanup();
    stubFetch({ v1Down: true });
    renderPanel();
    await screen.findAllByTestId('game-row');
    expect(screen.queryAllByTestId('game-status')).toHaveLength(0); // the list stays, the numbers do not pretend
  });
});

describe('the download step', () => {
  it('links step 1 to the public Companion page and shows the latest version', async () => {
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(within(steps).getByTestId('companion-page-link')).toHaveAttribute('href', '/companion');
    expect(await within(steps).findByTestId('companion-latest')).toHaveTextContent('latest: 0.5.0');
    expect(steps).toHaveTextContent('Install Xpeed Companion on the PC where you play.');
  });

  it('keeps the link when the version cannot be read', async () => {
    stubFetch({ release: null });
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(within(steps).getByTestId('companion-page-link')).toHaveAttribute('href', '/companion');
    expect(within(steps).queryByTestId('companion-latest')).not.toBeInTheDocument();
    expect(await screen.findByTestId('companion-download-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('companion-download-button')).toHaveAttribute('href', '/api/companion/download');
  });

  it('has a download card with the version, the size, the day and the SHA-256, and a warning while the installer is not signed', async () => {
    renderPanel();
    const card = await screen.findByTestId('companion-download-card');
    await waitFor(() => expect(within(card).getByTestId('companion-download-meta')).toHaveTextContent('Version 0.5.0 · 3.0 MB · Released'));
    expect(within(card).getByTestId('companion-download-meta')).toHaveTextContent(/2026/);
    expect(within(card).getByTestId('companion-sha-value')).toHaveTextContent('a'.repeat(64));
    expect(within(card).getByTestId('companion-smartscreen')).toBeInTheDocument();
    expect(within(card).getByTestId('companion-download-button')).toHaveAttribute('href', '/api/companion/download');
  });

  it('copies the checksum, and has no warning for a signed installer', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    stubFetch({ release: { ...release, signed: true } });
    renderPanel();
    fireEvent.click(await screen.findByTestId('companion-sha-copy'));
    await waitFor(() => expect(screen.getByTestId('companion-sha-copy')).toHaveTextContent('Checksum copied'));
    expect(writeText).toHaveBeenCalledWith('a'.repeat(64));
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });
});

describe('the Companion screen is translated', () => {
  it('speaks Portuguese: the states, the games and the story', async () => {
    await i18n.changeLanguage('pt-BR');
    api.list.mockResolvedValue([device()]);
    renderPanel();
    expect(await screen.findByTestId('device-state')).toHaveTextContent('Online');
    expect(screen.getByTestId('companion-how')).toHaveTextContent('Lê o seu jogo');
    expect(screen.getByTestId('games-certified')).toHaveTextContent('Certificados');
  });

  it('speaks Spanish', async () => {
    await i18n.changeLanguage('es-ES');
    api.list.mockResolvedValue([device({ last_seen_at: minutesAgo(60 * 48) })]);
    renderPanel();
    expect(await screen.findByTestId('device-state')).toHaveTextContent('Sin conexión');
    expect(screen.getByTestId('companion-how')).toHaveTextContent('Lee tu juego');
  });
});
