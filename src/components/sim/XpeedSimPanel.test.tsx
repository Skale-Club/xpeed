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

const release = { version: '0.7.0', build: 'abc1234', downloadUrl: 'https://xpeed.test/api/companion/download', sha256: 'a'.repeat(64), size: 3_458_048, releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.6.0', signed: false };

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

const startDetails = () => screen.getByTestId('companion-start-details') as HTMLDetailsElement;
const byName = (cards: HTMLElement[], name: string) => cards.find((card) => within(card).getByTestId('device-name').textContent === name)!;

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

describe('getting started', () => {
  it('is ONE card with three numbered steps: install, open and connect, drive a lap', async () => {
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(screen.getAllByTestId('companion-start')).toHaveLength(1);
    expect(screen.getByText('Get started')).toBeInTheDocument();
    expect([...steps.children].map((step) => step.getAttribute('data-testid'))).toEqual(['step-install', 'step-connect', 'step-drive']);
    expect([...steps.children].map((step) => step.querySelector('span')?.textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByTestId('step-install')).toHaveTextContent('Install Xpeed Companion on the PC where you play.');
    expect(screen.getByTestId('step-connect')).toHaveTextContent('Open it and click Connect to your account. Your browser asks you once to confirm.');
    expect(screen.getByTestId('step-drive')).toHaveTextContent('Start a game and drive a lap.');
    // The old second copy of the story is gone.
    expect(screen.queryByTestId('companion-how')).not.toBeInTheDocument();
    expect(screen.queryByText('How it works')).not.toBeInTheDocument();
  });

  it('offers no code, command or link to copy', async () => {
    renderPanel();
    await screen.findByTestId('how-to-connect');
    expect(screen.queryByRole('button', { name: /pairing code/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new code/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-command')).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="xpeedsim"]')).toBeNull();
  });

  it('is open when no computer is connected', async () => {
    renderPanel();
    await screen.findByTestId('devices-empty');
    await waitFor(() => expect(startDetails().open).toBe(true));
  });

  it('is open when the list of computers cannot be read (nothing is known to be connected)', async () => {
    api.list.mockRejectedValue(new XpeedSimApiError('unavailable'));
    renderPanel();
    await screen.findByTestId('devices-retry');
    await waitFor(() => expect(startDetails().open).toBe(true));
  });

  it('is folded away when a computer is connected, so a returning person sees their computers first, and is one click from opening', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    await screen.findByTestId('device');
    expect(startDetails().open).toBe(false);
    expect(startDetails()).toHaveTextContent('Get started'); // the summary is still there to click
    fireEvent.click(startDetails().querySelector('summary')!);
    startDetails().open = true; // jsdom does not toggle a details on click
    expect(startDetails().open).toBe(true);
  });

  it('counts only computers that can still send laps: a person with only a disconnected computer sees the steps open', async () => {
    api.list.mockResolvedValue([device({ revoked_at: '2026-11-05T10:00:00.000Z' })]);
    renderPanel();
    await screen.findByTestId('devices-revoked');
    await waitFor(() => expect(startDetails().open).toBe(true));
  });
});

describe('the download', () => {
  it('is ONE yellow button to /api/companion/download, with the version and the size beside it', async () => {
    renderPanel();
    const button = await screen.findByTestId('companion-download-button');
    expect(button).toHaveAttribute('href', '/api/companion/download');
    expect(button).toHaveTextContent('Download for Windows');
    await waitFor(() => expect(screen.getByTestId('companion-download-meta')).toHaveTextContent(/^Version 0\.7\.0 · 3\.3 MB$/));
  });

  it('is not repeated: no second link to it, no link to the public page, no "latest" tag in the steps', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    await screen.findByTestId('companion-download-button');
    await screen.findByTestId('companion-download-meta');
    expect(document.querySelectorAll('a[href="/api/companion/download"]')).toHaveLength(1);
    expect(document.querySelectorAll('a[href$="/download"], a[href="/companion"]')).toHaveLength(1);
    expect(screen.queryByTestId('companion-page-link')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-latest')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-download-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Download it here')).not.toBeInTheDocument();
    expect(screen.queryByText(/latest: /)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Version 0\.7\.0/).filter((node) => node.closest('[data-testid="companion-download"]'))).toHaveLength(1);
  });

  it('shows no "Released" date', async () => {
    renderPanel();
    await screen.findByTestId('companion-download-meta');
    await waitFor(() => expect(screen.getByTestId('companion-download-meta')).toHaveTextContent('Version 0.7.0'));
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/Released/);
    expect(screen.getByTestId('companion-download-meta').textContent).not.toMatch(/2026/);
  });

  it('keeps the button, and says so gently, when the version cannot be read', async () => {
    stubFetch({ release: null });
    renderPanel();
    expect(await screen.findByTestId('companion-download-unavailable')).toHaveTextContent('The download still works.');
    expect(screen.getByTestId('companion-download-button')).toHaveAttribute('href', '/api/companion/download');
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });

  it('warns, in one short calm note, about the unknown publisher only while the installer is not signed', async () => {
    renderPanel();
    const note = await screen.findByTestId('companion-smartscreen');
    expect(note).toHaveTextContent('Windows may say the publisher is unknown. Click More info, then Run anyway.');
    expect(note.textContent!.length).toBeLessThan(110);
    expect(note).not.toHaveTextContent(/checksum/i);
    cleanup();
    stubFetch({ release: { ...release, signed: true } });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('companion-download-meta')).toHaveTextContent('Version 0.7.0'));
    expect(screen.queryByTestId('companion-smartscreen')).not.toBeInTheDocument();
  });

  it('never shows a checksum, even when the release says one: no hash, no copy button, no PowerShell text, no "check the file" fold', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('companion-download-meta')).toHaveTextContent('Version 0.7.0'));
    const panel = screen.getByTestId('companion-panel');
    expect(release.sha256).toHaveLength(64); // /api/companion/latest does carry it
    expect(panel.innerHTML).not.toContain(release.sha256);
    expect(panel.textContent).not.toMatch(/SHA-?256|checksum|Get-FileHash|PowerShell|Check the file/i);
    expect(screen.queryByRole('button', { name: /checksum/i })).not.toBeInTheDocument();
    expect(panel.querySelector('code')).toBeNull();
    expect(screen.queryByTestId('companion-sha')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-sha-value')).not.toBeInTheDocument();
    expect(screen.queryByTestId('companion-sha-copy')).not.toBeInTheDocument();
  });
});

