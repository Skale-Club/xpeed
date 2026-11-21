import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, expect, it, vi } from 'vitest';
import LoginPage from './LoginPage';
import { APK_URL } from '@/lib/app-update';

const native = vi.hoisted(() => ({ available: false }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => native.available } }));
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => true }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/auth/PhoneSignIn', () => ({ PhoneSignIn: () => <input aria-label="Phone login" /> }));
vi.mock('@/components/auth/GoogleIdentityButton', () => ({ GoogleIdentityButton: () => null }));

beforeEach(() => { native.available = false; });

it('gives older APKs an update path instead of offering unavailable native login', () => {
  render(<MemoryRouter><LoginPage /></MemoryRouter>);
  expect(screen.getByRole('link')).toHaveAttribute('href', APK_URL);
  expect(screen.queryByLabelText('Phone login')).not.toBeInTheDocument();
});

it('offers phone login when the installed APK supports Google authentication', () => {
  native.available = true;
  render(<MemoryRouter><LoginPage /></MemoryRouter>);
  expect(screen.getByLabelText('Phone login')).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

it('shows only the sign-in card inside the Companion, with no public page around it', () => {
  window.sessionStorage.setItem('xpeed.shell', 'companion');
  try {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.getByTestId('shell-sign-in')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone login')).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  } finally {
    window.sessionStorage.removeItem('xpeed.shell');
  }
});
