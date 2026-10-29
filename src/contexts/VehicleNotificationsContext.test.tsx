import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VehicleNotificationsProvider, useVehicleNotifications } from './VehicleNotificationsContext';
import type { FaultInspection } from '@/hooks/use-obd-scanner';
import { EMPTY_VEHICLE_CARE, type VehicleCareRecord } from '@/lib/vehicle-care';

const state = vi.hoisted(() => ({ car: 'one', inspection: null as FaultInspection | null, reload: vi.fn(), problems: [], care: null as VehicleCareRecord | null }));
vi.mock('@/hooks/use-vehicle-care', () => ({ useVehicleCare: () => ({ data: state.care, isSuccess: !!state.care, isPending: false, isError: false, refetch: state.reload }) }));
vi.mock('./SettingsContext', () => ({ useSettings: () => ({ timezone: 'America/New_York' }) }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ user: { id: 'user' } }) }));
vi.mock('./CarsContext', () => ({ useCarsContext: () => ({ selectedCarId: state.car, selectedCar: { vin: state.car } }) }));
vi.mock('./ObdScannerContext', () => ({ useObd: () => ({ faultInspection: state.inspection, lastTrip: null }) }));
vi.mock('@/hooks/use-open-problems', () => ({ useOpenProblems: () => ({ problems: state.problems, loading: false, error: false, refreshError: false, reload: state.reload }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: vi.fn() } }));
function Consumer() {
  const { unread, markRead } = useVehicleNotifications();
  return <button onClick={() => markRead()}>{unread} unread</button>;
}
const app = () => <VehicleNotificationsProvider><Consumer /></VehicleNotificationsProvider>;
beforeEach(() => { state.car = 'one'; state.inspection = null; state.care = null; localStorage.clear(); });
afterEach(cleanup);
it('persists marking read and never attributes a previous scan to a newly selected car', async () => {
  const view = render(app());
  state.inspection = { readout: { stored: ['P0300'], pending: [], permanent: [], checked: true, complete: true, modules: ['7E0'] }, at: '2026-10-29', vin: 'one' };
  view.rerender(app());
  await screen.findByText('1 unread');
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('0 unread');
  state.car = 'two'; view.rerender(app());
  expect(screen.getByText('0 unread')).toBeInTheDocument();
  state.car = 'one'; view.rerender(app());
  expect(screen.getByText('0 unread')).toBeInTheDocument();
  state.inspection = { ...state.inspection, readout: { ...state.inspection.readout, stored: ['P0420'] } };
  view.rerender(app());
  await waitFor(() => expect(screen.getByText('1 unread')).toBeInTheDocument());
});
it('shows an oil reminder and removes it after a recorded oil change', async () => {
  state.care = { state: { ...EMPTY_VEHICLE_CARE, odometerKm: 100, oilDueKm: 90, oilPlanAt: '2026-10-01T12:00:00Z' }, revision: 'r', lastOil: null };
  const view = render(app());
  await screen.findByText('1 unread');
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText('0 unread');
  state.care = { ...state.care, lastOil: { id: 'oil', performed_at: '2026-10-29', odometer_km: 100, created_at: '2026-10-29T12:00:00Z' } };
  view.rerender(app());
  await waitFor(() => expect(JSON.parse(localStorage.getItem('xpeed.notifications.user.one') || '[]')).toEqual([]));
});
