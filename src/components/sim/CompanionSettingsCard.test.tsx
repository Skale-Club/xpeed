import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, v1Device } from '@/test/v1-fake-server';
import { dashboardState } from '@/test/dashboard-fixture';
import { CompanionSettingsCard } from './CompanionSettingsCard';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const open = (state = dashboardState()) => renderSim(<CompanionSettingsCard />, { state, route: '/settings' });

describe('the Companion card in Settings', () => {
  it('says how many computers are connected and how many are online, with a green dot, and links to the page and to the download', async () => {
    // The computer was heard from at 11:00 UTC; at 11:01 it is online.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    open();
    expect(await screen.findByText('1 computer connected · 1 online now')).toBeInTheDocument();
    expect(screen.getByTestId('settings-companion-dot')).toHaveClass('bg-success');
    expect(screen.getByTestId('settings-companion-manage')).toHaveAttribute('href', '/virtual/companion');
    expect(screen.getByTestId('settings-companion-download')).toHaveAttribute('href', '/companion');
  });

  it('is grey when no computer was heard from lately, and counts several computers', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:30:00.000Z') });
    const state = dashboardState();
    state.devices = [...state.devices, v1Device({ name: 'Laptop', pairedAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-11-12T08:00:00.000Z' })];
    open(state);
    expect(await screen.findByText('2 computers connected · 0 online now')).toBeInTheDocument();
    expect(screen.getByTestId('settings-companion-dot')).not.toHaveClass('bg-success');
    expect(screen.getByTestId('settings-companion-dot')).toHaveAttribute('aria-label', 'Offline');
  });

  it('invites to connect one when no computer is paired, without a dot', async () => {
    const state = dashboardState();
    state.devices = [];
    open(state);
    expect(await screen.findByText(/Connect Xpeed Companion on the computer you race on/)).toBeInTheDocument();
    expect(screen.queryByTestId('settings-companion-dot')).not.toBeInTheDocument();
    expect(screen.getByTestId('settings-companion-download')).toBeInTheDocument();
  });

  it('writes the summary in Portuguese for a Portuguese reader', async () => {
    await i18n.changeLanguage('pt-BR');
    open(fakeV1State({ devices: dashboardState().devices }));
    expect(await screen.findByText(/1 computador conectado/)).toBeInTheDocument();
  });
});
