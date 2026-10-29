import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from '@/lib/i18n';
import AppUpdates from './AppUpdates';
import { AppUpdateBanner } from './AppUpdateBanner';

const mocks = vi.hoisted(() => ({ native: true, live: true, blocked: false, check: vi.fn(), reload: vi.fn() }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => mocks.native }));
vi.mock('@/lib/app-update', () => ({ checkApkUpdate: mocks.check, isLiveSiteApp: () => mocks.live }));
vi.mock('@/lib/pwa-update', () => ({ reloadAppScreens: mocks.reload }));
vi.mock('@/hooks/use-app-update-blocked', () => ({ useAppUpdateBlocked: () => mocks.blocked }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.native = true; mocks.live = true; mocks.blocked = false;
  mocks.check.mockReset().mockResolvedValue({ installed: 58, required: 58, latest: 70, available: false, downloadUrl: '/xpeed.apk' });
  mocks.reload.mockReset().mockResolvedValue('reloading');
});
afterEach(cleanup);

it('offers screen reload without offering an APK for a current native installation', async () => {
  render(<><AppUpdates /><AppUpdateBanner /></>);
  await screen.findByText('Installed: build 58. No APK update needed.');
  expect(screen.queryByRole('link', { name: 'Download APK' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reload screens' }));
  await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
  expect(screen.getByRole('button', { name: 'Reloading screens…' })).toBeDisabled();
});

it('labels an actual native update as an APK download and shows installed and required builds', async () => {
  mocks.check.mockResolvedValue({ installed: 57, required: 58, latest: 70, available: true, downloadUrl: '/xpeed.apk' });
  render(<AppUpdateBanner />);
  await screen.findByText('Android APK update required');
  expect(screen.getByText('Installed: build 57 · Required: build 58 or newer')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Download APK' })).toHaveAttribute('href', '/xpeed.apk');
});

it('blocks reload and APK installation during recording or unsaved changes', async () => {
  mocks.blocked = true;
  mocks.check.mockResolvedValue({ installed: 57, required: 58, available: true, downloadUrl: '/xpeed.apk' });
  render(<AppUpdates />);
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeDisabled();
  expect(await screen.findByRole('button', { name: 'Download APK' })).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Download APK' })).not.toBeInTheDocument();
});

it('shows a retryable screen refresh failure rather than claiming to be up to date', async () => {
  mocks.native = false;
  mocks.reload.mockRejectedValue(new Error('offline'));
  render(<AppUpdates />);
  fireEvent.click(screen.getByRole('button', { name: 'Reload screens' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not reload.');
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeEnabled();
});

it('does not offer a web-only refresh for bundled offline screens', async () => {
  mocks.live = false;
  render(<AppUpdates />);
  expect(screen.queryByRole('button', { name: 'Reload screens' })).not.toBeInTheDocument();
  await screen.findByText(/This offline edition includes the screens in the APK/);
});
