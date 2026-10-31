import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { TripCard } from './TripCard';

const state = vi.hoisted(() => ({
  status: 'live', recording: null as null | { active: boolean; startedAt: Date; manual: boolean },
  alwaysOn: true, canStayOn: true, autoPaused: false, savingTrip: false,
  tripSave: null as null | { status: string; sessionId?: string },
  setAlwaysOn: vi.fn(), startTrip: vi.fn(), stopTrip: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
}));
vi.mock('@/contexts/ObdScannerContext', () => ({
  useObd: () => state,
  useObdLive: () => ({ values: { 'Vehicle speed (km/h)': 26, 'Engine RPM (rpm)': 1500 } }),
}));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'mi', temperatureUnit: 'F' }) }));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  Object.assign(state, { status: 'live', recording: null, alwaysOn: true, autoPaused: false, savingTrip: false, tripSave: null });
  vi.clearAllMocks();
});
afterEach(cleanup);
const mount = () => render(<MemoryRouter><TripCard /></MemoryRouter>);

it('shows that automatic recording is waiting for movement and keeps the control clear', () => {
  mount();
  expect(screen.getByText('Waiting for movement')).toBeInTheDocument();
  expect(screen.getByText('Auto Recording')).toBeInTheDocument();
  expect(screen.queryByText('Car connected')).not.toBeInTheDocument();
  expect(screen.queryByText(/view details/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch'));
  expect(state.setAlwaysOn).toHaveBeenCalledWith(false);
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.disconnect).not.toHaveBeenCalled();
});

it.each(['idle', 'connecting', 'reconnecting'])('moves connection setup out of the home card during %s', status => {
  state.status = status;
  mount();
  expect(screen.getByRole('link', { name: 'Set up connection' })).toHaveAttribute('href', '/live');
  expect(screen.queryByRole('button', { name: /connect/i })).not.toBeInTheDocument();
  expect(document.querySelector('.animate-spin')).toBeNull();
});

it('shows standby while the car is off without presenting Bluetooth setup again', () => {
  state.status = 'waiting';
  mount();
  expect(screen.getByText('Recording on standby')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Set up connection' })).not.toBeInTheDocument();
});

it('keeps a drive clear of background upload indicators and repeated details links', () => {
  state.recording = { active: true, manual: false, startedAt: new Date() };
  state.savingTrip = true;
  state.tripSave = { status: 'pending' };
  mount();
  expect(screen.getByText('Recording your trip')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'View Dashboard' })).toHaveLength(1);
  expect(screen.queryByText(/saving|upload pending|view details/i)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'End trip' })).toBeInTheDocument();
});

it('shows a kept trip honestly as pending, with a route to sync details', () => {
  state.tripSave = { status: 'pending' };
  mount();
  expect(screen.getByRole('status')).toHaveTextContent('Trip kept on this device. Upload pending.');
  expect(screen.getByRole('link', { name: 'Sync details' })).toHaveAttribute('href', '/settings');
});

it('explains that disabling automatic recording does not discard the current trip', () => {
  state.recording = { active: true, manual: false, startedAt: new Date() };
  state.alwaysOn = false;
  mount();
  expect(screen.getByText(/Auto recording is off for future trips/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'End trip' })).toBeInTheDocument();
});
