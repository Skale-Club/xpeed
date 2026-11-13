import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { driver, fakeSocialState, type FakeDriver, type FakeSocialState } from '@/test/social-fake-server';
import { whereNow } from '@/test/sim-render';
import { DriverPage } from './DriverPage';

vi.mock('@/components/sim/SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const bestLap = {
  lapId: '10000000-0000-4000-8000-000000000001', game: 'lmu', track: { id: '00000001-0000-4000-8000-000000000001', name: 'Monza' },
  car: { id: '00000002-0000-4000-8000-000000000001', name: 'Ferrari 499P' }, timeMs: 99_432, achievedAt: '2026-11-10T12:00:00.000Z',
};

const rival = (extra: Partial<FakeDriver> = {}) =>
  driver({ handle: 'rival_one', displayName: 'Rival One', personalBestsCount: 7, bestLaps: [bestLap], gamesPlayed: ['lmu', 'ac'], ...extra });

async function openDriver(state: FakeSocialState, handle: string) {
  const view = renderSocial(
    <Routes>
      <Route path="/virtual/drivers/:handle" element={<DriverPage />} />
      <Route path="/virtual/friends" element={<p>the friends page</p>} />
    </Routes>,
    { state, route: `/virtual/drivers/${handle}` },
  );
  await waitFor(() => expect(screen.queryByTestId('driver-header') ?? screen.queryByTestId('driver-not-found')).toBeInTheDocument());
  return view;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the driver page', () => {
  it('shows the public profile: name, handle, joined date, games, personal bests and best laps with links to the track pages', async () => {
    await openDriver(fakeSocialState({ drivers: [rival()] }), 'rival_one');
    expect(screen.getByTestId('driver-name')).toHaveTextContent('Rival One');
    expect(screen.getByTestId('driver-handle')).toHaveTextContent('@rival_one');
    expect(screen.getByTestId('driver-header')).toHaveTextContent(/Joined .*2026/);
    expect(screen.getByTestId('driver-games')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('driver-games')).toHaveTextContent('Assetto Corsa');
    expect(screen.getByTestId('driver-pbs')).toHaveTextContent('7');
    const lap = screen.getByTestId('driver-best-lap');
    expect(lap).toHaveTextContent('1:39.432');
    expect(lap).toHaveTextContent('Ferrari 499P');
    expect(within(lap).getByTestId('driver-track-link')).toHaveAttribute('href', `/virtual/tracks/${bestLap.track.id}`);
    expect(within(lap).getByRole('link', { name: 'Leaderboard' })).toHaveAttribute('href', expect.stringContaining('/virtual/leaderboards?track='));
  });

  it('shows only the handle for a driver with no display name', async () => {
    await openDriver(fakeSocialState({ drivers: [rival({ displayName: null })] }), 'rival_one');
    expect(screen.queryByTestId('driver-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('driver-handle').textContent).toBe('@rival_one');
  });

  it('a stranger: "Add friend" sends the request and the page then says "Requested"', async () => {
    const state = fakeSocialState({ drivers: [rival()] });
    await openDriver(state, 'rival_one');
    fireEvent.click(screen.getByTestId('action-add'));
    await screen.findByTestId('relation-requested');
    expect(callsTo(state, 'POST', '/friends/requests')[0].body).toEqual({ handle: 'rival_one' });
    expect(screen.queryByTestId('action-add')).not.toBeInTheDocument();
  });

  it('a request you sent: "Requested", and it can be cancelled', async () => {
    const state = fakeSocialState({ drivers: [rival({ relation: 'requested' })], friendRows: [{ handle: 'rival_one', displayName: 'Rival One', status: 'outgoing', since: '2026-11-12T10:00:00.000Z' }] });
    await openDriver(state, 'rival_one');
    expect(screen.getByTestId('relation-requested')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('action-cancel'));
    await screen.findByTestId('action-add');
    expect(callsTo(state, 'DELETE', '/friends/rival_one')).toHaveLength(1);
  });

  it('a request to you: Accept makes you friends, Decline removes it', async () => {
    const state = fakeSocialState({ drivers: [rival({ relation: 'incoming' })], friendRows: [{ handle: 'rival_one', displayName: 'Rival One', status: 'incoming', since: '2026-11-12T10:00:00.000Z' }] });
    await openDriver(state, 'rival_one');
    fireEvent.click(screen.getByTestId('action-accept'));
    await screen.findByTestId('relation-friends');
    expect(callsTo(state, 'POST', '/friends/requests/rival_one/accept')).toHaveLength(1);
  });

  it('a request to you: Decline answers 204 and the page goes back to "Add friend"', async () => {
    const state = fakeSocialState({ drivers: [rival({ relation: 'incoming' })], friendRows: [{ handle: 'rival_one', displayName: 'Rival One', status: 'incoming', since: '2026-11-12T10:00:00.000Z' }] });
    await openDriver(state, 'rival_one');
    fireEvent.click(screen.getByTestId('action-decline'));
    await screen.findByTestId('action-add');
    expect(callsTo(state, 'POST', '/friends/requests/rival_one/decline')).toHaveLength(1);
  });

  it('a friend: shows "Friends" and removes the friendship after a confirmation', async () => {
    const state = fakeSocialState({ drivers: [rival({ relation: 'friend' })], friendRows: [{ handle: 'rival_one', displayName: 'Rival One', status: 'accepted', since: '2026-11-12T10:00:00.000Z' }] });
    await openDriver(state, 'rival_one');
    expect(screen.getByTestId('relation-friends')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('action-remove'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove friend' }));
    await screen.findByTestId('action-add');
    expect(callsTo(state, 'DELETE', '/friends/rival_one')).toHaveLength(1);
  });

  it('Block asks first, blocks, and goes to the Blocked list; the blocked driver then reads as "not found"', async () => {
    const state = fakeSocialState({ drivers: [rival()] });
    await openDriver(state, 'rival_one');
    fireEvent.click(screen.getByTestId('action-block'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('They are not told');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
    await waitFor(() => expect(whereNow(screen.getByTestId('where')).pathname).toBe('/virtual/friends'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('tab')).toBe('blocked');
    expect(callsTo(state, 'POST', '/friends/rival_one/block')).toHaveLength(1);
  });

  it('shows one neutral "Driver not found" page for a private profile, an unknown handle, a blocked one and a hidden one', async () => {
    const state = fakeSocialState({
      drivers: [
        driver({ handle: 'private_one', visibility: 'private' }),
        driver({ handle: 'blocked_one', relation: 'blocked' }),
        driver({ handle: 'hidden_one', hidden: true }),
        driver({ handle: 'friends_only', visibility: 'friends' }),
      ],
    });
    const texts = new Set<string>();
    for (const handle of ['private_one', 'nobody_here', 'blocked_one', 'hidden_one', 'friends_only']) {
      cleanup();
      await openDriver(state, handle);
      expect(screen.getByTestId('driver-not-found')).toHaveTextContent('Driver not found');
      expect(screen.queryByTestId('driver-header')).not.toBeInTheDocument();
      texts.add(screen.getByTestId('driver-not-found').textContent ?? '');
    }
    expect(texts.size).toBe(1); // the very same page for all of them
  });

  it('a friends-only driver shows to a friend', async () => {
    await openDriver(fakeSocialState({ drivers: [driver({ handle: 'friends_only', visibility: 'friends', relation: 'friend' })] }), 'friends_only');
    expect(screen.getByTestId('driver-header')).toBeInTheDocument();
  });

  it('your own page shows "This is you" and a link to the settings, with no friend actions', async () => {
    await openDriver(fakeSocialState(), 'lap_fan');
    expect(screen.getByTestId('driver-me')).toBeInTheDocument();
    expect(screen.queryByTestId('driver-actions')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit your profile' })).toHaveAttribute('href', '/virtual/profile');
  });

  it('Report on a driver offers only the driver and sends the report', async () => {
    const state = fakeSocialState({ drivers: [rival()] });
    await openDriver(state, 'rival_one');
    fireEvent.click(screen.getByTestId('report-button'));
    const dialog = await screen.findByTestId('report-dialog');
    fireEvent.click(within(dialog).getByTestId('report-reason-offensive_name'));
    fireEvent.click(within(dialog).getByTestId('report-send'));
    await screen.findByTestId('report-sent');
    expect(callsTo(state, 'POST', '/reports')[0].body).toEqual({ kind: 'profile', handle: 'rival_one', reason: 'offensive_name' });
  });

  it('says a friend limit in words', async () => {
    const state = fakeSocialState({ drivers: [rival()] });
    await openDriver(state, 'rival_one');
    state.friendRows = Array.from({ length: 200 }, (_, i) => ({ handle: `f${i}`, displayName: null, status: 'accepted' as const, since: '2026-11-01T10:00:00.000Z' }));
    fireEvent.click(screen.getByTestId('action-add'));
    expect(await screen.findByTestId('driver-error')).toHaveTextContent('limit of 200 friends');
  });

  it('is translated', async () => {
    await i18n.changeLanguage('pt-BR');
    await openDriver(fakeSocialState({ drivers: [rival()] }), 'rival_one');
    expect(screen.getByTestId('action-add')).toHaveTextContent('Adicionar amigo');
  });
});
