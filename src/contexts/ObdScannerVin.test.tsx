import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ObdScannerProvider, useObd } from './ObdScannerContext';
import type { CarIdentity } from '@/lib/vin';

const h = vi.hoisted(() => ({
  vin: null as string | null,
  selectedCarId: 'b',
  cars: [] as { id: string; name: string; vin?: string }[],
  select: vi.fn(), update: vi.fn(), identify: vi.fn(),
}));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ cars: h.cars, selectedCarId: h.selectedCarId, selectCar: h.select, updateCar: h.update, loading: false }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/hooks/use-obd-scanner', () => ({ useObdScanner: () => ({ vin: h.vin, status: 'idle', recording: null, connect: vi.fn(), linkOpen: false }) }));
vi.mock('@/lib/obd/trip-cloud',()=>({ recoverCloudTrips:async()=>[], checkpointTrip:async()=>50, removeCloudTrip:async()=>{}, finalizeCloudTrip:async()=>null }));
vi.mock('@/hooks/use-wake-lock', () => ({ useScreenWakeLock: vi.fn() }));
vi.mock('@/lib/vin', async (original) => ({ ...await original<object>(), identifyVin: h.identify }));
vi.mock('@/lib/obd/elm327', () => ({ isBluetoothAvailable: () => false }));
vi.mock('@/lib/obd/trip-store', () => ({ listTripCopies: async () => [], tripKey: (at: number) => String(at) }));

const VIN_A = 'JTDKN3DU0A0123456';
const VIN_B = '1HGCM82633A123456';
function Found() { return <p>{useObd().newCarFound?.vin ?? 'none'}</p>; }
const ui = () => <ObdScannerProvider><Found /></ObdScannerProvider>;
beforeEach(() => {
  h.vin = null; h.selectedCarId = 'b'; h.cars = [];
  h.identify.mockReset(); h.select.mockReset(); h.update.mockReset();
});
afterEach(cleanup);

it('recognizes A again after disconnecting from A and selecting B', async () => {
  h.cars = [{ id: 'a', name: 'A', vin: VIN_A }, { id: 'b', name: 'B', vin: VIN_B }];
  h.vin = VIN_A;
  const view = render(ui());
  await waitFor(() => expect(h.select).toHaveBeenCalledWith('a'));
  h.vin = null;
  view.rerender(ui());
  h.select.mockClear();
  h.vin = VIN_A;
  view.rerender(ui());
  await waitFor(() => expect(h.select).toHaveBeenCalledWith('a'));
});

it('discards a VIN identification that finishes after connecting to another car', async () => {
  let finish!: (identity: CarIdentity) => void;
  h.identify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  h.vin = VIN_A;
  const view = render(ui());
  await waitFor(() => expect(h.identify).toHaveBeenCalledWith(VIN_A));
  h.cars = [{ id: 'b', name: 'B', vin: VIN_B }];
  h.vin = VIN_B;
  view.rerender(ui());
  await act(async () => finish({ vin: VIN_A, make: 'Toyota', model: null, year: 2010, trim: null, engineType: null, bodyType: null }));
  expect(screen.getByText('none')).toBeInTheDocument();
  expect(h.update).not.toHaveBeenCalled();
});
