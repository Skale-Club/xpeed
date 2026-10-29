import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { BluetoothConnectionMenu } from './BluetoothConnectionMenu';

const state = vi.hoisted(() => ({ status: 'live', linkOpen: true, connection: { deviceName: 'VEEPEAK', transport: 'ble' }, recording: { active: true }, disconnect: vi.fn() }));
vi.mock('@/contexts/ObdScannerContext', () => ({ useObd: () => state }));
vi.mock('@/lib/obd/elm327', () => ({ rememberedAdapterName: () => null }));
beforeEach(async () => { await i18n.changeLanguage('en'); state.status = 'live'; state.linkOpen = true; state.disconnect.mockClear(); });
afterEach(cleanup);

it('exposes the adapter and disconnect action directly from the header', () => {
  render(<MemoryRouter><BluetoothConnectionMenu /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Bluetooth connection' }));
  const panel = screen.getByRole('dialog', { name: 'Bluetooth connection' });
  expect(panel).toHaveTextContent('VEEPEAK');
  expect(panel).toHaveTextContent('Bluetooth LE (BLE)');
  fireEvent.click(within(panel).getByRole('button', { name: 'Disconnect Bluetooth' }));
  expect(state.disconnect).not.toHaveBeenCalled();
  const confirmation = screen.getByRole('alertdialog');
  expect(confirmation).toHaveTextContent('ends the current recording');
  fireEvent.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
  expect(state.disconnect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Bluetooth connection' }));
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect Bluetooth' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect Bluetooth' }));
  expect(state.disconnect).toHaveBeenCalledOnce();
});

it('does not offer a Bluetooth control on unsupported devices', () => {
  state.status = 'unsupported';
  render(<MemoryRouter><BluetoothConnectionMenu /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'Bluetooth connection' })).not.toBeInTheDocument();
});
