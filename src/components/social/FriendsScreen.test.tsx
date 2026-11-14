import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { driver, fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { whereNow } from '@/test/sim-render';
import { v1Lap } from '@/test/v1-fake-server';
import { FriendsScreen } from './FriendsScreen';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const row = (handle: string, status: 'accepted' | 'incoming' | 'outgoing' | 'blocked', displayName: string | null = handle) => ({
  handle, displayName, status, since: '2026-11-10T10:00:00.000Z',
});

function seeded(): FakeSocialState {
  return fakeSocialState({
    drivers: [
      driver({ handle: 'pal_one', displayName: 'Pal One', relation: 'friend' }),
      driver({ handle: 'pal_two', displayName: 'Pal Two', relation: 'friend' }),
      driver({ handle: 'asker', displayName: 'Asker', relation: 'incoming' }),
      driver({ handle: 'waiting', displayName: 'Waiting', relation: 'requested' }),
      driver({ handle: 'banned', displayName: 'Banned', relation: 'blocked' }),
      driver({ handle: 'newbie', displayName: 'Newbie' }),
      driver({ handle: 'secret', visibility: 'private' }),
    ],
    friendRows: [
      row('pal_one', 'accepted', 'Pal One'), row('pal_two', 'accepted', null), row('asker', 'incoming', 'Asker'), row('waiting', 'outgoing', 'Waiting'), row('banned', 'blocked', 'Banned'),
    ],
  });
}

const open = async (state: FakeSocialState = seeded(), route = '/virtual/friends') => {
  const view = renderSocial(<FriendsScreen />, { state, route });
  await waitFor(() => expect(document.querySelector('[data-testid^="list-"], [data-testid^="empty-"]')).toBeInTheDocument());
  return view;
};
const tab = (id: string) => fireEvent.mouseDown(screen.getByTestId(`tab-${id}`), { button: 0, ctrlKey: false });
const confirmDialog = async (name: string) => fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name }));

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the friends screen', () => {
  it('opens on the friends, each a link to the profile, a driver with no name shown by the handle alone, and a link to the friends leaderboard', async () => {
    await open();
    const rows = within(screen.getByTestId('list-accepted')).getAllByTestId('friend-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Pal One');
    expect(rows[1]).toHaveTextContent('@pal_two');
    expect(rows[1].textContent).not.toContain('Pal Two');
    expect(within(rows[0]).getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/virtual/drivers/pal_one');
    expect(screen.getByRole('link', { name: /Friends leaderboard/ })).toHaveAttribute('href', '/virtual/leaderboards?scope=friends');
  });

  it('has three tabs, and the Requests tab says how many are waiting for you', async () => {
    await open();
    expect(screen.getByTestId('tab-friends')).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('requests-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('tab-requests')).toBeInTheDocument();
    expect(screen.getByTestId('tab-blocked')).toBeInTheDocument();
  });

  it('takes the number on the Requests tab from the count endpoint, not from the first page of the list', async () => {
    const state = seeded();
    await open(state);
    await waitFor(() => expect(screen.getByTestId('requests-count')).toHaveTextContent('1'));
    expect(callsTo(state, 'GET', '/friends/requests/count').length).toBeGreaterThan(0);
    // The list of requests is only read when its tab is open.
    expect(callsTo(state, 'GET', '/friends').some((call) => call.params.status === 'incoming')).toBe(false);
  });

  it('has no badge when nobody is waiting, and updates it when a request is answered', async () => {
    const state = seeded();
    await open(state);
    await waitFor(() => expect(screen.getByTestId('requests-count')).toHaveTextContent('1'));
    tab('requests');
    fireEvent.click(await within(await screen.findByTestId('list-incoming')).findByTestId('request-decline'));
    await waitFor(() => expect(screen.queryByTestId('requests-count')).not.toBeInTheDocument());
    expect(callsTo(state, 'GET', '/friends/requests/count').length).toBeGreaterThan(1);
  });

  it('Requests: incoming (accept, decline) and outgoing (cancel) in one tab', async () => {
    const state = seeded();
    await open(state);
    tab('requests');
    await screen.findByTestId('panel-requests');
    const incoming = await screen.findByTestId('list-incoming');
    const outgoing = await screen.findByTestId('list-outgoing');
    expect(incoming).toHaveTextContent('Asker');
    expect(outgoing).toHaveTextContent('Waiting');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('tab')).toBe('requests');

    fireEvent.click(within(incoming).getByTestId('request-accept'));
    await waitFor(() => expect(screen.queryByTestId('list-incoming')).not.toBeInTheDocument());
    expect(callsTo(state, 'POST', '/friends/requests/asker/accept')).toHaveLength(1);
    expect(screen.getByTestId('empty-incoming')).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('list-outgoing')).getByTestId('request-cancel'));
    await waitFor(() => expect(screen.queryByTestId('list-outgoing')).not.toBeInTheDocument());
    expect(callsTo(state, 'DELETE', '/friends/waiting')).toHaveLength(1);
  });

  it('Requests: Decline removes the request', async () => {
    const state = seeded();
    await open(state, '/virtual/friends?tab=requests');
    fireEvent.click(await screen.findByTestId('request-decline'));
    await waitFor(() => expect(screen.getByTestId('empty-incoming')).toBeInTheDocument());
    expect(callsTo(state, 'POST', '/friends/requests/asker/decline')).toHaveLength(1);
  });

  it('Blocked: lists the people you blocked (no link to them) and Unblock lifts the block', async () => {
    const state = seeded();
    await open(state);
    tab('blocked');
    const list = await screen.findByTestId('list-blocked');
    expect(list).toHaveTextContent('Banned');
    expect(within(list).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.click(within(list).getByTestId('friend-unblock'));
    await screen.findByTestId('empty-blocked');
    expect(callsTo(state, 'DELETE', '/friends/banned')).toHaveLength(1);
  });

  it('removes a friend only after a confirmation', async () => {
    const state = seeded();
    await open(state);
    fireEvent.click(within(screen.getAllByTestId('friend-row')[0]).getByTestId('friend-remove'));
    expect(callsTo(state, 'DELETE', '/friends/pal_one')).toHaveLength(0);
    await confirmDialog('Remove');
    await waitFor(() => expect(within(screen.getByTestId('list-accepted')).getAllByTestId('friend-row')).toHaveLength(1));
    expect(callsTo(state, 'DELETE', '/friends/pal_one')).toHaveLength(1);
  });

  it('blocks a friend after a confirmation, and the friend moves to Blocked', async () => {
    const state = seeded();
    await open(state);
    fireEvent.click(within(screen.getAllByTestId('friend-row')[0]).getByTestId('friend-block'));
    await confirmDialog('Block');
    await waitFor(() => expect(callsTo(state, 'POST', '/friends/pal_one/block')).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByTestId('list-accepted')).getAllByTestId('friend-row')).toHaveLength(1));
  });

  it('adds a friend by handle: nothing is sent while typing, only on Enter or the button', async () => {
    const state = seeded();
    await open(state);
    const input = screen.getByTestId('friend-handle');
    const before = state.requests.length;
    fireEvent.change(input, { target: { value: '@Newbie' } });
    fireEvent.keyDown(input, { key: 'a' });
    expect(state.requests.length).toBe(before);
    expect(callsTo(state, 'POST', '/friends/requests')).toHaveLength(0);

    fireEvent.submit(input.closest('form')!); // Enter
    const notice = await screen.findByTestId('friend-notice');
    expect(notice).toHaveTextContent('Request sent to @newbie.');
    expect(callsTo(state, 'POST', '/friends/requests')[0].body).toEqual({ handle: 'newbie' });
    expect(input).toHaveValue('');
  });

  it('adds a friend with the button, and says "now friends" when that person had already asked', async () => {
    const state = seeded();
    await open(state);
    fireEvent.change(screen.getByTestId('friend-handle'), { target: { value: 'asker' } });
    fireEvent.click(screen.getByTestId('friend-add'));
    expect(await screen.findByTestId('friend-notice')).toHaveTextContent('You are now friends with @asker.');
  });

  it('keeps the button off until there is a handle', async () => {
    await open();
    expect(screen.getByTestId('friend-add')).toBeDisabled();
    fireEvent.change(screen.getByTestId('friend-handle'), { target: { value: '  ' } });
    expect(screen.getByTestId('friend-add')).toBeDisabled();
  });

  it('says the same thing for a private handle and an unknown one', async () => {
    const state = seeded();
    await open(state);
    const messages: string[] = [];
    for (const handle of ['secret', 'no_such_driver']) {
      fireEvent.change(screen.getByTestId('friend-handle'), { target: { value: handle } });
      fireEvent.click(screen.getByTestId('friend-add'));
      await waitFor(() => expect(callsTo(state, 'POST', '/friends/requests').length).toBe(messages.length + 1));
      const message = await screen.findByTestId('friends-error');
      messages.push(message.textContent ?? '');
    }
    expect(messages[0]).toBe('No driver can be added with this handle.');
    expect(messages[1]).toBe(messages[0]);
  });

  it('says in words when you are already friends, already asked, or yourself', async () => {
    const state = seeded();
    await open(state);
    const attempt = async (handle: string) => {
      fireEvent.change(screen.getByTestId('friend-handle'), { target: { value: handle } });
      fireEvent.click(screen.getByTestId('friend-add'));
      await waitFor(() => expect(screen.getByTestId('friends-error')).toBeInTheDocument());
      return screen.getByTestId('friends-error').textContent;
    };
    expect(await attempt('pal_one')).toBe('You are already friends.');
    expect(await attempt('waiting')).toBe('You already sent a request to this driver.');
    expect(await attempt('lap_fan')).toBe('This cannot be done with yourself.');
  });

  it('shows an empty state for each list', async () => {
    await open(fakeSocialState());
    expect(await screen.findByTestId('empty-accepted')).toHaveTextContent('No friends yet');
    tab('requests');
    expect(await screen.findByTestId('empty-incoming')).toBeInTheDocument();
    expect(await screen.findByTestId('empty-outgoing')).toBeInTheDocument();
  });
});

