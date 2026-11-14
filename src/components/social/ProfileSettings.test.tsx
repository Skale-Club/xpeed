import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { driver, fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { ProfileSettings } from './ProfileSettings';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const open = async (state: FakeSocialState = fakeSocialState()) => {
  const view = renderSocial(<ProfileSettings />, { state, route: '/virtual/profile' });
  await screen.findByTestId('profile-handle');
  return view;
};
const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the profile settings', () => {
  it('shows the handle, the display name and the visibility, and says the profile starts public', async () => {
    await open();
    expect(screen.getByTestId('profile-handle')).toHaveValue('lap_fan');
    expect(screen.getByTestId('profile-name')).toHaveValue('Lap Fan');
    expect(screen.getByTestId('visibility-public')).toBeChecked();
    expect(screen.getByTestId('profile-starts-public')).toHaveTextContent('starts public');
  });

  it('explains every visibility choice in plain words', async () => {
    await open();
    const picker = screen.getByTestId('visibility-picker');
    expect(picker).toHaveTextContent('Public');
    expect(picker).toHaveTextContent('Friends only');
    expect(picker).toHaveTextContent('Private');
    expect(picker).toHaveTextContent('Any signed-in driver can open your page');
    expect(picker).toHaveTextContent('Only your friends can open your page');
    expect(picker).toHaveTextContent('Nobody can open your page or find you');
  });

  it('shows how many handle changes are left, and when the next one comes back', async () => {
    const state = fakeSocialState();
    state.me = { ...state.me, handleChangesLeft: 2, handleChangesResetAt: '2026-12-13T09:00:00.000Z' };
    await open(state);
    const text = screen.getByTestId('handle-changes').textContent ?? '';
    expect(text).toContain('You can change your handle 2 more times in 30 days (up to 3).');
    expect(text).toMatch(/The next one comes back on .*2026/);
    expect(screen.getByTestId('profile-handle')).not.toBeDisabled();
  });

  it('locks the handle and says when it can change again when no changes are left', async () => {
    const state = fakeSocialState();
    state.me = { ...state.me, handleChangesLeft: 0, handleChangesResetAt: '2026-12-01T09:00:00.000Z' };
    await open(state);
    expect(screen.getByTestId('handle-changes').textContent).toMatch(/You have no handle changes left\. You can change it again on .*2026/);
    expect(screen.getByTestId('profile-handle')).toBeDisabled();
  });

  it('saves nothing until something changes, then sends only what changed with PATCH', async () => {
    const state = fakeSocialState();
    await open(state);
    const save = screen.getByTestId('profile-save');
    expect(save).toBeDisabled();
    type('profile-name', '  The Fan ');
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByTestId('profile-saved');
    const patches = callsTo(state, 'PATCH', '/profile');
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ displayName: 'The Fan' });
    expect(patches[0].authorization).toBe('Bearer token');
    expect(state.me.displayName).toBe('The Fan');
    expect(screen.getByTestId('profile-save')).toBeDisabled();
  });

  it('sends the visibility with PATCH when another choice is made and saved', async () => {
    const state = fakeSocialState();
    await open(state);
    fireEvent.click(screen.getByTestId('visibility-friends'));
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-saved');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ visibility: 'friends' });
    expect(state.me.visibility).toBe('friends');
    expect(screen.getByTestId('visibility-friends')).toBeChecked();
  });

  it('lower-cases the handle, uses it in the PATCH and shows the new count of changes', async () => {
    const state = fakeSocialState();
    await open(state);
    type('profile-handle', 'Turbo_Fan');
    expect(screen.getByTestId('profile-handle')).toHaveValue('turbo_fan');
    fireEvent.click(screen.getByTestId('profile-save'));
    await screen.findByTestId('profile-saved');
    expect(callsTo(state, 'PATCH', '/profile')[0].body).toEqual({ handle: 'turbo_fan' });
    expect(screen.getByTestId('handle-changes')).toHaveTextContent('2 more times');
  });

  it('shows "taken" under the handle field when the server says so', async () => {
    const state = fakeSocialState({ drivers: [driver({ handle: 'taken_one' })] });
    await open(state);
    type('profile-handle', 'taken_one');
    fireEvent.click(screen.getByTestId('profile-save'));
    const message = await screen.findByTestId('error-handle');
    expect(message).toHaveTextContent('This handle is taken. Choose another one.');
    expect(screen.queryByTestId('error-displayName')).not.toBeInTheDocument();
    expect(screen.getByTestId('profile-handle')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows "reserved" under the handle field, and a handle of the wrong shape is refused as you type', async () => {
    const fakeState = fakeSocialState();
    await open(fakeState);
    type('profile-handle', 'admin');
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByTestId('error-handle')).toHaveTextContent('This handle is reserved.');
    // A handle that cannot be one is said so as you type, and cannot be saved (the server is not asked).
    type('profile-handle', 'a!');
    expect(screen.getByTestId('handle-live')).toHaveTextContent('Only the letters a to z, the digits 0 to 9 and _ are allowed.');
    expect(screen.getByTestId('profile-handle')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    expect(callsTo(fakeState, 'PATCH', '/profile')).toHaveLength(1); // only the "admin" attempt above reached the server
  });

  it('shows the 30-day limit under the handle field', async () => {
    const state = fakeSocialState();
    await open(state);
    state.me = { ...state.me, handleChangesLeft: 0 }; // the limit was reached in another tab
    type('profile-handle', 'fresh_name');
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByTestId('error-handle')).toHaveTextContent('You changed your handle 3 times in the last 30 days.');
  });

  it('shows a display name the server refuses under the name field', async () => {
    await open();
    type('profile-name', 'me@home');
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByTestId('error-displayName')).toHaveTextContent('cannot look like an e-mail address');
  });

  it('says so without blaming a field when the server is down', async () => {
    const state = fakeSocialState();
    await open(state);
    type('profile-name', 'New');
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    fireEvent.click(screen.getByTestId('profile-save'));
    expect(await screen.findByTestId('profile-error')).toHaveTextContent('The server is not answering right now.');
    expect(screen.getByTestId('profile-save')).toBeEnabled();
  });

  it('lists the share links of the person and revokes one', async () => {
    const state = fakeSocialState();
    state.shares = [
      { id: '20000000-0000-4000-8000-000000000001', kind: 'lap', lapId: 'l1', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-000000000002', kind: 'session', lapId: null, sessionId: 's1', createdAt: '2026-11-11T10:00:00.000Z', expiresAt: '2026-11-30T10:00:00.000Z', revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-000000000003', kind: 'lap', lapId: 'l2', sessionId: null, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: null, revokedAt: '2026-11-02T10:00:00.000Z', active: false },
    ];
    await open(state);
    const section = await screen.findByTestId('my-shared-links');
    await waitFor(() => expect(within(section).getAllByTestId('share-row')).toHaveLength(2)); // the revoked one is not listed
    expect(section).toHaveTextContent('Lap link');
    expect(section).toHaveTextContent('Session link');
    // No address of any link is shown: only the server's own copy of the token existed, once.
    expect(section.textContent).not.toMatch(/\/s\//);
    fireEvent.click(within(section).getAllByTestId('share-revoke')[0]);
    // Revoking asks first: nothing is sent until it is confirmed.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Revoke this link?');
    expect(callsTo(state, 'DELETE', '/shares/20000000-0000-4000-8000-000000000001')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(section).getAllByTestId('share-row')).toHaveLength(1));
    expect(callsTo(state, 'DELETE', '/shares/20000000-0000-4000-8000-000000000001')).toHaveLength(1);
  });

  it('says what each link is about: the track, the car and the lap time, or the kind and the laps of the session', async () => {
    const state = fakeSocialState();
    state.shares = [
      { id: '20000000-0000-4000-8000-000000000001', kind: 'lap', lapId: 'l1', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true,
        trackName: 'Monza', carName: 'Ferrari 499P', lapMs: 99_123, sessionKind: null, lapCount: null },
      { id: '20000000-0000-4000-8000-000000000002', kind: 'session', lapId: null, sessionId: 's1', createdAt: '2026-11-11T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true,
        trackName: 'Spa-Francorchamps', carName: 'Toyota GR010', lapMs: null, sessionKind: 'race', lapCount: 12 },
      { id: '20000000-0000-4000-8000-000000000003', kind: 'session', lapId: null, sessionId: 's2', createdAt: '2026-11-10T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true,
        trackName: 'Imola', carName: 'BMW M Hybrid V8', lapMs: null, sessionKind: 'unknown', lapCount: 1 },
      // A server that does not say: the row is as it was.
      { id: '20000000-0000-4000-8000-000000000004', kind: 'lap', lapId: 'l4', sessionId: null, createdAt: '2026-11-09T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
    ];
    await open(state);
    const section = await screen.findByTestId('my-shared-links');
    await waitFor(() => expect(within(section).getAllByTestId('share-row')).toHaveLength(4));
    const about = within(section).getAllByTestId('share-about').map((line) => line.textContent);
    expect(about).toEqual(['Monza · Ferrari 499P · 1:39.123', 'Spa-Francorchamps · Toyota GR010 · Race · 12 laps', 'Imola · BMW M Hybrid V8 · 1 laps']);
    expect(within(within(section).getAllByTestId('share-row')[3]).queryByTestId('share-about')).not.toBeInTheDocument();
  });

  it('is translated', async () => {
    await i18n.changeLanguage('es-ES');
    await open();
    expect(screen.getByTestId('visibility-picker')).toHaveTextContent('Solo amigos');
    expect(screen.getByTestId('profile-starts-public')).toHaveTextContent('empieza público');
  });
});


