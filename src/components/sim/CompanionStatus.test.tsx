import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, v1Device } from '@/test/v1-fake-server';
import { dashboardState } from '@/test/dashboard-fixture';
import { CompanionStatus } from './CompanionStatus';

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

const open = (state = dashboardState()) => renderSim(<CompanionStatus />, { state, route: '/virtual' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('the Companion status in the header', () => {
  it('is one quiet line: a dot and the name of the computer, linking to the Companion screen', async () => {
    // The computer was heard from at 11:00 UTC; at 11:01 it is online.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    open();
    const status = await screen.findByTestId('companion-status');
    expect(status).toHaveAttribute('href', '/virtual/companion');
    expect(status).toHaveAttribute('data-state', 'online');
    expect(within(status).getByTestId('companion-device')).toHaveTextContent('Racing PC');
    expect(within(status).getByTestId('companion-dot')).toHaveClass('bg-success');
    // Nothing else is written in the line: the last lap is in the label and in the tooltip.
    expect(status.textContent).toBe('Racing PC');
    expect(status.getAttribute('aria-label')).toMatch(/^Xpeed Companion: Online, Racing PC\. last lap 1:48\.000 · Monza · Ferrari 499P · \S+/);
  });

  it('says the state and the last lap in the tooltip', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    open();
    const status = await screen.findByTestId('companion-status');
    fireEvent.focus(status);
    const tip = (await screen.findAllByTestId('companion-tooltip'))[0];
    expect(tip).toHaveTextContent('Online · Racing PC');
    expect(tip).toHaveTextContent(/last lap 1:48\.000 · Monza · Ferrari 499P/);
  });

  it('is grey and says Offline when the server has not heard from any computer for more than three minutes, and green when one was heard from in the last three', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:10:00.000Z') });
    open();
    expect(await screen.findByTestId('companion-status')).toHaveAttribute('data-state', 'offline');
    expect(screen.getByTestId('companion-dot')).not.toHaveClass('bg-success');
    expect(screen.getByTestId('companion-status').getAttribute('aria-label')).toContain('Offline');
    cleanup();
    // Two computers: one that was heard from a minute ago is enough.
    const two = dashboardState();
    two.devices = [...two.devices, v1Device({ name: 'Laptop', pairedAt: '2026-10-01T00:00:00.000Z', lastSeenAt: '2026-11-13T11:09:00.000Z', version: '0.7.0', state: 'waiting' })];
    open(two);
    const status = await screen.findByTestId('companion-status');
    expect(status).toHaveAttribute('data-state', 'online');
    expect(screen.getByTestId('companion-device')).toHaveTextContent('Laptop +1');
  });

  it('decides by when the computer was last seen alone, so an older server that sends no state still works', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    const state = dashboardState();
    // The devices of an older server carry no version, state, game or stateAt at all (not even null).
    expect(Object.keys(state.devices[0]).sort()).toEqual(['id', 'lastLapAt', 'lastSeenAt', 'name', 'pairedAt']);
    open(state);
    expect(await screen.findByTestId('companion-status')).toHaveAttribute('data-state', 'online');
  });

  it('says there is no lap yet when a computer is paired and nothing was received', async () => {
    const state = fakeV1State({ devices: dashboardState().devices });
    open(state);
    const status = await screen.findByTestId('companion-status');
    expect(status.getAttribute('aria-label')).toContain('No lap received yet');
  });

  it('shows nothing when no computer is paired (the Overview carries the invitation), nor while the first read fails', async () => {
    const empty = dashboardState();
    empty.devices = [];
    open(empty);
    await settle();
    expect(screen.queryByTestId('companion-status')).not.toBeInTheDocument();
    cleanup();
    const down = fakeV1State();
    down.failing = { status: 503, error: 'unavailable', retryable: true };
    open(down);
    await settle();
    expect(screen.queryByTestId('companion-status')).not.toBeInTheDocument();
  });

  it('writes its label in Portuguese for a Portuguese reader', async () => {
    await i18n.changeLanguage('pt-BR');
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    open();
    const status = await screen.findByTestId('companion-status');
    expect(status.getAttribute('aria-label')).toMatch(/Online/);
    expect(status.getAttribute('aria-label')).not.toMatch(/\bSim\b/);
  });
});
