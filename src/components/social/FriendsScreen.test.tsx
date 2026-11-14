import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { driver, fakeSocialState, type FakeSocialState } from '@/test/social-fake-server';
import { whereNow } from '@/test/sim-render';
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
