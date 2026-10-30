import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import FaultCodesPage from './FaultCodesPage';

const api = vi.hoisted(() => ({ status: 'live', userId: 'user', carId: 'car', profileVin: 'VIN', vin: 'VIN', readDtcs: vi.fn(), connect: vi.fn(), sync: vi.fn(), changed: vi.fn() }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/DTCPanel', () => ({ default: () => <div>Code explanations</div> }));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => ({ status: api.status, readDtcs: api.readDtcs, connect: api.connect, vin: api.vin, error: null }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: api.userId } }) }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: api.carId, selectedCar: { id: api.carId, name: 'Prius', vin: api.profileVin } }) }));
vi.mock('@/lib/issue-reconciler', () => ({ syncFaultCodes: api.sync }));
vi.mock('@/hooks/use-open-problems', () => ({ notifyProblemsChanged: api.changed }));
beforeEach(async () => {
  vi.clearAllMocks(); api.status = 'live'; api.sync.mockResolvedValue({ resolved: 0 });
  localStorage.clear(); api.userId = 'user'; api.carId = 'car'; api.profileVin = 'VIN'; api.vin = 'VIN';
  api.readDtcs.mockResolvedValue({ stored: [], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  await i18n.changeLanguage('en');
});
afterEach(cleanup);
const page = () => render(<MemoryRouter><FaultCodesPage /></MemoryRouter>);
it('reads only on request and restores the saved result after remounting without rescanning or syncing again', async () => {
  const first = page();
  expect(api.readDtcs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  await screen.findByText('Code explanations');
  await waitFor(() => expect(api.changed).toHaveBeenCalledTimes(1));
  expect(api.readDtcs).toHaveBeenCalledTimes(1);
  const date = screen.getByText(/Last reading:/).textContent;
  first.unmount();
  page();
  expect(screen.getByText('Code explanations')).toBeInTheDocument();
  expect(screen.getByText(/Last reading:/)).toHaveTextContent(date!);
  expect(api.readDtcs).toHaveBeenCalledTimes(1);
  expect(api.sync).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Read codes again' }));
  await waitFor(() => expect(api.readDtcs).toHaveBeenCalledTimes(2));
});
it('does not present a partial empty reading as a clean bill of health', async () => {
  api.readDtcs.mockResolvedValue({ stored: [], pending: [], permanent: [], checked: true, complete: false, modules: [] });
  const first = page();
  fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('did not answer all required');
  expect(screen.queryByText('Code explanations')).not.toBeInTheDocument();
  first.unmount(); page();
  expect(screen.getByRole('alert')).toHaveTextContent('did not answer all required');
  expect(screen.queryByText('Code explanations')).not.toBeInTheDocument();
  expect(api.readDtcs).toHaveBeenCalledTimes(1);
});
it('keeps unknown codes visible and reports failed persistence', async () => {
  api.readDtcs.mockResolvedValue({ stored: ['P1999'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  api.sync.mockRejectedValue(new Error('offline'));
  const first = page();
  fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  expect(await screen.findByText(/P1999/)).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('Problems could not be updated');
  first.unmount(); api.status = 'idle'; page();
  expect(screen.getByText(/P1999/)).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Problems could not be updated');
  expect(api.readDtcs).toHaveBeenCalledTimes(1);
});
it('connecting or reconnecting never starts a reading without pressing Read codes', () => {
  api.status = 'idle'; const view = page();
  expect(api.readDtcs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Connect to the car' }));
  expect(api.connect).toHaveBeenCalledOnce();
  api.status = 'live'; view.rerender(<MemoryRouter><FaultCodesPage /></MemoryRouter>);
  expect(api.readDtcs).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Read codes' })).toBeEnabled();
});

it('keeps the last result when a new read fails', async () => {
  api.readDtcs.mockResolvedValueOnce({ stored: ['P0420'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  page(); fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  await waitFor(() => expect(api.changed).toHaveBeenCalledOnce());
  api.readDtcs.mockRejectedValueOnce(new Error('Connection lost'));
  fireEvent.click(screen.getByRole('button', { name: 'Read codes again' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection lost');
  expect(screen.getByText(/P0420/)).toBeInTheDocument();
});

it('does not show another account or car’s saved reading', async () => {
  api.readDtcs.mockResolvedValueOnce({ stored: ['P0420'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  const first = page(); fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  await waitFor(() => expect(api.changed).toHaveBeenCalledOnce());
  first.unmount(); api.carId = 'other'; const otherCar = page();
  expect(screen.queryByText(/P0420/)).not.toBeInTheDocument();
  otherCar.unmount(); api.carId = 'car'; api.userId = 'other-user'; page();
  expect(screen.queryByText(/P0420/)).not.toBeInTheDocument();
  expect(api.readDtcs).toHaveBeenCalledOnce();
});

it('does not cache or attribute a reading when the connected VIN differs', async () => {
  api.vin = 'OTHER-VIN';
  api.readDtcs.mockResolvedValueOnce({ stored: ['P0420'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  const first = page(); fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  await screen.findByText(/P0420/);
  expect(api.sync).not.toHaveBeenCalled();
  first.unmount(); page();
  expect(screen.queryByText(/P0420/)).not.toBeInTheDocument();
  expect(api.readDtcs).toHaveBeenCalledOnce();
});

it('ignores a scan that finishes after changing cars', async () => {
  let finish!: (value: unknown) => void;
  api.readDtcs.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = page(); fireEvent.click(screen.getByRole('button', { name: 'Read codes' }));
  api.carId = 'other'; view.rerender(<MemoryRouter><FaultCodesPage /></MemoryRouter>);
  finish({ stored: ['P0420'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Read codes' })).toBeEnabled());
  expect(screen.queryByText(/P0420/)).not.toBeInTheDocument();
  expect(api.sync).not.toHaveBeenCalled();
});
