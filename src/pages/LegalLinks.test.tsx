import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/lib/i18n';
import CompanionPage from './CompanionPage';
import LoginPage from './LoginPage';

// The Privacy Policy and the Terms of Use are linked from the login page, the public Companion page and Settings.
vi.mock('@/lib/obd/native-ble', () => ({ isNativeApp: () => false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/components/auth/PhoneSignIn', () => ({ PhoneSignIn: () => null }));
vi.mock('@/components/auth/GoogleIdentityButton', () => ({ GoogleIdentityButton: () => null }));

beforeEach(async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) } as Response)));
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const expectLegalLinks = () => {
  expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy');
  expect(screen.getByRole('link', { name: 'Terms of Use' })).toHaveAttribute('href', '/terms');
};

it('the login page footer links to both', () => {
  render(<MemoryRouter><LoginPage /></MemoryRouter>);
  expectLegalLinks();
});

it('the public Companion page footer links to both', async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter><CompanionPage /></MemoryRouter>
    </QueryClientProvider>,
  );
  await act(() => new Promise<void>((done) => setTimeout(done, 20)));
  expectLegalLinks();
});
