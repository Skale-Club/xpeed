import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { boardKey, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref, v1Session } from '@/test/v1-fake-server';
import { whereNow } from '@/test/sim-render';
import { circle, makeLayout } from '@/test/track-fixture';
import { LeaderboardScreen } from './LeaderboardScreen';

vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
// The shape of the circuit: the layout file is "downloaded" only when a test says the account has one.
const layout = vi.hoisted(() => ({ available: false }));
vi.mock('@/lib/sim/account-tracks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/account-tracks')>()),
  downloadAccountTrack: async () => (layout.available ? new Blob(['layout']) : null),
}));
vi.mock('@/lib/sim/read-track-file', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sim/read-track-file')>()),
  readTrackFile: async () => makeLayout({ points: circle(100, 40), closed: true }),
}));

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

/** The searchable pickers: opening one (focus) lists its options; choosing is a click on an option. */
const optionsOf = (testId: string) => within(screen.getByTestId(`${testId}-list`)).queryAllByRole('option');
const openPicker = (testId: string) => {
  fireEvent.focus(screen.getByTestId(testId));
  return screen.getByTestId(`${testId}-list`);
};
const choose = (testId: string, label: string) => {
  openPicker(testId);
  fireEvent.click(optionsOf(testId).find((option) => option.textContent === label)!);
};

