import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';

const api = vi.hoisted(() => ({ read: vi.fn(), approve: vi.fn(), cancel: vi.fn() }));
const modes = vi.hoisted(() => ({ modes: ['real'] as string[], virtualAvailable: true, setModes: vi.fn() }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana', email: 'ana@example.com', user_metadata: {} } }) }));
vi.mock('@/contexts/ModesContext', () => ({ useModes: () => modes }));
vi.mock('@/lib/sim/xpeed-sim-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/xpeed-sim-api')>()),
  readLinkRequest: api.read,
  approveLinkRequest: api.approve,
  cancelLinkRequest: api.cancel,
}));

import { XpeedSimLinkError } from '@/lib/sim/xpeed-sim-api';
import SimConnectPage from './SimConnectPage';

const pending = { deviceName: 'DESKTOP-RIG', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z' };
const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/companion/connect/req-1']}>
        <Routes><Route path="/companion/connect/:id" element={<SimConnectPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(async () => {
  api.read.mockReset().mockResolvedValue(pending);
  api.approve.mockReset().mockResolvedValue({ status: 'approved', deviceId: 'd1' });
  api.cancel.mockReset().mockResolvedValue({ status: 'cancelled' });
  modes.modes = ['real'];
  modes.virtualAvailable = true;
  modes.setModes.mockReset();
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

describe('the connect page', () => {
  it('asks once, with the computer name, the account and one Connect button', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Connect Xpeed Companion?' })).toBeInTheDocument();
    expect(screen.getByTestId('connect-device')).toHaveTextContent('DESKTOP-RIG');
    expect(screen.getByText('Your laps from this computer will go to ana@example.com.')).toBeInTheDocument();
    expect(screen.getByText('Only connect if you just clicked Connect in Xpeed Companion on this computer.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(api.read).toHaveBeenCalledWith('req-1');
    expect(api.approve).not.toHaveBeenCalled();
  });

  it('shows a loading state while the request is read', async () => {
    api.read.mockReturnValue(new Promise(() => undefined));
    open();
    expect(await screen.findByTestId('connect-loading')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('on Connect: approves, turns Racing games on, and says it is connected', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('heading', { name: 'Connected' })).toBeInTheDocument();
    expect(api.approve).toHaveBeenCalledWith('req-1');
    expect(modes.setModes).toHaveBeenCalledWith(['real', 'virtual']);
    expect(screen.getByText('Go back to Xpeed Companion, it already knows. You can close this tab.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Racing games' })).toHaveAttribute('href', '/virtual');
  });

  it('leaves the modes alone when Virtual is already on, or is not in this build', async () => {
    modes.modes = ['real', 'virtual'];
    const first = open();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Connected' });
    expect(modes.setModes).not.toHaveBeenCalled();
    first.unmount();
    modes.modes = ['real'];
    modes.virtualAvailable = false;
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Connected' });
    expect(modes.setModes).not.toHaveBeenCalled();
  });

  it('says the request expired, with no button', async () => {
    api.read.mockResolvedValue({ ...pending, status: 'expired' });
    open();
    expect(await screen.findByTestId('connect-expired')).toHaveTextContent('This request expired. Click Connect again in Xpeed Companion.');
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('says the request was cancelled', async () => {
    api.read.mockResolvedValue({ ...pending, status: 'cancelled' });
    open();
    expect(await screen.findByTestId('connect-cancelled')).toHaveTextContent('This request was cancelled');
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('says the computer is already connected', async () => {
    api.read.mockResolvedValue({ ...pending, status: 'approved' });
    open();
    expect(await screen.findByTestId('connect-already')).toHaveTextContent('DESKTOP-RIG is already connected.');
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument();
  });

  it('says when the request is not found', async () => {
    api.read.mockRejectedValue(new XpeedSimLinkError('not_found'));
    open();
    expect(await screen.findByTestId('connect-error')).toHaveTextContent('We could not find this request.');
  });

  it('Cancel tells the server and says nothing was connected', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('connect-cancelled')).toHaveTextContent('Cancelled. This computer was not connected.');
    expect(api.cancel).toHaveBeenCalledWith('req-1');
    expect(api.approve).not.toHaveBeenCalled();
    expect(modes.setModes).not.toHaveBeenCalled();
  });

  it('shows the expired line when the request ran out while the page was open', async () => {
    api.approve.mockRejectedValue(new XpeedSimLinkError('expired'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByTestId('connect-error')).toHaveTextContent('This request expired.');
    expect(modes.setModes).not.toHaveBeenCalled();
  });

  it('keeps the button and says why when the 10-computer limit is reached', async () => {
    api.approve.mockRejectedValue(new XpeedSimLinkError('device_limit'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
    expect(await screen.findByTestId('connect-failure')).toHaveTextContent('10 computers');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled());
    expect(modes.setModes).not.toHaveBeenCalled();
  });
});
