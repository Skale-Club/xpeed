import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const api = vi.hoisted(() => ({ list: vi.fn(), ask: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/sim/xpeed-sim-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/xpeed-sim-api')>()),
  listDevices: api.list,
  requestPairingCode: api.ask,
  revokeDevice: api.revoke,
  pairCommand: (code: string) => `xpeed-sim pair --server https://xpeed.test --code ${code}`,
  pairLink: (code: string) => `xpeedsim://pair?server=https%3A%2F%2Fxpeed.test&code=${code}`,
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
  api.ask.mockReset();
  api.revoke.mockReset().mockResolvedValue({ revoked: true });
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('connecting a computer', () => {
  it('shows a pairing code with the command to run, and how long it is good for', async () => {
    api.ask.mockResolvedValue({ code: 'ABCD-2345', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Get a pairing code' }));
    expect(await screen.findByTestId('pairing-code')).toHaveTextContent('ABCD-2345');
    // The command carries the code without the dash, the way Xpeed Sim reads it.
    expect(screen.getByTestId('pairing-command')).toHaveTextContent('xpeed-sim pair --server https://xpeed.test --code ABCD2345');
    // The button opens Xpeed Sim with the code in the link.
    expect(screen.getByTestId('open-app')).toHaveAttribute('href', 'xpeedsim://pair?server=https%3A%2F%2Fxpeed.test&code=ABCD2345');
    expect(screen.getByTestId('open-app')).toHaveTextContent('Open Xpeed Sim');
    expect(screen.getByTestId('pairing-left')).toHaveTextContent(/Valid for (9|10):\d\d/);
    expect(screen.getByRole('button', { name: 'Get a new code' })).toBeEnabled();
  });

  it('counts down, and says so when the code has expired', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    api.ask.mockResolvedValue({ code: 'ABCD-2345', expiresAt: new Date(Date.now() + 3000).toISOString() });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Get a pairing code' }));
    await screen.findByTestId('pairing-code');
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(screen.getByTestId('pairing-expired')).toHaveTextContent('This code has expired.');
    expect(screen.queryByTestId('pairing-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pairing-command')).not.toBeInTheDocument();
    expect(screen.queryByTestId('open-app')).not.toBeInTheDocument();
  });

  it('copies the code and the command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    api.ask.mockResolvedValue({ code: 'ABCD-2345', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Get a pairing code' }));
    await screen.findByTestId('pairing-code');
    // Two buttons copy: the code (with its word) and the command (icon only, named for screen readers).
    const [copyCode, copyCommand] = screen.getAllByRole('button', { name: 'Copy' });
    fireEvent.click(copyCode);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ABCD-2345'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    fireEvent.click(copyCommand);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('xpeed-sim pair --server https://xpeed.test --code ABCD2345'));
  });

  it('says what is wrong when no code can be had', async () => {
    api.ask.mockRejectedValue(new XpeedSimApiError('too_many'));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Get a pairing code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many codes requested');
    expect(screen.queryByTestId('pairing')).not.toBeInTheDocument();
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