describe('the profile page as a settings page', () => {
  it('opens with who you are now: the avatar, the name and handle, who can see it and since when', async () => {
    await open();
    const summary = screen.getByTestId('profile-summary');
    expect(within(summary).getByTestId('avatar')).toHaveTextContent('LF');
    expect(within(summary).getByTestId('profile-summary-name')).toHaveTextContent('Lap Fan');
    expect(within(summary).getByTestId('profile-summary-name')).toHaveTextContent('@lap_fan');
    expect(within(summary).getByTestId('profile-summary-visibility')).toHaveTextContent('Public');
    expect(summary).toHaveTextContent(/Joined .*2026/);
    expect(within(summary).getByRole('link', { name: 'Your page: @lap_fan' })).toHaveAttribute('href', '/virtual/drivers/lap_fan');
  });

  it('previews how others will see you as the name and the handle are typed', async () => {
    await open();
    type('profile-name', 'Turbo Fan');
    type('profile-handle', 'turbo_fan');
    const preview = screen.getByTestId('profile-preview');
    expect(within(preview).getByTestId('profile-preview-name')).toHaveTextContent('Turbo Fan');
    expect(within(preview).getByTestId('profile-preview-name')).toHaveTextContent('@turbo_fan');
    expect(within(preview).getByTestId('avatar')).toHaveTextContent('TF');
  });

  it('checks the handle as you type: wrong shapes are said in words, a fine one says it will be checked on save', async () => {
    await open();
    expect(screen.getByTestId('handle-live')).toHaveTextContent('');
    type('profile-handle', 'ab');
    expect(screen.getByTestId('handle-live')).toHaveTextContent('A handle has at least 3 characters.');
    expect(screen.getByTestId('profile-save')).toBeDisabled();
    type('profile-handle', 'a'.repeat(25));
    expect(screen.getByTestId('handle-live')).toHaveTextContent('A handle has at most 24 characters.');
    type('profile-handle', 'new_handle');
    expect(screen.getByTestId('handle-live')).toHaveTextContent('Whether it is free is checked when you save.');
    expect(screen.getByTestId('profile-save')).toBeEnabled();
  });

  it('draws the handle changes as pips, one for each change left', async () => {
    const state = fakeSocialState();
    state.me = { ...state.me, handleChangesLeft: 1, handleChangesResetAt: '2026-12-13T09:00:00.000Z' };
    await open(state);
    expect(screen.getByTestId('handle-pips')).toHaveAccessibleName('1 of 3 handle changes left');
    expect(screen.getByTestId('handle-pips').querySelectorAll('.bg-primary')).toHaveLength(1);
  });

  it('shows what each visibility choice lets others see, in the picker', async () => {
    await open();
    const shows = (option: string) => [...screen.getByTestId(`visibility-shows-${option}`).querySelectorAll('li')].map((row) => row.getAttribute('data-shows'));
    expect(shows('public')).toEqual(['yes', 'yes', 'yes', 'yes']);
    expect(shows('friends')).toEqual(['no', 'yes', 'yes', 'yes']);
    expect(shows('private')).toEqual(['no', 'no', 'no', 'no']);
    expect(screen.getByTestId('visibility-shows-friends')).toHaveTextContent('Public leaderboards');
  });

  it('shows the links as cards with their status, and the expired and revoked ones only when asked', async () => {
    const state = fakeSocialState();
    state.shares = [
      { id: '20000000-0000-4000-8000-000000000001', kind: 'lap', lapId: 'l1', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true },
      { id: '20000000-0000-4000-8000-000000000002', kind: 'session', lapId: null, sessionId: 's1', createdAt: '2026-11-01T10:00:00.000Z', expiresAt: '2026-11-08T10:00:00.000Z', revokedAt: null, active: false },
      { id: '20000000-0000-4000-8000-000000000003', kind: 'lap', lapId: 'l2', sessionId: null, createdAt: '2026-11-01T10:00:00.000Z', expiresAt: null, revokedAt: '2026-11-02T10:00:00.000Z', active: false },
    ];
    await open(state);
    const section = await screen.findByTestId('my-shared-links');
    await waitFor(() => expect(within(section).getAllByTestId('share-row')).toHaveLength(1));
    expect(within(section).getByTestId('share-count')).toHaveTextContent('Live links: 1');
    expect(within(section).getByTestId('share-status')).toHaveTextContent('Active');
    fireEvent.click(within(section).getByTestId('share-show-ended'));
    const cards = within(section).getAllByTestId('share-row');
    expect(cards.map((card) => card.getAttribute('data-status'))).toEqual(['active', 'expired', 'revoked']);
    expect(cards[1]).toHaveTextContent(/Expired .*2026/);
    expect(cards[2]).toHaveTextContent(/Revoked .*2026/);
    // Only a live link can be revoked.
    expect(within(cards[1]).queryByTestId('share-revoke')).not.toBeInTheDocument();
    expect(section).toHaveTextContent('cannot be copied again');
  });

  it('keeps a link when the question is answered with Cancel', async () => {
    const state = fakeSocialState();
    state.shares = [{ id: '20000000-0000-4000-8000-000000000001', kind: 'lap', lapId: 'l1', sessionId: null, createdAt: '2026-11-12T10:00:00.000Z', expiresAt: null, revokedAt: null, active: true }];
    await open(state);
    fireEvent.click(await screen.findByTestId('share-revoke'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(callsTo(state, 'DELETE', '/shares/20000000-0000-4000-8000-000000000001')).toHaveLength(0);
    expect(screen.getAllByTestId('share-row')).toHaveLength(1);
  });

  it('says it in Portuguese: the preview rows and the live handle message', async () => {
    await i18n.changeLanguage('pt-BR');
    await open();
    expect(screen.getByTestId('visibility-shows-public')).toHaveTextContent('Classificações públicas');
    type('profile-handle', 'a!');
    expect(screen.getByTestId('handle-live')).toHaveTextContent('Só são permitidas as letras de a a z');
  });
});
