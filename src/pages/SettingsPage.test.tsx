import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsProvider } from '@/contexts/SettingsContext';
import i18n from '@/lib/i18n';
import SettingsPage from './SettingsPage';

const notify = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: notify }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children, refreshDisabled }: { children: ReactNode; refreshDisabled?: boolean }) => <div data-testid="layout" data-blocked={refreshDisabled}>{children}</div> }));
vi.mock('@/components/TripSyncStatus', () => ({ default: () => null }));
vi.mock('@/components/McpTokensSection', () => ({ default: () => null }));
vi.mock('@/components/InstallApp', () => ({ AndroidAppDownload: () => null, IosAddToHome: () => null, IphoneNoBluetooth: () => null }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => <div>
    <button onClick={() => onValueChange(value === 'C' ? 'F' : value === 'F' ? 'C' : value === 'km' ? 'mi' : value === 'mi' ? 'km' : value === 'en' ? 'pt-BR' : value === 'pt-BR' ? 'en' : 'America/New_York')}>Change {value}</button>{children}
  </div>,
  SelectTrigger: () => null, SelectValue: () => null, SelectContent: () => null, SelectItem: () => null,
}));

beforeEach(async () => {
  localStorage.clear();
  notify.mockClear();
  await i18n.changeLanguage('en');
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open() { render(<MemoryRouter><SettingsProvider><SettingsPage /></SettingsProvider></MemoryRouter>); }

it('has no Save for persisted settings and only saves changed values after confirmation', async () => {
  localStorage.setItem('settings_timezone', 'America/New_York');
  localStorage.setItem('settings_distanceUnit', 'mi');
  open();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change mi' }));
  expect(localStorage.getItem('settings_distanceUnit')).toBe('mi');
  expect(screen.getByTestId('layout')).toHaveAttribute('data-blocked', 'true');
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
  expect(localStorage.getItem('settings_distanceUnit')).toBe('km');
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeEnabled();
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
});

it('hides Save when the user reverts the draft and delays language changes', () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Change en' }));
  expect(i18n.resolvedLanguage).toBe('en');
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change pt-BR' }));
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

it('reports storage failures without falsely claiming the changes were saved', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Change km' }));
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })));
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  expect(localStorage.getItem('settings_distanceUnit')).toBeNull();
});

it('saves the temperature choice only after Save and restores it next time', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Change C' }));
  expect(localStorage.getItem('settings_temperatureUnit')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(localStorage.getItem('settings_temperatureUnit')).toBe('F'));
  cleanup(); open();
  expect(screen.getByRole('button', { name: 'Change F' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});