beforeEach(async () => {
  layout.available = false;
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
    expect(screen.getByTestId('board-track')).toHaveAttribute('data-value', monza.id);
    expect(screen.getByTestId('board-track')).toHaveValue('Monza');
    expect(screen.getByTestId('board-car')).toHaveAttribute('data-value', ferrari.id);
    expect(screen.getByTestId('board-car')).toHaveValue('Ferrari 499P');
    const call = callsTo(state, 'GET', '/leaderboard')[0];
    expect(call.params).toMatchObject({ track: monza.id, car: ferrari.id, scope: 'public', game: 'lmu' });
    expect(screen.getByTestId('board-title')).toHaveTextContent('Monza');
    expect(screen.getByTestId('board-hero')).toHaveTextContent('Ferrari 499P');
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
    choose('board-track', 'Spa-Francorchamps');
    await waitFor(() => expect(screen.getByTestId('leaderboards')).toHaveTextContent('Spa Ace'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBe(spa.id);
  });

  it('shows only the handle for a driver with no display name', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'quiet_one', displayName: null, timeMs: 99_000 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    const link = within(rows()[0]).getByRole('link', { name: '@quiet_one' });
    expect(link).toHaveAttribute('href', '/virtual/drivers/quiet_one');
    expect(link.textContent).toBe('@quiet_one');
    // The podium says the same, once.
    expect(within(screen.getByTestId('podium-step')).getByRole('link', { name: '@quiet_one' }).textContent).toBe('@quiet_one');
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
    openPicker('board-track');
    await waitFor(() => expect(optionsOf('board-track')).toHaveLength(3));
    const groupsOf = (testId: string) => within(screen.getByTestId(`${testId}-list`)).getAllByRole('group').map((group) => [group.getAttribute('aria-label'), within(group).getAllByRole('option').map((option) => option.textContent)]);
    // Driven: Monza, Spa (in the order of the driven list); not driven: Imola.
    expect(groupsOf('board-track')).toEqual([['Driven by you', ['Monza', 'Spa-Francorchamps']], ['With public laps', ['Imola']]]);
    fireEvent.keyDown(screen.getByTestId('board-track'), { key: 'Escape' });
    openPicker('board-car');
    await waitFor(() => expect(optionsOf('board-car')).toHaveLength(3));
    expect(groupsOf('board-car').map(([, names]) => names)).toEqual([['Ferrari 499P', 'Toyota GR010'], ['BMW M Hybrid V8']]);
    // The catalog was asked for the game of the latest session, tracks and cars separately.
    expect(callsTo(state, 'GET', '/leaderboards/catalog').map((call) => [call.params.kind, call.params.game]).sort()).toEqual([['car', 'lmu'], ['track', 'lmu']]);
  });

  it('opens the board of a track nobody on this account drove, and writes it in the address', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(imola), entry(monza), entry(spa)], cars: [entry(ferrari)] };
    state.boards.set(boardKey(imola.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'imola_ace', displayName: 'Imola Ace', timeMs: 91_000 }]), game: 'lmu', track: { ...imola, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    openPicker('board-track');
    await waitFor(() => expect(optionsOf('board-track')).toHaveLength(3));
    choose('board-track', 'Imola');
    await waitFor(() => expect(screen.getByTestId('leaderboards')).toHaveTextContent('Imola Ace'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBe(imola.id);
  });

  it('has no headings when there is nothing but the tracks you drove, and never lists one twice', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(monza), entry(spa)], cars: [entry(ferrari), entry(toyota)] };
    await open(state);
    await waitFor(() => expect(callsTo(state, 'GET', '/leaderboards/catalog')).toHaveLength(2));
    openPicker('board-track');
    expect(within(screen.getByTestId('board-track-list')).queryAllByRole('group')).toHaveLength(0);
    expect(optionsOf('board-track').map((option) => option.textContent)).toEqual(['Monza', 'Spa-Francorchamps']);
  });

  it('reads a long catalog page by page until it is whole', async () => {
    const state = seeded();
    state.catalog = { tracks: Array.from({ length: 120 }, (_, i) => entry({ id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Extra ${String(i).padStart(3, '0')}` })), cars: [] };
    await open(state);
    openPicker('board-track');
    await waitFor(() => expect(optionsOf('board-track')).toHaveLength(122));
    expect(callsTo(state, 'GET', '/leaderboards/catalog').filter((call) => call.params.kind === 'track')).toHaveLength(3);
  });

  it('lets a driver with nothing driven open a board from the catalog instead of inviting them to drive', async () => {
    const state = fakeSocialState();
    state.catalog = { tracks: [entry(imola)], cars: [entry(bmw)] };
    state.boards.set(boardKey(imola.id, bmw.id, 'public'), { entries: ranked([{ handle: 'imola_ace', displayName: 'Imola Ace', timeMs: 91_000 }]), game: 'lmu', track: { ...imola, lengthM: null }, car: { ...bmw, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await screen.findByTestId('board-table');
    expect(screen.queryByTestId('board-nothing-driven')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-track')).toHaveAttribute('data-value', imola.id);
    expect(screen.getByTestId('board-car')).toHaveAttribute('data-value', bmw.id);
    expect(screen.getByTestId('leaderboards')).toHaveTextContent('Imola Ace');
  });

  it('still invites a driver with nothing driven when no board has public laps either', async () => {
    const state = fakeSocialState();
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('board-nothing-driven')).toBeInTheDocument();
    expect(callsTo(state, 'GET', '/leaderboards/catalog').length).toBeGreaterThan(0);
  });
});

describe('the competitive board: hero, podium, your position, gap bars', () => {
  it('has a hero with the track, the car and the game, how many drivers there are, the fastest time and yours', async () => {
    await open(seeded());
    const hero = screen.getByTestId('board-hero');
    expect(within(hero).getByTestId('board-title')).toHaveTextContent('Monza');
    expect(hero).toHaveTextContent('Ferrari 499P');
    expect(within(hero).getByTestId('board-car-class')).toHaveTextContent('Hypercar');
    expect(within(hero).getByTestId('board-length')).toHaveTextContent('5.8 km');
    expect(within(hero).getByTestId('session-game')).toHaveTextContent('Le Mans Ultimate');
    await waitFor(() => expect(within(hero).getByTestId('board-stat-drivers')).toHaveTextContent('25'));
    expect(within(hero).getByTestId('board-stat-fastest')).toHaveTextContent('1:39.000');
    expect(within(hero).getByTestId('board-stat-yours')).toHaveTextContent('1:40.650');
    expect(within(hero).getByTestId('board-track-page')).toHaveAttribute('href', `/virtual/tracks/${monza.id}`);
  });

  it('draws the map of the circuit in the hero when Xpeed Companion sent its layout, a quiet placeholder when not', async () => {
    const state = seeded();
    state.v1.tracks = [{ ...trackItem(monza), hasLayout: true, layoutId: 'layout-1' }, trackItem(spa)];
    layout.available = true;
    await open(state);
    const map = await screen.findByTestId('track-thumb');
    expect(map).toHaveAttribute('role', 'img');
    expect(map).toHaveAttribute('aria-label', 'Map of Monza');
    expect(map.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    cleanup();
    layout.available = false;
    await open(seeded());
    expect(screen.getByTestId('board-hero')).toContainElement(screen.getByTestId('track-thumb-none'));
    expect(screen.queryByTestId('track-thumb')).not.toBeInTheDocument();
  });

  it('puts the top three on a podium with the winner in the middle, and a tie shares a step (1, 2, 2)', async () => {
    await open(seeded());
    const steps = screen.getAllByTestId('podium-step');
    expect(steps.map((step) => step.getAttribute('data-rank'))).toEqual(['2', '1', '2']);
    const winner = steps[1];
    expect(within(winner).getByTestId('podium-name')).toHaveTextContent('Driver 1');
    expect(within(winner).getByTestId('podium-time')).toHaveTextContent('1:39.000');
    expect(within(winner).getByTestId('podium-gap')).toHaveTextContent('Leader');
    expect(within(steps[0]).getByTestId('podium-gap')).toHaveTextContent('+0.150');
    expect(within(winner).getByTestId('avatar')).toHaveTextContent('D1');
    expect(within(winner).getByRole('link', { name: /Driver 1/ })).toHaveAttribute('href', '/virtual/drivers/driver_01');
  });

  it('shows a board of two drivers as two steps, in rank order', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'a_one', timeMs: 99_000 }, { handle: 'b_two', timeMs: 99_500 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    expect(screen.getAllByTestId('podium-step').map((step) => step.getAttribute('data-rank'))).toEqual(['1', '2']);
  });

  it('outlines your step on the podium when you are on it, and the sentence says so', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), {
      entries: ranked([{ handle: 'a_one', timeMs: 99_000 }, { handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 99_500, isMe: true }, { handle: 'c_three', timeMs: 99_900 }, { handle: 'd_four', timeMs: 100_400 }]),
      game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null },
    });
    await open(state);
    const mine = screen.getAllByTestId('podium-step').find((step) => step.getAttribute('data-me') === 'true')!;
    expect(within(mine).getByTestId('podium-you')).toBeInTheDocument();
    expect(await screen.findByTestId('board-me-place')).toHaveAttribute('data-kind', 'podium');
    expect(screen.getByTestId('board-me-place')).toHaveTextContent('You are 2nd of 4, on the podium and 0.500 s from the leader.');
  });

  it('says where you stand in one sentence: the place, the gap to the podium and the gap to the leader', async () => {
    await open(seeded());
    const sentence = await screen.findByTestId('board-me-place');
    expect(sentence).toHaveAttribute('data-kind', 'field');
    expect(sentence).toHaveTextContent('You are 12th of 25, 1.50 s from the podium and 1.65 s from the leader.');
    expect(screen.getByTestId('board-me-time')).toHaveTextContent('1:40.650');
  });

  it.each([
    ['pt-BR', 'Você é o 12º de 25, a 1,50 s do pódio e a 1,65 s do líder.'],
    ['es-ES', 'Eres el 12.º de 25, a 1,50 s del podio y a 1,65 s del líder.'],
  ])('says it in %s, with the decimal mark of the language', async (language, text) => {
    await i18n.changeLanguage(language);
    await open(seeded());
    expect(await screen.findByTestId('board-me-place')).toHaveTextContent(text);
  });

  it('says it when you lead, with how far ahead of the next driver', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), {
      entries: ranked([{ handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 99_000, isMe: true }, { handle: 'b_two', timeMs: 99_412 }, { handle: 'c_three', timeMs: 99_900 }]),
      game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null },
    });
    await open(state);
    expect(await screen.findByTestId('board-me-place')).toHaveTextContent('You are 1st of 3, 0.412 s ahead of the next driver.');
    expect(screen.getByTestId('board-me-place')).toHaveAttribute('data-kind', 'leader');
  });

  it('draws the spread of the field with you on it, and says it in words for a screen reader', async () => {
    await open(seeded());
    const spread = await screen.findByTestId('board-spread');
    expect(within(spread).getByRole('img')).toHaveAccessibleName('The field: fastest 1:39.000, you 1:40.650, slowest shown 1:42.600');
    expect(within(spread).getAllByTestId('spread-dot').length).toBeGreaterThan(10);
    expect(within(spread).getAllByTestId('spread-me')).toHaveLength(1);
    expect(within(spread).getByTestId('spread-podium')).toBeInTheDocument();
  });

  it('gives every row a bar for its gap to the leader: none for the leader, the longest for the slowest, yours in the brand colour', async () => {
    await open(seeded());
    const bars = rows().map((row) => Number(within(row).getByTestId('board-gap-bar').getAttribute('data-share')));
    expect(bars[0]).toBe(0);
    expect(bars[bars.length - 1]).toBe(1);
    expect(bars.every((share, i) => i === 0 || share >= bars[i - 1])).toBe(true);
    const mine = rows().find((row) => row.getAttribute('data-me') === 'true')!;
    expect(within(mine).getByTestId('board-gap-bar').className).toContain('bg-primary');
    // The bar is decoration: the gap is written next to it.
    expect(within(mine).getByTestId('board-gap-bar').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(within(mine).getByTestId('board-gap')).toHaveTextContent('+1.650');
  });

  it('copies the address of the board', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await open(seeded());
    fireEvent.click(screen.getByTestId('board-copy-link'));
    await waitFor(() => expect(screen.getByTestId('board-copy-link')).toHaveTextContent('Link copied'));
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

describe('the searchable track and car pickers', () => {
  const imola = ref('Imola');
  const entry = (r: { id: string; name: string }) => ({ id: r.id, game: 'lmu', name: r.name, lapCount: 40 });

  it('narrows the list as you type, ignoring case and accents, and says so when nothing matches', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(imola), entry(monza), entry(spa), entry(ref('Autódromo José Carlos Pace'))], cars: [] };
    await open(state);
    const field = screen.getByTestId('board-track');
    openPicker('board-track');
    await waitFor(() => expect(optionsOf('board-track')).toHaveLength(4));
    fireEvent.change(field, { target: { value: 'autodromo jose' } });
    expect(optionsOf('board-track').map((option) => option.textContent)).toEqual(['Autódromo José Carlos Pace']);
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(screen.getByTestId('board-track-empty')).toHaveTextContent('Nothing matches what you typed.');
  });

  it('is a combobox a keyboard can drive: arrows move, Enter chooses, Escape closes without changing anything', async () => {
    await open(seeded());
    const field = screen.getByTestId('board-track');
    expect(field).toHaveAttribute('role', 'combobox');
    expect(field).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    const active = () => document.getElementById(field.getAttribute('aria-activedescendant') ?? '')?.textContent;
    expect(active()).toBe('Monza');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(active()).toBe('Spa-Francorchamps');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveAttribute('aria-expanded', 'false');
    expect(field).toHaveAttribute('data-value', monza.id);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBe(spa.id));
    expect(field).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the track, the car, the game and the scope in the address, so the board can be linked to', async () => {
    const state = seeded();
    state.boards.set(boardKey(spa.id, toyota.id, 'friends'), { entries: ranked([{ handle: 'spa_ace', timeMs: 135_000 }]), game: 'lmu', track: { ...spa, lengthM: null }, car: { ...toyota, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: `/virtual/leaderboards?track=${spa.id}&car=${toyota.id}&game=lmu&scope=friends` });
    await screen.findByTestId('board-table');
    const search = whereNow(screen.getByTestId('where')).searchParams;
    expect([search.get('track'), search.get('car'), search.get('game'), search.get('scope')]).toEqual([spa.id, toyota.id, 'lmu', 'friends']);
    expect(callsTo(state, 'GET', '/leaderboard')[0].params).toMatchObject({ track: spa.id, car: toyota.id, game: 'lmu', scope: 'friends' });
  });
});
