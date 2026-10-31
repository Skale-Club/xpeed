import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SettingsProvider } from '@/contexts/SettingsContext';
import i18n from '@/lib/i18n';
import SettingsPage from './SettingsPage';

const notify = vi.hoisted(() => vi.fn());
const device = vi.hoisted(() => ({ native: false }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => device.native }));
vi.mock('@/hooks/use-app-update', () => ({ useAppUpdate: () => ({ checked: true, ignoredBuild: null, update: { installed: 76, installedVersion: '1.0.76', required: 77, latest: 79, available: true, downloadUrl: '/xpeed.apk' } }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: notify }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children, refreshDisabled }: { children: ReactNode; refreshDisabled?: boolean }) => <div data-testid="layout" data-blocked={refreshDisabled}>{children}</div> }));
vi.mock('@/components/McpTokensSection', () => ({ default: () => <div>Developer token controls</div> }));
vi.mock('@/components/InstallApp', () => ({ AndroidAppDownload: () => null, IosAddToHome: () => null, IphoneNoBluetooth: () => null }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => <div>
    <button onClick={() => onValueChange(({C:'F',F:'C',km:'mi',mi:'km',en:'pt-BR','pt-BR':'en',L:'US gal','US gal':'L',USD:'BRL',BRL:'USD',MPG:'L/100km','km/L':'MPG','L/100km':'km/L'} as Record<string,string>)[value] ?? 'America/New_York')}>Change {value}</button>{children}
  </div>,
  SelectTrigger: () => null, SelectValue: () => null, SelectContent: () => null, SelectItem: () => null,
}));

beforeEach(async () => {
  localStorage.clear();
  notify.mockClear();
  device.native = false;
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
  expect(screen.queryByRole('button', { name: 'Reload screens' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
  expect(localStorage.getItem('settings_distanceUnit')).toBe('km');
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
});

it('has one native version section and no installation, screen-reload or synchronization panel', () => {
  device.native = true; open();
  expect(screen.getAllByTestId('app-version')).toHaveLength(1);
  expect(screen.queryByTestId('install-section')).not.toBeInTheDocument();
  expect(screen.queryByText('App screens')).not.toBeInTheDocument();
  expect(screen.queryByText('Trip synchronization')).not.toBeInTheDocument();
  expect(screen.queryByText('Check APK')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Update app' })).toHaveAttribute('href', '/xpeed.apk');
});
it('keeps Scanner behind the saved advanced preference and integrations collapsed separately', async () => {
  open();
  expect(screen.queryByRole('link', { name: 'Open the Scanner' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('switch', { name: 'Advanced tools' }));
  expect(screen.queryByRole('link', { name: 'Open the Scanner' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByRole('link', { name: 'Open the Scanner' })).toHaveAttribute('href', '/scanner');
  expect(screen.queryByText('Developer token controls')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('Developer integrations'));
  expect(await screen.findByText('Developer token controls')).toBeVisible();
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

it('preserves U.S. fuel units after independently changing miles to kilometers and reloading', async () => {
  localStorage.setItem('settings_distanceUnit', 'mi');
  open();
  expect(screen.getByRole('button', {name:'Change US gal'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Change MPG'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'Change mi'}));
  fireEvent.click(screen.getByRole('button', {name:'Save'}));
  await waitFor(() => expect(screen.queryByRole('button', {name:'Save'})).not.toBeInTheDocument());
  cleanup(); open();
  expect(screen.getByRole('button', {name:'Change km'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Change US gal'})).toBeInTheDocument();
  expect(screen.getByRole('button', {name:'Change MPG'})).toBeInTheDocument();
});

it('supports Portuguese with USD, Fahrenheit, miles and U.S. gallons without changing currency with language', async () => {
  for (const [key,value] of Object.entries({distanceUnit:'mi',temperatureUnit:'F',volumeUnit:'US gal',consumptionUnit:'MPG',currency:'USD'})) localStorage.setItem(`settings_${key}`,value);
  open();
  fireEvent.click(screen.getByRole('button', {name:'Change en'}));
  fireEvent.click(screen.getByRole('button', {name:'Save'}));
  await waitFor(() => expect(i18n.resolvedLanguage).toBe('pt-BR'));
  await waitFor(() => expect(screen.queryByRole('button', {name:'Salvar'})).not.toBeInTheDocument());
  for (const value of ['USD','F','mi','US gal','MPG']) expect(screen.getByRole('button',{name:`Change ${value}`})).toBeInTheDocument();
  expect(localStorage.getItem('settings_currency')).toBe('USD');
});

it('only applies the new currency and volume choices after Save', async () => {
  open();
  fireEvent.click(screen.getByRole('button',{name:'Change USD'}));
  fireEvent.click(screen.getByRole('button',{name:'Change L'}));
  expect(localStorage.getItem('settings_currency')).toBeNull();
  expect(localStorage.getItem('settings_volumeUnit')).toBe('L');
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(() => expect(localStorage.getItem('settings_currency')).toBe('BRL'));
  expect(localStorage.getItem('settings_volumeUnit')).toBe('US gal');
  expect(localStorage.getItem('settings_distanceUnit')).toBe('km');
});
