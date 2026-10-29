import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import FaultCodesPage from './FaultCodesPage';

const api = vi.hoisted(() => ({ status: 'live', readDtcs: vi.fn(), connect: vi.fn(), sync: vi.fn(), changed: vi.fn() }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/DTCPanel', () => ({ default: () => <div>Code explanations</div> }));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => ({ status: api.status, readDtcs: api.readDtcs, connect: api.connect, vin: 'VIN', error: null }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: 'car', selectedCar: { id: 'car', name: 'Prius', vin: 'VIN' } }) }));
vi.mock('@/lib/issue-reconciler', () => ({ syncFaultCodes: api.sync }));
vi.mock('@/hooks/use-open-problems', () => ({ notifyProblemsChanged: api.changed }));
beforeEach(async () => {
  vi.clearAllMocks(); api.status = 'live'; api.sync.mockResolvedValue({ resolved: 0 });
  api.readDtcs.mockResolvedValue({ stored: [], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  await i18n.changeLanguage('en');
});
afterEach(cleanup);
const page = () => render(<MemoryRouter><FaultCodesPage /></MemoryRouter>);
it('reads once on entry and syncs Problems, then allows an explicit fresh check', async () => {
  page();
  await screen.findByText('Code explanations');
  await waitFor(() => expect(api.changed).toHaveBeenCalledTimes(1));
  expect(api.readDtcs).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Read codes again' }));
  await waitFor(() => expect(api.readDtcs).toHaveBeenCalledTimes(2));
});
it('does not present a partial empty reading as a clean bill of health', async () => {
  api.readDtcs.mockResolvedValue({ stored: [], pending: [], permanent: [], checked: true, complete: false, modules: [] });
  page();
  expect(await screen.findByRole('alert')).toHaveTextContent('did not answer all required');
  expect(screen.queryByText('Code explanations')).not.toBeInTheDocument();
});
it('keeps unknown codes visible and reports failed persistence', async () => {
  api.readDtcs.mockResolvedValue({ stored: ['P1999'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  api.sync.mockRejectedValue(new Error('offline'));
  page();
  expect(await screen.findByText(/P1999/)).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Problems could not be updated');
});
it('offers connection without attempting a read while offline', () => {
  api.status = 'idle'; page();
  expect(api.readDtcs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect to the car' }));
  expect(api.connect).toHaveBeenCalledOnce();
});