describe('your computers', () => {
  it('says so when there are none, with no footnotes', async () => {
    renderPanel();
    expect(await screen.findByTestId('devices-empty')).toHaveTextContent('No computer is connected yet.');
    expect(screen.queryByTestId('devices-hint')).not.toBeInTheDocument();
  });

  it('shows each computer as a compact card: Online or Offline by when it was last seen, Disconnected when it was disconnected', async () => {
    api.list.mockResolvedValue([
      device(),
      device({ id: 'd2', name: 'LAPTOP', last_seen_at: minutesAgo(60 * 48), last_lap_at: minutesAgo(60 * 49) }),
      device({ id: 'd3', name: 'NEW PC', last_seen_at: null, last_lap_at: null }),
      device({ id: 'd4', name: 'OLD PC', revoked_at: '2026-11-05T10:00:00.000Z', last_seen_at: '2026-11-04T10:00:00.000Z' }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    expect(cards).toHaveLength(4);
    expect(within(byName(cards, 'RIG')).getByTestId('device-state')).toHaveTextContent('Online');
    expect(byName(cards, 'RIG')).toHaveAttribute('data-state', 'online');
    expect(within(byName(cards, 'LAPTOP')).getByTestId('device-state')).toHaveTextContent('Offline');
    expect(byName(cards, 'LAPTOP')).toHaveTextContent(/Last seen .*2 days ago/);
    expect(within(byName(cards, 'NEW PC')).getByTestId('device-state')).toHaveTextContent('Offline');
    expect(byName(cards, 'NEW PC')).toHaveTextContent('Never seen');
    expect(byName(cards, 'NEW PC')).toHaveTextContent('No laps sent yet');
    expect(within(byName(cards, 'OLD PC')).getByTestId('device-state')).toHaveTextContent('Disconnected');
    // Only a computer that can still send laps can be disconnected.
    expect(within(byName(cards, 'RIG')).getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
    expect(within(byName(cards, 'OLD PC')).queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/Revoke/);
  });

  it('keeps ONE of each fact: no "Connected <date>" next to "Last seen", and one last-lap line (not three)', async () => {
    api.list.mockResolvedValue([device(), device({ id: 'd2', name: 'LAPTOP', last_seen_at: minutesAgo(60 * 48) })]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    for (const card of cards) {
      expect(within(card).queryByTestId('device-paired')).not.toBeInTheDocument();
      expect(card.textContent).not.toMatch(/Connected 1 Nov|Connected Nov/);
      expect(within(card).getAllByTestId('device-last-lap')).toHaveLength(1);
      expect(card.textContent).not.toMatch(/Last lap sent|Last lap received/);
    }
    // Last seen is said once, and only for a computer that is not online (an online one is, by definition, just seen).
    expect(within(byName(cards, 'RIG')).queryByTestId('device-seen')).not.toBeInTheDocument();
    expect(within(byName(cards, 'LAPTOP')).getAllByTestId('device-seen')).toHaveLength(1);
  });

  it('calls a computer online for three minutes after the server heard from it, with no footnote about it', async () => {
    api.list.mockResolvedValue([
      device({ id: 'd1', name: 'JUST NOW', last_seen_at: minutesAgo(0.5) }),
      device({ id: 'd2', name: 'TWO MIN', last_seen_at: minutesAgo(2) }),
      device({ id: 'd3', name: 'FIVE MIN', last_seen_at: minutesAgo(5) }),
      device({ id: 'd4', name: 'TEN MIN', last_seen_at: minutesAgo(10) }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    const stateOf = (name: string) => byName(cards, name).getAttribute('data-state');
    expect(['JUST NOW', 'TWO MIN', 'FIVE MIN', 'TEN MIN'].map(stateOf)).toEqual(['online', 'online', 'offline', 'offline']);
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/Online means|in the last 3 minutes|in the last 10 minutes/);
    expect(screen.queryByTestId('devices-summary')).not.toBeInTheDocument();
  });

  it('puts the computers that are online first, and the disconnected ones in a fold of their own', async () => {
    api.list.mockResolvedValue([
      device({ id: 'd2', name: 'LAPTOP', last_seen_at: minutesAgo(60 * 48) }),
      device({ id: 'd1', name: 'RIG' }),
      device({ id: 'd4', name: 'OLD PC', revoked_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    renderPanel();
    await screen.findAllByTestId('device');
    const live = within(screen.getByTestId('device-list')).getAllByTestId('device-name').map((node) => node.textContent);
    expect(live).toEqual(['RIG', 'LAPTOP']);
    const fold = screen.getByTestId('devices-revoked') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(within(fold).getByTestId('device-name')).toHaveTextContent('OLD PC');
    expect(fold).toHaveTextContent('Disconnected computers: 1');
  });

  it('has one muted line, at most, about adding another computer (and the limit of 10), and no other footnote', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    await screen.findByTestId('device');
    const hint = screen.getByTestId('devices-hint');
    expect(hint).toHaveTextContent('To add another computer (up to 10), open Xpeed Companion on it and click Connect to your account.');
    expect(screen.queryByText('You can connect up to 10 computers.')).not.toBeInTheDocument();
    expect(screen.getByTestId('companion-devices').querySelectorAll('p.text-xs')).toHaveLength(1);
  });

  it('shows the version on a computer, and what it is doing while it is online: connected to a game, waiting for one, or paused', async () => {
    api.list.mockResolvedValue([
      device({ id: 'd1', name: 'DRIVING', companion_version: '0.7.0', last_state: 'connected', last_game: 'ams2', last_state_at: minutesAgo(12) }),
      device({ id: 'd2', name: 'WAITING', companion_version: '0.7.0', last_state: 'waiting', last_game: null }),
      device({ id: 'd3', name: 'PAUSED', companion_version: '0.7.0', last_state: 'idle', last_game: null }),
      device({ id: 'd4', name: 'UNKNOWN GAME', companion_version: '0.7.0', last_state: 'connected', last_game: 'newgame' }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    expect(within(byName(cards, 'DRIVING')).getByTestId('device-activity')).toHaveTextContent('Connected to Automobilista 2');
    expect(within(byName(cards, 'DRIVING')).getByTestId('device-activity')).toHaveAttribute('data-activity', 'connected');
    expect(within(byName(cards, 'WAITING')).getByTestId('device-activity')).toHaveTextContent('Waiting for a game');
    expect(within(byName(cards, 'PAUSED')).getByTestId('device-activity')).toHaveTextContent('Reading paused');
    expect(within(byName(cards, 'UNKNOWN GAME')).getByTestId('device-activity')).toHaveTextContent(/^Connected to NEWGAME$/);
    for (const name of ['DRIVING', 'WAITING', 'PAUSED']) expect(within(byName(cards, name)).getByTestId('device-version')).toHaveTextContent('Version 0.7.0');
  });

  it('shows no state for a computer that is not online (what it said is old), but still its version', async () => {
    api.list.mockResolvedValue([
      device({ id: 'd1', name: 'SWITCHED OFF', last_seen_at: minutesAgo(30), companion_version: '0.7.0', last_state: 'connected', last_game: 'ac' }),
      device({ id: 'd2', name: 'GONE', revoked_at: '2026-11-05T10:00:00.000Z', companion_version: '0.6.0', last_state: 'connected', last_game: 'ac' }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    expect(cards.some((card) => card.querySelector('[data-testid="device-activity"]'))).toBe(false);
    expect(within(byName(cards, 'SWITCHED OFF')).getByTestId('device-version')).toHaveTextContent('0.7.0');
    expect(within(byName(cards, 'SWITCHED OFF')).getByTestId('device-state')).toHaveTextContent('Offline');
  });

  it('shows neither version nor state for a computer an older server or Xpeed Companion knows nothing about, and decides online by when it was seen', async () => {
    api.list.mockResolvedValue([device({ id: 'd1', name: 'OLD' }), device({ id: 'd2', name: 'NULLS', companion_version: null, last_state: null, last_game: null, last_state_at: null })]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(within(card).getByTestId('device-state')).toHaveTextContent('Online');
      expect(within(card).queryByTestId('device-version')).not.toBeInTheDocument();
      expect(within(card).queryByTestId('device-activity')).not.toBeInTheDocument();
      expect(within(card).queryByTestId('device-update')).not.toBeInTheDocument();
    }
  });

  it('hints, gently, that an update is available when the computer runs an older Xpeed Companion than the newest, and not otherwise', async () => {
    // The newest, in these tests, is 0.7.0.
    api.list.mockResolvedValue([
      device({ id: 'd1', name: 'OLDER', companion_version: '0.6.2' }),
      device({ id: 'd2', name: 'CURRENT', companion_version: '0.7.0' }),
      device({ id: 'd3', name: 'NEWER', companion_version: '0.8.0' }),
      device({ id: 'd4', name: 'ODD', companion_version: 'dev-build' as never }),
      device({ id: 'd5', name: 'REVOKED', revoked_at: '2026-11-05T10:00:00.000Z', companion_version: '0.3.0' }),
    ]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    await waitFor(() => expect(within(byName(cards, 'OLDER')).getByTestId('device-update')).toHaveTextContent('Update available: 0.7.0. It installs by itself when no game is running.'));
    for (const name of ['CURRENT', 'NEWER', 'ODD', 'REVOKED']) expect(within(byName(cards, name)).queryByTestId('device-update'), name).not.toBeInTheDocument();
    // A hint, not an alarm: no button, no alert role.
    expect(within(byName(cards, 'OLDER')).getByTestId('device-update').getAttribute('role')).toBeNull();
    expect(within(byName(cards, 'OLDER')).queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
  });

  it('gives no update hint when the newest version cannot be read', async () => {
    stubFetch({ release: null });
    api.list.mockResolvedValue([device({ companion_version: '0.1.0' })]);
    renderPanel();
    const card = await screen.findByTestId('device');
    expect(within(card).getByTestId('device-version')).toHaveTextContent('0.1.0');
    await screen.findByTestId('companion-download-unavailable');
    expect(within(card).queryByTestId('device-update')).not.toBeInTheDocument();
  });

  it('says the last lap in ONE line on the card of the computer that sent it: the lap and when it arrived', async () => {
    const state = fakeV1State({ laps: [v1Lap({ track: ref('Monza'), car: ref('Ferrari 499P'), timeMs: 99_432, deviceName: 'RIG' })] });
    stubFetch({ v1: state });
    api.list.mockResolvedValue([device(), device({ id: 'd2', name: 'LAPTOP' })]);
    renderPanel();
    const cards = await screen.findAllByTestId('device');
    await waitFor(() => expect(within(byName(cards, 'RIG')).getByTestId('device-last-lap')).toHaveTextContent('Last lap: Monza · Ferrari 499P · 1:39.432 · 30 minutes ago'));
    // Another computer has no lap to name, but still says when its last lap arrived, in the same single line.
    expect(within(byName(cards, 'LAPTOP')).getByTestId('device-last-lap')).toHaveTextContent(/^Last lap: 30 minutes ago$/);
  });

  it('disconnects one after asking, and reads the list again', async () => {
    api.list.mockResolvedValueOnce([device()]).mockResolvedValue([device({ revoked_at: '2026-11-10T11:00:00.000Z' })]);
    renderPanel();
    fireEvent.click(within(await screen.findByTestId('device')).getByRole('button', { name: /Disconnect/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Disconnect RIG?');
    expect(api.revoke).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(screen.getByTestId('device-state')).toHaveTextContent('Disconnected'));
  });

  it('keeps the computer when the question is answered with cancel', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    fireEvent.click(within(await screen.findByTestId('device')).getByRole('button', { name: /Disconnect/ }));
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
  it('lists the certified games first (Assetto Corsa, Automobilista 2), then the beta ones, a line each', async () => {
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

  it('explains Beta in one sentence', async () => {
    renderPanel();
    await screen.findAllByTestId('game-row');
    const note = screen.getByTestId('games-beta').querySelector('p')!;
    expect(note).toHaveTextContent('Beta games are supported but not fully checked yet, so some data may be missing.');
    expect(note.textContent!.match(/[.!?]/g)).toHaveLength(1);
    expect(screen.getByTestId('games-certified').querySelector('p')).toBeNull();
  });

  it('says for each game how many laps the account has, or that it has none, with the right plural', async () => {
    const state = fakeV1State({ laps: [v1Lap({ game: 'ac', startedAt: minutesAgo(60 * 24 * 3) }), v1Lap({ game: 'ac', startedAt: minutesAgo(60 * 24 * 4) }), v1Lap({ game: 'lmu' })] });
    stubFetch({ v1: state });
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-game="ac"]')).toHaveAttribute('data-laps', '2'));
    const status = (game: string) => within(document.querySelector(`[data-game="${game}"]`) as HTMLElement).getByTestId('game-status');
    expect(status('ac')).toHaveTextContent(/^2 laps$/);
    expect(status('ams2')).toHaveTextContent('No laps yet');
    // One lap is "1 lap", not "1 laps".
    expect(status('lmu')).toHaveTextContent(/^1 lap$/);
    expect(status('lmu')).not.toHaveTextContent('1 laps');
    expect(status('ac')).not.toHaveTextContent('last driven');
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

describe('the Companion screen is translated', () => {
  it('speaks Portuguese: the steps, the state, Disconnect, the games and the notes', async () => {
    await i18n.changeLanguage('pt-BR');
    api.list.mockResolvedValue([device({ last_seen_at: minutesAgo(60 * 48) }), device({ id: 'd2', name: 'OLD', revoked_at: '2026-11-05T10:00:00.000Z' })]);
    stubFetch({ v1: fakeV1State({ laps: [v1Lap({ game: 'ac' }), v1Lap({ game: 'ac' }), v1Lap({ game: 'lmu' })] }) });
    renderPanel();
    const card = byName(await screen.findAllByTestId('device'), 'RIG');
    expect(within(card).getByTestId('device-state')).toHaveTextContent('Offline');
    expect(within(card).getByRole('button', { name: /^Desconectar/ })).toBeInTheDocument();
    expect(screen.getByTestId('devices-revoked')).toHaveTextContent('Computadores desconectados: 1');
    expect(screen.getByText('Primeiros passos')).toBeInTheDocument();
    expect(screen.getByTestId('step-connect')).toHaveTextContent('O navegador pede uma única confirmação.');
    expect(screen.getByTestId('games-certified')).toHaveTextContent('Certificados');
    await waitFor(() => expect(document.querySelector('[data-game="ac"] [data-testid="game-status"]')).toHaveTextContent(/^2 voltas$/));
    expect(document.querySelector('[data-game="lmu"] [data-testid="game-status"]')).toHaveTextContent(/^1 volta$/);
    expect(screen.getByTestId('games-beta')).toHaveTextContent('Os jogos beta são compatíveis');
    expect(await screen.findByTestId('companion-smartscreen')).toHaveTextContent('Mais informações');
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/checksum|SHA-256/i);
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/Revog/);
  });

  it('speaks Spanish', async () => {
    await i18n.changeLanguage('es-ES');
    api.list.mockResolvedValue([device({ last_seen_at: minutesAgo(60 * 48) })]);
    stubFetch({ v1: fakeV1State({ laps: [v1Lap({ game: 'ac' }), v1Lap({ game: 'ac' }), v1Lap({ game: 'lmu' })] }) });
    renderPanel();
    const card = await screen.findByTestId('device');
    expect(within(card).getByTestId('device-state')).toHaveTextContent('Sin conexión');
    expect(within(card).getByRole('button', { name: /^Desconectar/ })).toBeInTheDocument();
    expect(screen.getByText('Primeros pasos')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[data-game="ac"] [data-testid="game-status"]')).toHaveTextContent(/^2 vueltas$/));
    expect(document.querySelector('[data-game="lmu"] [data-testid="game-status"]')).toHaveTextContent(/^1 vuelta$/);
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/checksum|SHA-256/i);
    expect(screen.getByTestId('companion-panel').textContent).not.toMatch(/Revoc/);
  });
});