describe('the friends as cards, with their latest activity', () => {
  const monza = { id: '00000001-0000-4000-8000-000000000001', name: 'Monza' };
  const spa = { id: '00000001-0000-4000-8000-000000000002', name: 'Spa-Francorchamps' };
  const ferrari = { id: '00000002-0000-4000-8000-000000000001', name: 'Ferrari 499P' };
  const lap = (n: number, track: { id: string; name: string }, timeMs: number, achievedAt: string) => ({
    lapId: `10000000-0000-4000-8000-00000000000${n}`, game: 'lmu', track, car: ferrari, timeMs, achievedAt,
  });
  const withLaps = () => {
    const state = seeded();
    state.drivers = state.drivers.map((entry) => {
      if (entry.handle === 'pal_one') return { ...entry, bestLaps: [lap(1, spa, 134_000, '2026-11-01T12:00:00.000Z'), lap(2, monza, 99_500, '2026-11-09T12:00:00.000Z')] };
      if (entry.handle === 'pal_two') return { ...entry, bestLaps: [lap(3, spa, 135_000, '2026-11-08T12:00:00.000Z')] };
      return entry;
    });
    return state;
  };

  it('shows each friend as a card with the initials, since when and their newest personal best', async () => {
    await open(withLaps());
    const cards = screen.getAllByTestId('friend-row');
    expect(within(cards[0]).getByTestId('avatar')).toHaveTextContent('PO');
    expect(cards[0]).toHaveTextContent(/Since .*2026/);
    const activity = await within(cards[0]).findByTestId('friend-activity');
    expect(activity).toHaveTextContent('Monza');
    expect(within(activity).getByTestId('friend-activity-time')).toHaveTextContent('1:39.500');
    expect(activity).not.toHaveTextContent('Spa-Francorchamps');
  });

  it('offers the friends board only for a track and car you both drove', async () => {
    const state = withLaps();
    state.v1.laps = [v1Lap({ track: monza, car: ferrari, timeMs: 99_900 })]; // you drove Monza with the Ferrari, not Spa
    await open(state);
    const cards = screen.getAllByTestId('friend-row');
    const shortcut = await within(cards[0]).findByTestId('friend-board-shortcut');
    expect(shortcut).toHaveAttribute('href', `/virtual/leaderboards?track=${monza.id}&car=${ferrari.id}&game=lmu&scope=friends`);
    await within(cards[1]).findByTestId('friend-activity');
    expect(within(cards[1]).queryByTestId('friend-board-shortcut')).not.toBeInTheDocument();
  });

  it('shows no activity line for a friend with no best lap, and never blocks the card on it', async () => {
    await open(seeded());
    expect(within(screen.getAllByTestId('friend-row')[0]).getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryAllByTestId('friend-activity-loading')).toHaveLength(0));
    expect(screen.queryByTestId('friend-activity')).not.toBeInTheDocument();
  });

  it('reads the driver pages of the first twelve friends only, to stay within the rate limit', async () => {
    const state = fakeSocialState();
    state.drivers = Array.from({ length: 15 }, (_, i) => driver({ handle: `pal_${String(i).padStart(2, '0')}`, displayName: `Pal ${i}`, relation: 'friend' }));
    state.friendRows = state.drivers.map((entry) => row(entry.handle, 'accepted', entry.displayName ?? null));
    await open(state);
    await waitFor(() => expect(screen.getAllByTestId('friend-row')).toHaveLength(15));
    await waitFor(() => expect(screen.queryAllByTestId('friend-activity-loading')).toHaveLength(0));
    expect(state.requests.filter((request) => request.method === 'GET' && request.path.startsWith('/profiles/'))).toHaveLength(12);
  });
});

