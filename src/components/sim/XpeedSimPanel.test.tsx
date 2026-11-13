import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const api = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/sim/xpeed-sim-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/xpeed-sim-api')>()),
  listDevices: api.list,
  revokeDevice: api.revoke,
}));

import { XpeedSimApiError } from '@/lib/sim/xpeed-sim-api';
import { XpeedSimPanel } from './XpeedSimPanel';

const device = (over: Partial<SimDevice> = {}): SimDevice => ({
  id: 'd1', name: 'RIG', created_at: '2026-11-01T10:00:00.000Z', last_seen_at: '2026-11-10T09:00:00.000Z',
  last_lap_at: '2026-11-10T08:30:00.000Z', revoked_at: null, ...over,
});
const renderPanel = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsProvider><XpeedSimPanel /></SettingsProvider>
    </QueryClientProvider>,
  );

beforeEach(async () => {
  api.list.mockReset().mockResolvedValue([]);
  api.revoke.mockReset().mockResolvedValue({ revoked: true });
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

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
});

describe('the computers already connected', () => {
  it('says so when there are none', async () => {
    renderPanel();
    expect(await screen.findByTestId('devices-empty')).toHaveTextContent('No computer is connected yet.');
  });

  it('lists each computer with its state and when it last sent a lap', async () => {
    api.list.mockResolvedValue([
      device(),
      device({ id: 'd2', name: 'LAPTOP', last_seen_at: null, last_lap_at: null }),
      device({ id: 'd3', name: 'OLD PC', revoked_at: '2026-11-05T10:00:00.000Z' }),
    ]);
    renderPanel();
    const rows = await screen.findAllByTestId('device');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('RIG');
    expect(rows[0]).toHaveTextContent('Connected');
    expect(rows[0]).toHaveTextContent(/Last lap sent/);
    expect(rows[1]).toHaveTextContent('Never seen');
    expect(rows[1]).toHaveTextContent('No laps sent yet');
    expect(rows[2]).toHaveTextContent('Revoked');
    // Only a live computer can be revoked.
    expect(within(rows[0]).getByRole('button', { name: /Revoke/ })).toBeInTheDocument();
    expect(within(rows[2]).queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByTestId('device')).toHaveTextContent('Revoked'));
  });

  it('keeps the computer when the question is answered with cancel', async () => {
    api.list.mockResolvedValue([device()]);
    renderPanel();
    fireEvent.click(within(await screen.findByTestId('device')).getByRole('button', { name: /Revoke/ }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(api.revoke).not.toHaveBeenCalled();
  });

  it('says when the list cannot be read', async () => {
    api.list.mockRejectedValue(new XpeedSimApiError('unavailable'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached');
    expect(screen.queryByTestId('devices-empty')).not.toBeInTheDocument();
  });
});

describe('the download step', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links step 1 to the public Companion page and shows the latest version', async () => {
    const release = { version: '0.5.0', build: 'abc1234', downloadUrl: 'https://xpeed.test/api/companion/download', sha256: 'a'.repeat(64), size: 3145728, releasedAt: '2026-11-13T12:00:00Z', minVersion: '0.4.0', signed: false };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(release) } as Response)));
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(within(steps).getByTestId('companion-page-link')).toHaveAttribute('href', '/companion');
    expect(await within(steps).findByTestId('companion-latest')).toHaveTextContent('latest: 0.5.0');
    expect(steps).toHaveTextContent('Install Xpeed Companion on the PC where you play.');
  });

  it('keeps the link when the version cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    renderPanel();
    const steps = await screen.findByTestId('how-to-connect');
    expect(within(steps).getByTestId('companion-page-link')).toHaveAttribute('href', '/companion');
    expect(within(steps).queryByTestId('companion-latest')).not.toBeInTheDocument();
  });
});
