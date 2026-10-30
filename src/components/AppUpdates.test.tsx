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
  expect(screen.getByRole('link', { name: 'Download APK' })).not.toHaveAttribute('target');
});

it('keeps APK download available during recording while blocking screen reload', async () => {
  mocks.blocked = true;
  mocks.check.mockResolvedValue({ installed: 57, required: 58, available: true, downloadUrl: '/xpeed.apk' });
  render(<AppUpdates />);
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeDisabled();
  expect(await screen.findByRole('link', { name: 'Download APK' })).toHaveAttribute('href', '/xpeed.apk');
  expect(screen.getByRole('link', { name: 'Download APK' })).not.toHaveAttribute('target');
  expect(screen.getByText(/You can download now/)).toBeInTheDocument();
  expect(mocks.reload).not.toHaveBeenCalled();
});

it('keeps the banner download available while a trip is recording', async () => {
  mocks.blocked = true;
  mocks.check.mockResolvedValue({ installed: 76, required: 77, latest: 79, available: true, downloadUrl: '/xpeed.apk' });
  render(<AppUpdateBanner />);
  const download = await screen.findByRole('link', { name: 'Download APK' });
  expect(download).toHaveAttribute('href', '/xpeed.apk');
  expect(download).not.toHaveAttribute('target');
  expect(screen.getByText(/You can download now/)).toBeInTheDocument();
});

it('allows downloading the APK when Settings has unsaved changes', async () => {
  mocks.check.mockResolvedValue({ installed: 76, required: 77, latest: 79, available: true, downloadUrl: '/xpeed.apk' });
  render(<AppUpdates disabled />);
  expect(await screen.findByRole('link', { name: 'Download APK' })).toHaveAttribute('href', '/xpeed.apk');
  expect(screen.getByRole('button', { name: 'Reload screens' })).toBeDisabled();
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
