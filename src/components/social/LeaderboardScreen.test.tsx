import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { boardKey, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref, v1Session } from '@/test/v1-fake-server';
import { whereNow } from '@/test/sim-render';
import { LeaderboardScreen } from './LeaderboardScreen';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const toyota = ref('Toyota GR010');

const trackItem = (r: { id: string; name: string }, game = 'lmu') => ({
  id: r.id, game, name: r.name, lengthM: 5000, lapCount: 5, validLapCount: 5, sessionCount: 1, carCount: 1, bestLapMs: 99_000, lastDrivenAt: '2026-11-10T12:00:00.000Z',
});
const carItem = (r: { id: string; name: string }, game = 'lmu') => ({
  id: r.id, game, name: r.name, brand: null, class: null, lapCount: 5, validLapCount: 5, sessionCount: 1, trackCount: 1, bestLapMs: 99_000, lastDrivenAt: '2026-11-10T12:00:00.000Z',
});

/** 25 drivers: me 12th with a tie right above (two at 100.300), plus a tie for second. */
function twentyFive() {
  const rows = Array.from({ length: 25 }, (_, i) => ({ handle: `driver_${String(i + 1).padStart(2, '0')}`, displayName: `Driver ${i + 1}`, timeMs: 99_000 + i * 150 }));
  rows[2].timeMs = rows[1].timeMs; // ranks 1, 2, 2, 4...
  rows[11] = { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 100_650 };
  return ranked(rows.map((row) => ({ ...row, isMe: row.handle === 'lap_fan' })));
}

function seeded(extra: Partial<FakeSocialState> = {}): FakeSocialState {
  const state = fakeSocialState(extra);
  state.v1.tracks = [trackItem(monza), trackItem(spa)];
  state.v1.cars = [carItem(ferrari), carItem(toyota)];
  state.v1.sessions = [v1Session({ track: monza, car: ferrari, startedAt: '2026-11-12T18:00:00.000Z', lapCount: 3, bestLapMs: 99_000 })];
  const entries = twentyFive();
  state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries, game: 'lmu', track: { ...monza, lengthM: 5793 }, car: { ...ferrari, class: 'Hypercar' } });
  state.boards.set(boardKey(monza.id, ferrari.id, 'friends'), {
    entries: ranked([{ handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 100_900, isMe: true }, { handle: 'ana_friend', displayName: 'Ana', timeMs: 99_900 }]),
    game: 'lmu', track: { ...monza, lengthM: 5793 }, car: { ...ferrari, class: 'Hypercar' },
  });
  return state;
}

