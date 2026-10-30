import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { HeaderControls } from './HeaderControls';

const state = vi.hoisted(() => ({
  status: 'idle', linkOpen: false,
  connection: null as null | { deviceName: string; transport: string },
  recording: { active: false }, connect: vi.fn(), disconnect: vi.fn(),
}));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => state }));
vi.mock('@/contexts/VehicleNotificationsContext', () => ({ useVehicleNotifications: () => ({ items: [], unread: 0, loading: false, error: false, markRead: vi.fn(), reload: vi.fn() }) }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCar: { name: 'Prius' } }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'mi', temperatureUnit: 'F' }) }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  state.status = 'idle';
  state.linkOpen = false;
  state.connection = null;
  state.recording.active = false;
  state.connect.mockReset();
  state.disconnect.mockReset();
});
afterEach(cleanup);

function renderHeader() {
  return render(<MemoryRouter initialEntries={['/history']}>
    <HeaderControls />
    <Routes>
      <Route path="/history" element={<p>Trips screen</p>} />
      <Route path="/live" element={<p>Live screen</p>} />
    </Routes>
  </MemoryRouter>);
}

it('opens the chooser in the disconnected click gesture before navigating to Live', () => {
  state.connect.mockImplementation(() => {
    expect(screen.getByText('Trips screen')).toBeInTheDocument();
    return Promise.resolve();
  });
  renderHeader();
  const group = screen.getByRole('group', { name: 'Car status and notifications' });
  expect(within(group).getAllByRole('link')).toHaveLength(1);
  expect(within(group).getAllByRole('button')).toHaveLength(1);
  expect(within(group).queryByRole('button', { name: /bluetooth|disconnect/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Car not connected' }));
  expect(state.connect).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Live screen')).toBeInTheDocument();
  expect(state.disconnect).not.toHaveBeenCalled();
});

it.each([
  ['live', 'Car connected'],
  ['waiting', 'Waiting for the car'],
  ['connecting', 'Connecting…'],
  ['reconnecting', 'Connecting…'],
])('opens Live without restarting the adapter while %s', (status, label) => {
  state.status = status;
  state.linkOpen = status === 'live' || status === 'waiting';
  renderHeader();
  fireEvent.click(screen.getByRole('link', { name: label }));
  expect(screen.getByText('Live screen')).toBeInTheDocument();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.disconnect).not.toHaveBeenCalled();
});

it('preserves an active recording even if the scanner briefly reports idle', () => {
  state.recording.active = true;
  renderHeader();
  fireEvent.click(screen.getByRole('link', { name: 'Recording trip' }));
  expect(screen.getByText('Live screen')).toBeInTheDocument();
  expect(state.connect).not.toHaveBeenCalled();
  expect(state.disconnect).not.toHaveBeenCalled();
});

it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])('does not open the chooser for a modified %s click', key => {
  renderHeader();
  const link = screen.getByRole('link', { name: 'Car not connected' });
  // JSDOM has no native new-tab navigation for modified clicks.
  link.addEventListener('click', event => event.preventDefault(), { once: true });
  fireEvent.click(link, { [key]: true });
  expect(state.connect).not.toHaveBeenCalled();
  expect(screen.getByText('Trips screen')).toBeInTheDocument();
});

it('keeps the compact notifications panel and restores focus on Escape', async () => {
  renderHeader();
  fireEvent.click(screen.getByRole('button', { name: 'Notifications: 0 unread' }));
  const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
  expect(dialog).not.toHaveAttribute('aria-modal', 'true');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Notifications: 0 unread' })).toHaveFocus());
});

it('keeps notifications available when Bluetooth is unsupported', () => {
  state.status = 'unsupported';
  renderHeader();
  expect(screen.queryByTestId('connection-pill')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Notifications: 0 unread' })).toBeInTheDocument();
});