describe('adding by handle, checked as you type', () => {
  const type = (value: string) => fireEvent.change(screen.getByTestId('friend-handle'), { target: { value } });

  it('says what is wrong with a handle while it is typed, and keeps the button off', async () => {
    await open();
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('Ask for a friendship');
    type('ab');
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('A handle has at least 3 characters.');
    expect(screen.getByTestId('friend-handle')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('friend-add')).toBeDisabled();
    type('has space');
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('Only the letters a to z, the digits 0 to 9 and _ are allowed.');
    type('a'.repeat(25));
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('A handle has at most 24 characters.');
    expect(screen.getByTestId('friend-add')).toBeDisabled();
  });

  it('says a good handle can be sent, accepts a leading @ and capitals, and sends nothing for a bad one on Enter', async () => {
    const state = seeded();
    await open(state);
    type('@New_Pal');
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('This handle can be sent.');
    expect(screen.getByTestId('friend-handle-help')).toHaveAttribute('data-valid', 'true');
    expect(screen.getByTestId('friend-add')).toBeEnabled();
    type('no!');
    fireEvent.submit(screen.getByTestId('friend-handle').closest('form')!);
    expect(callsTo(state, 'POST', '/friends/requests')).toHaveLength(0);
  });

  it('says it in Spanish', async () => {
    await i18n.changeLanguage('es-ES');
    await open();
    type('x');
    expect(screen.getByTestId('friend-handle-help')).toHaveTextContent('Un identificador tiene al menos 3 caracteres.');
  });
});

describe('the requests inbox', () => {
  it('has a clear Accept and Decline for each request, and a count that matches', async () => {
    await open(seeded(), '/virtual/friends?tab=requests');
    const incoming = await screen.findByTestId('list-incoming');
    expect(within(incoming).getByRole('button', { name: /Accept/ })).toBeEnabled();
    expect(within(incoming).getByRole('button', { name: /Decline/ })).toBeEnabled();
    expect(within(incoming).getByTestId('avatar')).toHaveTextContent('A');
    expect(screen.getByRole('heading', { name: 'Asked to be your friend' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Waiting for their answer' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('requests-count')).toHaveTextContent('1'));
  });

  it('blocks from a request only after a confirmation', async () => {
    const state = seeded();
    await open(state, '/virtual/friends?tab=requests');
    fireEvent.click(within(await screen.findByTestId('list-incoming')).getByRole('button', { name: 'Block @asker' }));
    expect(callsTo(state, 'POST', '/friends/asker/block')).toHaveLength(0);
    await confirmDialog('Block');
    await waitFor(() => expect(callsTo(state, 'POST', '/friends/asker/block')).toHaveLength(1));
  });
});