const open = async (state: FakeSocialState, route = '/virtual/leaderboards') => {
  const view = renderSocial(<LeaderboardScreen />, { state, route });
  await screen.findByTestId('board-table');
  return view;
};
const rows = () => screen.getAllByTestId('board-row');

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the leaderboard screen', () => {
  it('opens on the track and car the driver used most recently and asks the server for that board', async () => {
    const state = seeded();
    await open(state);
    expect(screen.getByTestId('board-track')).toHaveValue(monza.id);
    expect(screen.getByTestId('board-car')).toHaveValue(ferrari.id);
    const call = callsTo(state, 'GET', '/leaderboard')[0];
    expect(call.params).toMatchObject({ track: monza.id, car: ferrari.id, scope: 'public', game: 'lmu' });
    expect(screen.getByTestId('leaderboards')).toHaveTextContent('Monza · Ferrari 499P');
  });

  it('ranks with ties (1, 2, 2, 4), shows the time, the gap to the leader and a link to each driver', async () => {
    await open(seeded());
    const ranks = rows().map((row) => within(row).getByTestId('board-rank').textContent);
    expect(ranks.slice(0, 5)).toEqual(['1', '2', '2', '4', '5']);
    const first = rows()[0];
    expect(within(first).getByTestId('board-time')).toHaveTextContent('1:39.000');
    expect(within(first).getByTestId('board-gap')).toHaveTextContent('–');
    expect(within(rows()[3]).getByTestId('board-gap')).toHaveTextContent('+0.450');
    expect(within(first).getByRole('link', { name: /Driver 1/ })).toHaveAttribute('href', '/virtual/drivers/driver_01');
  });

  it('highlights your row, labels it "You" and offers Compare only on your own lap', async () => {
    const state = seeded();
    await open(state);
    const mine = rows().find((row) => row.getAttribute('data-me') === 'true')!;
    expect(mine).toHaveAttribute('aria-current', 'true');
    expect(mine.className).toContain('bg-primary');
    expect(within(mine).getByTestId('board-you')).toBeInTheDocument();
    expect(within(mine).getByTestId('board-compare')).toHaveAttribute('href', expect.stringMatching(/^\/virtual\/compare\?a=/));
    expect(within(mine).queryByTestId('report-button')).not.toBeInTheDocument();
    const others = rows().filter((row) => row !== mine);
    for (const row of others) {
      expect(within(row).queryByTestId('board-compare')).not.toBeInTheDocument();
      expect(within(row).getByTestId('report-button')).toBeInTheDocument();
    }
  });

  it('says where you stand ("You are 12th of 25") with the drivers around you', async () => {
    await open(seeded());
    const strip = await screen.findByTestId('board-me');
    expect(within(strip).getByTestId('board-me-place')).toHaveTextContent('You are 12th of 25');
    expect(within(strip).getAllByTestId('neighbour-name')).toHaveLength(5);
    expect(within(strip).getByTestId('board-neighbours')).toHaveTextContent('Lap Fan');
  });

  it('writes the place in the language of the person', async () => {
    await i18n.changeLanguage('pt-BR');
    await open(seeded());
    expect(await screen.findByTestId('board-me-place')).toHaveTextContent('Você é o 12º de 25');
  });

  it('explains why you are not listed, by the reason the server gives', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), {
      entries: ranked([{ handle: 'a', timeMs: 99_000 }, { handle: 'b', timeMs: 99_500 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null },
    });
    await open(state);
    const note = await screen.findByTestId('board-not-listed');
    expect(note).toHaveTextContent('You are not listed because your profile is private, or your lap is not valid.');
    expect(within(note).getByRole('link', { name: 'Change who can see you' })).toHaveAttribute('href', '/virtual/profile');
  });

  it('says "No public laps for this track and car yet" for an empty board, and still explains you are not listed', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: [], game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('board-empty')).toHaveTextContent('No public laps for this track and car yet.');
    expect(await screen.findByTestId('board-not-listed')).toBeInTheDocument();
  });

  it('has Public and Friends tabs: Friends asks for scope=friends, shows the friends board and keeps it in the address', async () => {
    const state = seeded();
    await open(state);
    expect(screen.getByTestId('scope-public')).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseDown(screen.getByTestId('scope-friends'), { button: 0, ctrlKey: false });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(callsTo(state, 'GET', '/leaderboard').some((call) => call.params.scope === 'friends')).toBe(true);
    expect(within(rows()[0]).getByRole('link', { name: /Ana/ })).toHaveAttribute('href', '/virtual/drivers/ana_friend');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('scope')).toBe('friends');
  });

  it('opens on the friends board when the address says so, and the not-listed text names the friends board', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'friends'), { entries: ranked([{ handle: 'ana_friend', timeMs: 99_900 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: `/virtual/leaderboards?track=${monza.id}&car=${ferrari.id}&scope=friends` });
    expect(await screen.findByTestId('board-not-listed')).toHaveTextContent('no valid lap on this track and car');
    expect(screen.getByTestId('scope-friends')).toHaveAttribute('aria-selected', 'true');
  });

  it('pages: 50 rows, then "Load more" reads the next page', async () => {
    const state = seeded();
    const many = ranked(Array.from({ length: 70 }, (_, i) => ({ handle: `p${i}`, timeMs: 90_000 + i * 10, isMe: i === 3 })));
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: many, game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    expect(rows()).toHaveLength(50);
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(rows()).toHaveLength(70));
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
    expect(callsTo(state, 'GET', '/leaderboard').some((call) => call.params.cursor)).toBe(true);
  });

  it('changes the board when another track is picked, and writes the choice in the address', async () => {
    const state = seeded();
    state.boards.set(boardKey(spa.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'spa_ace', displayName: 'Spa Ace', timeMs: 135_000 }]), game: 'lmu', track: { ...spa, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    fireEvent.change(screen.getByTestId('board-track'), { target: { value: spa.id } });
    await waitFor(() => expect(screen.getByTestId('leaderboards')).toHaveTextContent('Spa Ace'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBe(spa.id);
  });

  it('shows only the handle for a driver with no display name', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'quiet_one', displayName: null, timeMs: 99_000 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    const link = screen.getByRole('link', { name: '@quiet_one' });
    expect(link).toHaveAttribute('href', '/virtual/drivers/quiet_one');
    expect(link.textContent).toBe('@quiet_one');
  });

  it('has a Report button on other drivers\' rows that opens the report dialog for the lap or the driver', async () => {
    await open(seeded());
    const row = rows().find((entry) => entry.getAttribute('data-me') === 'false')!;
    fireEvent.click(within(row).getByTestId('report-button'));
    const dialog = await screen.findByTestId('report-dialog');
    expect(within(dialog).getByText('This lap')).toBeInTheDocument();
    expect(within(dialog).getByText(/The driver @driver_/)).toBeInTheDocument();
  });

  it('invites a driver with nothing driven to drive a lap first', async () => {
    const state = fakeSocialState();
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('board-nothing-driven')).toHaveTextContent('Drive a lap first');
  });

  it('is an honest error, not an empty board, when the server does not answer', async () => {
    const state = seeded();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('board-empty')).not.toBeInTheDocument();
  });
});

