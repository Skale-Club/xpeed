import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSocial, callsTo } from '@/test/social-render';
import { boardKey, fakeSocialState, ranked, type FakeSocialState } from '@/test/social-fake-server';
import { ref, v1Lap, v1Session } from '@/test/v1-fake-server';
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

/** The address of a board: game, track and car (the lists come before it, see "finding a board"). */
const boardRoute = (track = monza, car = ferrari, extra = '') => `/virtual/leaderboards?game=lmu&track=${track.id}&car=${car.id}${extra}`;
const open = async (state: FakeSocialState, route = boardRoute()) => {
  const view = renderSocial(<LeaderboardScreen />, { state, route });
  await screen.findByTestId('board-table');
  return view;
};
const rows = () => screen.getAllByTestId('board-row');

beforeEach(async () => {
  layout.available = false;
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the leaderboard screen', () => {
  it('asks the server for the board the address names', async () => {
    const state = seeded();
    await open(state);
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

  it('highlights your row and labels it "You"; Report is on the other rows, and your lap is analysed from the position card', async () => {
    const state = seeded();
    await open(state);
    const mine = rows().find((row) => row.getAttribute('data-me') === 'true')!;
    expect(mine).toHaveAttribute('aria-current', 'true');
    expect(mine.className).toContain('bg-primary');
    expect(within(mine).getByTestId('board-you')).toBeInTheDocument();
    expect(within(mine).queryByTestId('report-button')).not.toBeInTheDocument();
    for (const row of rows().filter((row) => row !== mine)) expect(within(row).getByTestId('report-button')).toBeInTheDocument();
    // One way to look at your lap, not one per row.
    expect(screen.queryByTestId('board-compare')).not.toBeInTheDocument();
    const analyze = await screen.findByTestId('board-me-compare');
    expect(analyze).toHaveTextContent('Analyze my lap');
    expect(analyze).toHaveAttribute('href', expect.stringMatching(/^\/virtual\/compare\?a=/));
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
    renderSocial(<LeaderboardScreen />, { state, route: boardRoute() });
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

  it('shows only the handle for a driver with no display name', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'quiet_one', displayName: null, timeMs: 99_000 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    const link = within(rows()[0]).getByRole('link', { name: '@quiet_one' });
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

});

describe('finding a board: a game, then a track, then a car', () => {
  const imola = ref('Imola');
  const bmw = ref('BMW M Hybrid V8');
  const laguna = ref('Laguna Seca');
  const entry = (r: { id: string; name: string }, lapCount = 40, game = 'lmu') => ({ id: r.id, game, name: r.name, lapCount });
  const listed = () => screen.getAllByTestId('board-track').map((card) => card.getAttribute('data-track-id'));

  it('opens on the tracks of the game, not on a board: yours first, then the others with public laps', async () => {
    const state = seeded();
    state.v1.tracks = [{ ...trackItem(spa), lastDrivenAt: '2026-11-12T12:00:00.000Z' }, trackItem(monza)];
    state.catalog = { tracks: [entry(imola), entry(monza)], cars: [] };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await waitFor(() => expect(listed()).toEqual([spa.id, monza.id, imola.id]));
    expect(screen.queryByTestId('board-table')).not.toBeInTheDocument();
    expect(callsTo(state, 'GET', '/leaderboard')).toHaveLength(0);
    // Nothing is written for the person: the address stays as it was.
    expect(whereNow(screen.getByTestId('where')).search).toBe('');
    expect(screen.getAllByTestId('board-track')[2]).toHaveAttribute('href', `/virtual/leaderboards?game=lmu&track=${imola.id}`);
  });

  it('says on each track your best there and how many public laps it has', async () => {
    const state = seeded();
    state.catalog = { tracks: [entry(imola, 12), entry(monza, 40)], cars: [] };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await waitFor(() => expect(listed()).toHaveLength(3));
    const card = (id: string) => screen.getAllByTestId('board-track').find((item) => item.getAttribute('data-track-id') === id)!;
    expect(within(card(monza.id)).getByTestId('board-track-mine')).toHaveTextContent('Your best 1:39.000');
    expect(within(card(monza.id)).getByTestId('board-track-public')).toHaveTextContent('Public laps: 40');
    expect(within(card(spa.id)).getByTestId('board-track-public')).toHaveTextContent('No public laps yet');
    expect(within(card(imola.id)).queryByTestId('board-track-mine')).not.toBeInTheDocument();
  });

  it('has a tab for each game, the one driven last first, and a tab shows the tracks of its game', async () => {
    const state = seeded();
    state.v1.tracks = [trackItem(monza), trackItem(spa), { ...trackItem(laguna, 'acevo'), lastDrivenAt: '2026-11-15T12:00:00.000Z' }];
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    const tabs = await screen.findByTestId('board-game-tabs');
    expect(within(tabs).getAllByRole('tab').map((tab) => tab.getAttribute('data-testid'))).toEqual(['board-game-acevo', 'board-game-lmu']);
    await waitFor(() => expect(listed()).toEqual([laguna.id]));
    fireEvent.mouseDown(screen.getByTestId('board-game-lmu'), { button: 0, ctrlKey: false });
    await waitFor(() => expect(listed()).toEqual([monza.id, spa.id]));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('game')).toBe('lmu');
  });

  it('searches a long list of tracks, ignoring case and accents', async () => {
    const state = seeded();
    const many = Array.from({ length: 10 }, (_, i) => entry(ref(`Extra ${i}`)));
    state.catalog = { tracks: [...many, entry(ref('Autódromo José Carlos Pace'))], cars: [] };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    const search = await screen.findByTestId('board-track-search');
    fireEvent.change(search, { target: { value: 'autodromo jose' } });
    expect(screen.getAllByTestId('board-track')).toHaveLength(1);
    expect(screen.getByTestId('board-track')).toHaveTextContent('Autódromo José Carlos Pace');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByTestId('board-tracks-none')).toHaveTextContent('Nothing matches what you typed.');
  });

  it('reads a long catalog page by page until it is whole', async () => {
    const state = seeded();
    state.catalog = { tracks: Array.from({ length: 120 }, (_, i) => entry({ id: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Extra ${String(i).padStart(3, '0')}` })), cars: [] };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await waitFor(() => expect(listed()).toHaveLength(122));
    expect(callsTo(state, 'GET', '/leaderboards/catalog').filter((call) => call.params.kind === 'track')).toHaveLength(3);
  });

  it('opens a track on its cars that have a board there: yours first with your best, then the others with public laps', async () => {
    const state = seeded();
    state.v1.laps = [v1Lap({ game: 'lmu', track: monza, car: ferrari, timeMs: 99_000, valid: true })];
    state.catalog = { tracks: [entry(monza)], cars: [entry(bmw, 7), entry(ferrari, 30), entry(toyota, 5)] };
    state.boards.set(boardKey(monza.id, bmw.id, 'public'), { entries: ranked([{ handle: 'bmw_ace', timeMs: 98_000 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...bmw, class: null } });
    renderSocial(<LeaderboardScreen />, { state, route: `/virtual/leaderboards?game=lmu&track=${monza.id}` });
    const list = await screen.findByTestId('board-cars');
    // Toyota has public laps in the game, but none on this track: it has no board here.
    await waitFor(() => expect(within(list).getAllByTestId('board-car').map((row) => row.getAttribute('data-car-id'))).toEqual([ferrari.id, bmw.id]));
    const [mine, other] = within(list).getAllByTestId('board-car');
    expect(within(mine).getByTestId('board-car-mine')).toHaveTextContent('1:39.000');
    expect(within(mine).getByTestId('board-car-public')).toHaveTextContent('Public laps: 30');
    expect(within(other).queryByTestId('board-car-mine')).not.toBeInTheDocument();
    expect(other).toHaveAttribute('href', `/virtual/leaderboards?game=lmu&track=${monza.id}&car=${bmw.id}`);
    expect(callsTo(state, 'GET', '/leaderboards/catalog').some((call) => call.params.kind === 'car' && call.params.track === monza.id)).toBe(true);
    expect(screen.getByTestId('board-track-title')).toHaveTextContent('Monza');
    expect(screen.getByTestId('board-crumbs')).toHaveTextContent('All games');
    expect(screen.getByTestId('board-crumb-here')).toHaveTextContent('Monza');
  });

  it('says when a track has no board yet', async () => {
    const state = seeded();
    renderSocial(<LeaderboardScreen />, { state, route: `/virtual/leaderboards?game=lmu&track=${spa.id}` });
    expect(await screen.findByTestId('board-cars-none')).toHaveTextContent('No boards on this track yet');
  });

  it('leads back from a board to its track and its game', async () => {
    await open(seeded());
    const crumbs = screen.getAllByTestId('board-crumb');
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['All games', 'Le Mans Ultimate', 'Monza']);
    expect(crumbs[1]).toHaveAttribute('href', '/virtual/leaderboards?game=lmu');
    expect(crumbs[2]).toHaveAttribute('href', `/virtual/leaderboards?game=lmu&track=${monza.id}`);
    expect(screen.getByTestId('board-crumb-here')).toHaveTextContent('Ferrari 499P');
  });

  it('lets a driver with nothing driven browse the tracks with public laps', async () => {
    const state = fakeSocialState();
    state.catalog = { tracks: [entry(imola)], cars: [entry(bmw)] };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    await waitFor(() => expect(listed()).toEqual([imola.id]));
    expect(screen.queryByTestId('board-nothing-driven')).not.toBeInTheDocument();
  });

  it('invites a driver with nothing driven to drive a lap first when no track has public laps either', async () => {
    const state = fakeSocialState();
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('board-nothing-driven')).toHaveTextContent('Drive a lap first');
    expect(callsTo(state, 'GET', '/leaderboards/catalog').length).toBeGreaterThan(0);
  });

  it('is an honest error, not an empty list, when the server does not answer', async () => {
    const state = seeded();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSocial(<LeaderboardScreen />, { state, route: '/virtual/leaderboards' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('board-nothing-driven')).not.toBeInTheDocument();
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

  it('has no podium below three drivers: the table says it all', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'a_one', timeMs: 99_000 }, { handle: 'b_two', timeMs: 99_500 }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    expect(screen.queryByTestId('board-podium')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(2);
  });

  it('says each thing once when you are alone on the board: no podium, no gap column, "You lead" instead of the same time twice', async () => {
    const state = seeded();
    state.boards.set(boardKey(monza.id, ferrari.id, 'public'), { entries: ranked([{ handle: 'lap_fan', displayName: 'Lap Fan', timeMs: 102_609, isMe: true }]), game: 'lmu', track: { ...monza, lengthM: null }, car: { ...ferrari, class: null } });
    await open(state);
    expect(screen.queryByTestId('board-podium')).not.toBeInTheDocument();
    expect(screen.queryByTestId('board-gap')).not.toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveTextContent('Gap');
    const place = await screen.findByTestId('board-me-place');
    expect(place).toHaveAttribute('data-kind', 'alone');
    expect(place).toHaveTextContent('Only you on this board so far.');
    expect(screen.queryByTestId('board-me-time')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('board-stat-yours')).toHaveTextContent('You lead'));
    expect(screen.getByTestId('board-stat-fastest')).toHaveTextContent('1:42.609');
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

describe('the address of a board', () => {
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
