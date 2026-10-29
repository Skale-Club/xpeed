import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TripSyncStatus from './TripSyncStatus';
const api = vi.hoisted(() => ({ status: vi.fn(), retry: vi.fn(), saving: false }));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => ({ getTripSyncStatus: api.status, retryPendingTrips: api.retry, savingTrip: api.saving }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'owner@example.com' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, fallback: string, args?: { count: number }) => fallback.replace('{{count}}', String(args?.count ?? '')) }) }));
beforeEach(() => { api.status.mockReset().mockResolvedValue({ pending: 2, latestError: 'Could not save recorded trip: unavailable' }); api.retry.mockReset().mockImplementation(async () => { api.status.mockResolvedValue({ pending: 0, latestError: null }); }); });
afterEach(cleanup);
it('shows pending copies and the actual failure, then retries without deleting copies', async () => {
  render(<TripSyncStatus />);
  expect(await screen.findByText('2 pending trips found on this device')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save recorded trip: unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Retry pending trips' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('0 pending trips'));
  expect(api.retry).toHaveBeenCalledOnce(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('does not report success when a retry fails', async () => {
  api.retry.mockRejectedValueOnce(new Error('offline'));
  render(<TripSyncStatus />); await screen.findByText('2 pending trips found on this device');
  fireEvent.click(screen.getByRole('button', { name: 'Retry pending trips' }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledOnce());
  expect(screen.getByRole('status')).toHaveTextContent('2 pending trips');
});
