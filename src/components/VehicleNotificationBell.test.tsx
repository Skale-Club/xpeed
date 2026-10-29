import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { VehicleNotificationBell } from './VehicleNotificationBell';

const state = vi.hoisted(() => ({ items: [{ source: 'scan:1', kind: 'scan', severity: 'warning', at: '2026-10-29T12:00:00Z', read: false, scan: { checked: true, complete: true, modules: ['7E8'], stored: ['P0300'], pending: [], permanent: [] } }], unread: 1, loading: false, error: false, markRead: vi.fn(), reload: vi.fn() }));
vi.mock('@/contexts/VehicleNotificationsContext', () => ({ useVehicleNotifications: () => state }));
vi.mock('@/contexts/CarsContext', () => ({ useCarsContext: () => ({ selectedCar: { name: 'Prius' } }) }));
vi.mock('@/contexts/SettingsContext', () => ({ useSettings: () => ({ distanceUnit: 'mi' }) }));
beforeEach(async () => { await i18n.changeLanguage('en'); state.markRead.mockClear(); });
afterEach(cleanup);

it('opens notices without hiding the dashboard and closes on Escape', async () => {
  render(<MemoryRouter><button>Dashboard control</button><VehicleNotificationBell /></MemoryRouter>);
  const bell = screen.getByRole('button', { name: 'Notifications: 1 unread' });
  fireEvent.click(bell);
  const panel = screen.getByRole('dialog', { name: 'Notifications' });
  expect(screen.getByRole('button', { name: 'Dashboard control' })).toBeVisible();
  expect(document.querySelector('[data-aria-hidden="true"]')).toBeNull();
  expect(panel).toHaveTextContent('P0300');
  fireEvent.click(within(panel).getByRole('button', { name: 'Mark as read' }));
  expect(state.markRead).toHaveBeenCalledWith('scan:1');
  fireEvent.keyDown(panel, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('links to Problems and dismisses the panel without losing notices', () => {
  render(<MemoryRouter><VehicleNotificationBell /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Notifications: 1 unread' }));
  const problems = screen.getByRole('link', { name: 'View car problems' });
  expect(problems).toHaveAttribute('href', '/issues');
  fireEvent.click(problems);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(state.markRead).not.toHaveBeenCalled();
});
