import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { driver, fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { enterDemo, leaveDemo } from '@/lib/sim/demo/mode';
import { HandleGate } from './HandleGate';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/components/AppLayout', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));

const placeholder = () => {
  const state = fakeSocialState();
  state.me = { ...state.me, handle: 'driver_wgcdme', displayName: 'Driver WGCD', handleChosen: false };
  return state;
};
const open = (state: FakeSocialState) => renderSocial(<HandleGate><p data-testid="virtual-screen">screen</p></HandleGate>, { state, route: '/virtual' });
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  leaveDemo();
});

describe('the username step', () => {
  it('lets the screen handle a profile read failure', async () => {
    const state = placeholder();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    open(state);
    await screen.findByTestId('virtual-screen');
    expect(callsTo(state, 'GET', '/profile')).toHaveLength(1);
    expect(screen.queryByTestId('choose-handle')).toBeNull();
  });

  it('accepts a legacy profile response without the choice flag', async () => {
    const state = placeholder();
    Reflect.deleteProperty(state.me, 'handleChosen');
    open(state);
    await screen.findByTestId('virtual-screen');
    expect(screen.queryByTestId('choose-handle')).toBeNull();
  });

  it('opens the requested nested session route after choosing a username', async () => {
    const state = placeholder();
    renderSocial(
      <Routes>
        <Route element={<HandleGate />}>
          <Route path="/virtual/sessions/:id" element={<p data-testid="session-screen">session</p>} />
        </Route>
      </Routes>,
      { state, route: '/virtual/sessions/session-123?lap=2' },
    );
    await screen.findByTestId('choose-handle');
    expect(screen.queryByTestId('session-screen')).toBeNull();
    type('choose-handle-input', 'vanildo');
    fireEvent.click(screen.getByTestId('choose-save'));
    await screen.findByTestId('session-screen');
    expect(screen.getByTestId('where')).toHaveTextContent('/virtual/sessions/session-123?lap=2');
  });

  it('lets someone who already chose a username straight through', async () => {
    open(fakeSocialState());
    await screen.findByTestId('virtual-screen');
    expect(screen.queryByTestId('choose-handle')).toBeNull();
  });

  it('asks for a username, instead of the screen, while the handle is still the generated one', async () => {
    open(placeholder());
    await screen.findByTestId('choose-handle');
    expect(screen.queryByTestId('virtual-screen')).toBeNull();
    expect(screen.getByTestId('choose-handle-input')).toHaveValue('');
  });

  it('refuses to continue without a valid username, without asking the server', async () => {
    const state = placeholder();
    open(state);
    await screen.findByTestId('choose-handle');
    fireEvent.click(screen.getByTestId('choose-save'));
    expect(screen.getByTestId('choose-handle-live')).toHaveTextContent('Choose a username to continue.');
    type('choose-handle-input', 'a-b');
    expect(screen.getByTestId('choose-handle-live')).toHaveTextContent('Only the letters a to z');
    expect(callsTo(state, 'PATCH', '/profile')).toHaveLength(0);
  });

  it('saves the username and the name, uses the username as the name when it is left empty, and then opens the screen', async () => {
    const state = placeholder();
    open(state);
    await screen.findByTestId('choose-handle');
    type('choose-handle-input', '  Vanildo_Racing ');
    expect(screen.getByTestId('choose-preview-name')).toHaveTextContent('@vanildo_racing');
    fireEvent.click(screen.getByTestId('choose-save'));
    await screen.findByTestId('virtual-screen');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ handle: 'vanildo_racing', displayName: 'vanildo_racing' });
    expect(state.me).toMatchObject({ handle: 'vanildo_racing', displayName: 'vanildo_racing', handleChosen: true, handleChangesLeft: 3 });
  });

  it('sends the display name when one is typed', async () => {
    const state = placeholder();
    open(state);
    await screen.findByTestId('choose-handle');
    type('choose-handle-input', 'vanildo');
    type('choose-name-input', ' Vanildo ');
    fireEvent.click(screen.getByTestId('choose-save'));
    await screen.findByTestId('virtual-screen');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ handle: 'vanildo', displayName: 'Vanildo' });
  });

  it('says so under the field when the username is taken, and stays on the step', async () => {
    const state = placeholder();
    state.drivers = [driver({ handle: 'taken_one' })];
    open(state);
    await screen.findByTestId('choose-handle');
    type('choose-handle-input', 'taken_one');
    fireEvent.click(screen.getByTestId('choose-save'));
    expect(await screen.findByTestId('choose-error-handle')).toBeInTheDocument();
    expect(screen.queryByTestId('virtual-screen')).toBeNull();
  });

  it('is not in the example', async () => {
    enterDemo();
    open(placeholder());
    await screen.findByTestId('virtual-screen');
    expect(screen.queryByTestId('choose-handle')).toBeNull();
  });
});
