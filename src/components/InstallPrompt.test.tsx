import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { InstallPrompt } from './InstallPrompt';
import { APK_URL } from '@/lib/app-update';
import { installKind } from '@/lib/device';

const native = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => native.on }));

const ANDROID = navigator.userAgent; // test setup runs as an Android phone
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const asDevice = (ua: string) => Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => {
  cleanup();
  asDevice(ANDROID);
  native.on = false;
  localStorage.clear();
});

describe('install offer', () => {
  it('knows which install fits each device', () => {
    expect(installKind()).toBe('android');
    asDevice(IPHONE);
    expect(installKind()).toBe('ios');
    asDevice(WINDOWS);
    expect(installKind()).toBe('other');
    native.on = true;
    expect(installKind()).toBe('native');
  });

  it('offers the Android app with how to install it, once', () => {
    render(<InstallPrompt />);
    expect(screen.getByText('Get the Android app')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /download the app/i })).toHaveAttribute('href', APK_URL);
    expect(screen.getByText(/allow installing apps from this browser/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('install-prompt')).not.toBeInTheDocument();
    cleanup();
    render(<InstallPrompt />);
    expect(screen.queryByTestId('install-prompt')).not.toBeInTheDocument();
  });

  it('on iPhone: Safari steps and no Bluetooth, never the Android app', () => {
    asDevice(IPHONE);
    render(<InstallPrompt />);
    expect(screen.getByText(/Add to Home Screen/, { selector: 'p' })).toBeInTheDocument();
    expect(screen.getByTestId('iphone-no-bluetooth')).toHaveTextContent(/Safari has no Bluetooth/);
    expect(screen.queryByTestId('android-app-download')).not.toBeInTheDocument();
  });

  it('shows nothing inside the Android app or on a computer', () => {
    native.on = true;
    render(<InstallPrompt />);
    expect(screen.queryByTestId('install-prompt')).not.toBeInTheDocument();
    cleanup();
    native.on = false;
    asDevice(WINDOWS);
    render(<InstallPrompt />);
    expect(screen.queryByTestId('install-prompt')).not.toBeInTheDocument();
  });
});
