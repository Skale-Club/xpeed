import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { AppVersion } from './AppVersion';
import { AppUpdateBanner } from './AppUpdateBanner';
import type { ApkUpdate } from '@/lib/app-update';
const state = vi.hoisted(() => ({ native: true, blocked: false, checked: true, ignoredBuild: null as number | null, update: null as ApkUpdate | null }));
vi.mock('@/hooks/use-app-update', () => ({ useAppUpdate: () => state }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => state.native }));
vi.mock('@/hooks/use-app-update-blocked', () => ({ useAppUpdateBlocked: () => state.blocked }));
vi.mock('@/lib/app-update-monitor', () => ({ ignoreAppUpdate: () => { state.ignoredBuild = state.update?.required ?? null; } }));
beforeEach(async () => {
  await i18n.changeLanguage('en');
  Object.assign(state, { native: true, blocked: false, checked: true, ignoredBuild: null, update: {
    installed: 76, installedVersion: '1.0.76', required: 77, latest: 79, available: true, bundled: false, downloadUrl: '/xpeed.apk',
  } });
});
afterEach(cleanup);
it('shows the installed version and update action without technical check/reload controls', () => {
  render(<AppVersion />);
  expect(screen.getByTestId('app-version')).toHaveTextContent('Version 1.0.76 (build 76)');
  expect(screen.getByRole('link', { name: 'Update app' })).toHaveAttribute('href', '/xpeed.apk');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('keeps download available while recording, without opening a new WebView window', () => {
  state.blocked = true;
  render(<AppUpdateBanner />);
  expect(screen.getByRole('link', { name: 'Update app' })).not.toHaveAttribute('target');
  expect(screen.getByText(/You can download now/)).toBeInTheDocument();
});
it('hides an ignored notice after navigation but keeps the update accessible in About', () => {
  const view = render(<AppUpdateBanner />);
  fireEvent.click(screen.getByRole('button', { name: 'Later' }));
  view.unmount(); render(<><AppUpdateBanner /><AppVersion /></>);
  expect(screen.queryByText('A new version of Xpeed is available')).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Update app' })).toHaveLength(1);
});
it('does not call an unknown release current and keeps the installed version visible offline', () => {
  state.update = { ...state.update!, required: null, available: false };
  render(<AppVersion />);
  expect(screen.getByTestId('app-version')).toBeInTheDocument();
  expect(screen.getByText(/Updates are checked automatically/)).toBeInTheDocument();
  expect(screen.queryByText('Your app is up to date.')).not.toBeInTheDocument();
});
it('shows no notification or download for a current native installation', () => {
  state.update = { ...state.update!, installed: 77, available: false };
  render(<><AppVersion /><AppUpdateBanner /></>);
  expect(screen.getByText('Your app is up to date.')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