describe('the leaderboard catalog in the pickers', () => {
  const imola = ref('Imola');
  const bmw = ref('BMW M Hybrid V8');
  const entry = (r: { id: string; name: string }, lapCount = 40, game = 'lmu') => ({ id: r.id, game, name: r.name, lapCount });

  it('lists the tracks and cars you drove first, then the others that have public laps, under their own headings', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(imola), entry(monza), entry(spa)], cars: [entry(bmw), entry(ferrari), entry(toyota)] };
    await open(state);
    await waitFor(() => expect(within(screen.getByTestId('board-track')).getAllByRole('option')).toHaveLength(3));
    const track = screen.getByTestId('board-track') as HTMLSelectElement;
    // Driven: Monza, Spa (in the order of the driven list); not driven: Imola.
    expect([...track.querySelectorAll('optgroup')].map((group) => [group.label, [...group.querySelectorAll('option')].map((option) => option.textContent)])).toEqual([
      ['Driven by you', ['Monza', 'Spa-Francorchamps']], ['With public laps', ['Imola']],
    ]);
    const car = screen.getByTestId('board-car') as HTMLSelectElement;
    expect([...car.querySelectorAll('optgroup')].map((group) => [...group.querySelectorAll('option')].map((option) => option.textContent))).toEqual([
      ['Ferrari 499P', 'Toyota GR010'], ['BMW M Hybrid V8'],
    ]);
    // The catalog was asked for the game of the latest session, tracks and cars separately.
    expect(callsTo(state, 'GET', '/leaderboards/catalog').map((call) => [call.params.kind, call.params.game]).sort()).toEqual([['car', 'lmu'], ['track', 'lmu']]);
  });

  it('opens the board of a track nobody on this account drove, and writes it in the address', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(imola), entry(monza), entry(spa)], cars: [entry(ferrari)] };
    state.boards.set(boardKey(imola.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'imola_ace', displayName: 'Imola Ace', timeMs: 91_000 }]), game: 'lmu', track: { ...imola, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    await waitFor(() => expect(within(screen.getByTestId('board-track')).getAllByRole('option')).toHaveLength(3));
    fireEvent.change(screen.getByTestId('board-track'), { target: { value: imola.id } });
    await waitFor(() => expect(screen.getByTestId('leaderboards')).toHaveTextContent('Imola Ace'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBe(imola.id);
  });

  it('has no headings when there is nothing but the tracks you drove, and never lists one twice', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(monza), entry(spa)], cars: [entry(ferrari), entry(toyota)] };
    await open(state);
    await waitFor(() => expect(callsTo(state, 'GET', '/leaderboards/catalog')).toHaveLength(2));
    expect(screen.getByTestId('board-track').querySelectorAll('optgroup')).toHaveLength(0);
    expect(within(screen.getByTestId('board-track')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Monza', 'Spa-Francorchamps']);
  });

  it('reads a long catalog page by page until it is whole', async () => {
    const state = seeded();
    state.catalog = { tracks: Array.from({ length: 120 }, (_, i) => entry({ id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Extra ${String(i).padStart(3, '0')}` })), cars: [] };
    await open(state);
    await waitFor(() => expect(within(screen.getByTestId('board-track')).getAllByRole('option')).toHaveLength(122));
    expect(callsTo(state, 'GET', '/leaderboards/catalog').filter((call) => call.params.kind === 'track')).toHaveLength(3);
  });

  it('lets a driver with nothing driven open a board from the catalog instead of inviting them to drive', async () => {
    const state = fakeSocialState();
    state.catalog = { tracks: [entry(imola)], cars: [entry(bmw)] };
    state.boards.set(boardKey(imola.id, bmw.id, 'public'), { entries: ranked([{ handle: 'imola_ace', displayName: 'Imola Ace', timeMs: 91_000 }]), game: 'lmu', track: { ...imola, lengthM: null }, car: { ...bmw, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await screen.findByTestId('board-table');
    expect(screen.queryByTestId('board-nothing-driven')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-track')).toHaveValue(imola.id);
    expect(screen.getByTestId('board-car')).toHaveValue(bmw.id);
    expect(screen.getByTestId('leaderboards')).toHaveTextContent('Imola Ace');
  });

  it('still invites a driver with nothing driven when no board has public laps either', async () => {
    const state = fakeSocialState();
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('board-nothing-driven')).toBeInTheDocument();
    expect(callsTo(state, 'GET', '/leaderboards/catalog').length).toBeGreaterThan(0);
  });
});
