import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { formatDistance, formatDuration, rangeStorageKey } from '@/lib/sim/dashboard';
import { renderSim } from '@/test/sim-render';
import { computeStats, fakeV1State, v1Device } from '@/test/v1-fake-server';
import { addSession, dashboardState, FERRARI, MONZA, NOW, oneInvalidLapState } from '@/test/dashboard-fixture';
import { SimCars } from './SimCars';
import { SimOverview } from './SimOverview';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
// The real charts need a layout engine; what matters is the rows they are given and the series they draw.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="bar-chart" data-rows={JSON.stringify(data)}>{children}</figure>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="line-chart" data-rows={JSON.stringify(data)}>{children}</figure>,
  Bar: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  Line: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

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

const statsRequests = (state: { requests: Array<{ path: string; params: Record<string, string> }> }) => state.requests.filter((request) => request.path === '/stats');
const expected = (range: '7d' | '30d' | '90d' | '1y' | 'all' = '30d', state = dashboardState()) => computeStats(state, range, new Date(NOW));
const tile = (id: string) => screen.getByTestId(`kpi-${id}`);

async function dashboard(state = dashboardState()) {
  const view = renderSim(<SimOverview />, { state, route: '/virtual' });
  await screen.findByTestId('overview-dashboard');
  return view;
}

describe('the Overview header', () => {
  it('has the title and the period (30 days by default), and no Companion chip of its own (that lives in the header of the app)', async () => {
    // The computer was heard from at 11:00 UTC; at 11:01 it is online.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-13T11:01:00.000Z') });
    await dashboard();
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'Period' });
    const options = within(group).getAllByRole('radio');
    expect(options.map((option) => option.textContent)).toEqual(['7 days', '30 days', '90 days', '12 months', 'All']);
    expect(within(group).getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('overview-connected')).not.toBeInTheDocument();
    // No card of its own and no separate "Last lap received" block.
    expect(screen.queryByText('Last lap received')).not.toBeInTheDocument();
  });

  it('shows a compact "Get Xpeed Companion / Connect" banner when no computer is paired', async () => {
    const state = dashboardState();
    state.devices = [];
    await dashboard(state);
    const banner = screen.getByTestId('overview-companion');
    expect(banner.tagName).toBe('DIV');
    expect(within(banner).getByTestId('overview-download')).toHaveAttribute('href', '/companion');
    expect(within(banner).getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
    expect(screen.queryByTestId('overview-connected')).not.toBeInTheDocument();
    // The dashboard is still all there.
    expect(screen.getByTestId('kpi-tiles')).toBeInTheDocument();
  });
});

describe('the six tiles', () => {
  it('show the value for the range, the valid share, and are in the order of the design', async () => {
    await dashboard();
    const want = expected();
    const tiles = within(screen.getByTestId('kpi-tiles')).getAllByRole('listitem');
    expect(tiles).toHaveLength(6);
    expect(tiles.map((item) => within(item).getAllByText(/.+/)[0].textContent)).toEqual(['Laps', 'Time driven', 'Distance', 'Sessions', 'Personal bests set', 'Tracks & cars driven']);
    expect(screen.getByTestId('kpi-laps-value')).toHaveTextContent(String(want.totals.laps));
    expect(screen.getByTestId('kpi-laps-sub')).toHaveTextContent(`${Math.round((want.totals.validLaps / want.totals.laps) * 100)}% valid`);
    expect(screen.getByTestId('kpi-time-value')).toHaveTextContent(formatDuration(want.totals.timeMs, 'en'));
    expect(screen.getByTestId('kpi-distance-value')).toHaveTextContent(formatDistance(want.totals.distanceM, 'km', 'en'));
    expect(screen.getByTestId('kpi-sessions-value')).toHaveTextContent(String(want.totals.sessions));
    expect(screen.getByTestId('kpi-personalBests-value')).toHaveTextContent(String(want.totals.personalBests));
    expect(screen.getByTestId('kpi-tracksCars-value')).toHaveTextContent(`${want.totals.tracks} · ${want.totals.cars}`);
    expect(screen.getByTestId('kpi-tracksCars-sub')).toHaveTextContent(`${want.totals.tracks} tracks · ${want.totals.cars} cars`);
  });

  it('show the change against the period before with an arrow and a percent, in the neutral colour (more driving is not good or bad), and a sparkline each', async () => {
    await dashboard();
    const want = expected();
    const change = within(tile('laps')).getByTestId('kpi-change');
    expect(change).toHaveAttribute('data-trend', want.totals.laps > want.previous.laps ? 'up' : 'down');
    expect(change).toHaveTextContent(`${Math.abs(Math.round(((want.totals.laps - want.previous.laps) / want.previous.laps) * 100))}%`);
    expect(change.className).toMatch(/text-muted-foreground/);
    expect(change.className).not.toMatch(/green|red|success|destructive/);
    expect(within(change).getByText(/more than the period before|less than the period before/)).toBeInTheDocument();
    for (const id of ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars']) {
      const spark = within(tile(id)).getByTestId('sparkline');
      expect(spark).toHaveAttribute('aria-hidden', 'true');
      expect(Number(spark.getAttribute('data-points'))).toBeGreaterThan(1);
    }
  });

  it('say "n/a" when the period before is empty (all time has no period before)', async () => {
    const view = await dashboard();
    fireEvent.click(screen.getByTestId('range-all'));
    await waitFor(() => expect(statsRequests(view.state).some((request) => request.params.range === 'all')).toBe(true));
    await waitFor(() => expect(within(tile('laps')).getByTestId('kpi-change')).toHaveTextContent('n/a'));
    for (const id of ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars']) expect(within(tile(id)).getByTestId('kpi-change')).toHaveAttribute('data-trend', 'none');
  });

  it('write the distance in miles when the person chose miles', async () => {
    localStorage.setItem('settings_distanceUnit', 'mi');
    await dashboard();
    expect(screen.getByTestId('kpi-distance-value')).toHaveTextContent(formatDistance(expected().totals.distanceM, 'mi', 'en'));
    expect(screen.getByTestId('kpi-distance-value')).toHaveTextContent(/mi/);
  });
});

describe('activity', () => {
  it('has a bar chart of laps per day with a text alternative that gives the numbers, the streak and the best day, and no calendar at 30 days', async () => {
    await dashboard();
    const want = expected();
    const chart = screen.getByTestId('activity-chart');
    expect(chart).toHaveAttribute('role', 'img');
    expect(chart.getAttribute('aria-label')).toContain(`${want.totals.laps} laps over 30 days`);
    expect(chart.getAttribute('aria-label')).toMatch(/most on Nov 12, 2026 \(8\)/);
    expect(screen.getByTestId('streak-current')).toHaveTextContent('Driving streak: 2 days');
    expect(screen.getByTestId('best-day')).toHaveTextContent('Best day: Nov 12, 2026, 8 laps');
    expect(screen.queryByTestId('heatmap')).not.toBeInTheDocument();
  });

  it('adds the calendar of the last 12 months from 90 days up: weeks as columns, a cell per day with its date and laps, intensity by laps', async () => {
    await dashboard();
    fireEvent.click(screen.getByTestId('range-90d'));
    const heatmap = await screen.findByTestId('heatmap');
    const cells = within(heatmap).getAllByTestId('heat-cell');
    expect(cells).toHaveLength(365);
    const busy = cells.find((cell) => cell.getAttribute('data-day') === '2026-11-12')!;
    expect(busy).toHaveAttribute('data-laps', '8');
    expect(busy).toHaveAttribute('data-level', '4');
    expect(busy.querySelector('title')?.textContent).toBe('Nov 12, 2026: 8 laps');
    expect(cells.find((cell) => cell.getAttribute('data-day') === '2026-11-10')).toHaveAttribute('data-level', '0');
    expect(within(heatmap).getByRole('img').getAttribute('aria-label')).toMatch(/Calendar of the last 12 months: \d+ laps on \d+ days\./);
    fireEvent.mouseEnter(busy);
    expect(within(heatmap).getByTestId('heat-hover')).toHaveTextContent('Nov 12, 2026: 8 laps');
    // Laps per week for a long range.
    fireEvent.click(screen.getByTestId('range-1y'));
    await waitFor(() => expect(screen.getByTestId('activity-chart').getAttribute('aria-label')).toMatch(/^Laps per week/));
  });
});

describe('progress', () => {
  it('lists where you got faster: track and car, the new time, the time saved in green, when, with a link to the lap analysis', async () => {
    const state = dashboardState();
    await dashboard(state);
    const want = expected('30d', state).improvements;
    expect(want.length).toBeGreaterThan(5);
    expect(screen.getAllByTestId('improvement')).toHaveLength(5);
    fireEvent.click(screen.getByTestId('improvements-toggle'));
    const rows = screen.getAllByTestId('improvement');
    expect(rows).toHaveLength(want.length);
    const newest = rows[0];
    expect(newest).toHaveTextContent(want[0].trackName);
    expect(newest).toHaveTextContent(want[0].carName);
    expect(within(newest).getByRole('link')).toHaveAttribute('href', `/virtual/compare?a=${want[0].lapId}`);
    const best = rows.find((row) => row.textContent?.includes('1:39.600'))!;
    expect(within(best).getByTestId('improvement-saved')).toHaveTextContent('-0.200 s');
    expect(within(best).getByTestId('improvement-saved').className).toMatch(/text-success/);
    expect(within(best).getByTestId('improvement-time')).toHaveTextContent('1:39.600');
    // The first valid lap of a track and car has nothing to be compared with.
    const first = rows.find((row) => within(row).queryByTestId('improvement-first'))!;
    expect(first).toHaveTextContent('Imola');
    expect(first).toHaveTextContent('1:48.000');
    expect(within(first).getByTestId('improvement-first')).toHaveTextContent('First valid lap');
    expect(within(first).queryByTestId('improvement-saved')).not.toBeInTheDocument();
  });

  it('shows the latest five improvements and the rest on request', async () => {
    const state = fakeV1State({ now: NOW, devices: dashboardState().devices });
    addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-11-10T19:00:00.000Z', times: [105_000, 104_000, 103_000, 102_000, 101_000, 100_000, 99_000, 98_000] });
    await dashboard(state);
    expect(screen.getAllByTestId('improvement')).toHaveLength(5);
    const toggle = screen.getByTestId('improvements-toggle');
    expect(toggle).toHaveTextContent('Show all 8');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('improvement')).toHaveLength(8);
    expect(toggle).toHaveTextContent('Show fewer');
    fireEvent.click(toggle);
    expect(screen.getAllByTestId('improvement')).toHaveLength(5);
  });

  it('draws a small chart of the best valid lap per day for the most driven track and car, with a link to the track page and a text alternative', async () => {
    const state = dashboardState();
    await dashboard(state);
    const pairs = screen.getAllByTestId('progress-pair');
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    expect(pairs.length).toBeLessThanOrEqual(4);
    const monza = pairs[0];
    expect(monza).toHaveTextContent('Monza');
    expect(monza).toHaveTextContent('Ferrari 499P');
    expect(within(monza).getByRole('link')).toHaveAttribute('href', `/virtual/tracks/${MONZA.id}`);
    const chart = within(monza).getByTestId('pair-chart');
    expect(chart.getAttribute('aria-label')).toMatch(/Best valid lap per day, Monza with Ferrari 499P: 1:41\.900 on Oct 28, 1:39\.600 on Nov 12, 3 days\./);
  });

  it('says "Not enough laps yet", quietly, for a pair with fewer than 2 days of valid laps', async () => {
    const state = dashboardState();
    await dashboard(state);
    const imola = screen.getAllByTestId('progress-pair').find((pair) => pair.textContent?.includes('Imola'))!;
    expect(within(imola).getByTestId('pair-empty')).toHaveTextContent('Not enough laps yet');
    expect(within(imola).queryByTestId('pair-chart')).not.toBeInTheDocument();
  });

  it('says so, quietly, when the period has no new personal best', async () => {
    const state = fakeV1State({ now: NOW, devices: dashboardState().devices });
    addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-05-01T19:00:00.000Z', times: [99_000] });
    addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-11-10T19:00:00.000Z', times: [101_000, 100_500] });
    await dashboard(state);
    expect(screen.getByTestId('improvements-empty')).toHaveTextContent('No new personal best in this period yet.');
  });
});

describe('where you drive', () => {
  it('has the games (with the laps of each), the top tracks and the top cars as bars with counts, each row linking to its page', async () => {
    const state = dashboardState();
    await dashboard(state);
    const want = expected('30d', state).breakdown;
    const where = screen.getByTestId('overview-where');
    const games = within(within(where).getByTestId('where-games')).getAllByTestId('where-row');
    expect(games).toHaveLength(want.games.length);
    expect(games[0]).toHaveTextContent('Le Mans Ultimate');
    expect(within(games[0]).getByTestId('where-count')).toHaveTextContent(String(want.games[0].laps));
    expect(games[1]).toHaveTextContent('Assetto Corsa');
    // "Games played" is here, not a card of its own.
    expect(within(where).getByText('Games played')).toBeInTheDocument();
    const tracks = within(within(where).getByTestId('where-tracks')).getAllByTestId('where-row');
    expect(tracks[0]).toHaveTextContent('Monza');
    expect(within(tracks[0]).getByRole('link')).toHaveAttribute('href', `/virtual/tracks/${MONZA.id}`);
    expect(within(tracks[0]).getByTestId('where-count')).toHaveTextContent(String(want.tracks[0].laps));
    const cars = within(within(where).getByTestId('where-cars')).getAllByTestId('where-row');
    expect(cars[0]).toHaveTextContent('Ferrari 499P');
    expect(within(cars[0]).getByRole('link')).toHaveAttribute('href', `/virtual/cars/${FERRARI.id}`);
    expect(screen.queryByTestId('overview-games')).not.toBeInTheDocument();
  });

  it('names the game of a track that two games share (Monza in two games), and only then', async () => {
    const state = dashboardState();
    addSession(state, { track: { id: 'monza-ac', name: 'Monza' }, car: FERRARI, game: 'ac', startedAt: '2026-11-06T21:00:00.000Z', times: [105_000, 104_000] });
    await dashboard(state);
    const tracks = within(screen.getByTestId('where-tracks')).getAllByTestId('where-row');
    expect(tracks.map((row) => row.getAttribute('data-name')).filter((name) => name?.startsWith('Monza'))).toHaveLength(2);
    expect(tracks.some((row) => row.textContent?.includes('Monza · Assetto Corsa'))).toBe(true);
    expect(tracks.some((row) => row.textContent?.includes('Monza · Le Mans Ultimate'))).toBe(true);
    expect(tracks.find((row) => row.textContent?.includes('Spa-Francorchamps'))?.textContent).not.toContain('·');
  });
});

describe('consistency', () => {
  it('gives the spread of the clean laps as a plain sentence built from numbers, and the share of clean laps', async () => {
    const state = dashboardState();
    await dashboard(state);
    const want = expected('30d', state).consistency.filter((session) => session.spreadMs !== null);
    expect(want.length).toBeGreaterThan(0);
    const sentence = screen.getByTestId('consistency-sentence');
    expect(sentence).toHaveTextContent(/^Your spread is \d\.\d\d s/);
    expect(['modes.overview.dash.spreadOnly', 'modes.overview.dash.spreadTighter', 'modes.overview.dash.spreadLooser', 'modes.overview.dash.spreadSame']).toContain(sentence.getAttribute('data-key'));
    expect(screen.getByTestId('consistency-clean')).toHaveTextContent(/^Clean laps: \d+%$/);
    expect(screen.getByTestId('consistency-chart')).toHaveAttribute('role', 'img');
  });

  it('is a trend of the latest sessions whatever the period: 7 days still shows it', async () => {
    const view = await dashboard();
    const before = screen.getByTestId('consistency-sentence').textContent;
    fireEvent.click(screen.getByTestId('range-7d'));
    await waitFor(() => expect(statsRequests(view.state).some((request) => request.params.range === '7d')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('overview-dashboard')).not.toHaveAttribute('aria-busy'));
    expect(screen.getByTestId('consistency-sentence').textContent).toBe(before);
    expect(screen.queryByTestId('consistency-empty')).not.toBeInTheDocument();
  });

  it('asks for 3 clean laps in a session when none has a spread yet', async () => {
    const state = fakeV1State({ now: NOW, devices: dashboardState().devices });
    addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-11-10T19:00:00.000Z', times: [101_000, 100_500] });
    await dashboard(state);
    expect(screen.getByTestId('consistency-empty')).toHaveTextContent('Drive at least 3 clean laps in a session');
    expect(screen.queryByTestId('consistency-sentence')).not.toBeInTheDocument();
  });
});

describe('the latest', () => {
  it('lists the latest sessions in a table (when, game, track, car, laps, best valid lap, kind) with a link to all of them, and the latest personal bests', async () => {
    const state = dashboardState();
    await dashboard(state);
    const table = within(screen.getByTestId('overview-sessions')).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['When', 'Track and car', 'Laps', 'Best valid lap']);
    const rows = screen.getAllByTestId('overview-session');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent('Monza');
    expect(within(rows[0]).getByTestId('session-game')).toHaveTextContent('Le Mans Ultimate');
    expect(within(rows[0]).getByTestId('session-kind')).toHaveTextContent('Race');
    expect(within(rows[0]).getByTestId('overview-session-laps')).toHaveTextContent('8');
    expect(rows[0]).toHaveTextContent('1:39.600');
    expect(within(rows[1]).getByTestId('session-game')).toHaveTextContent('Assetto Corsa');
    expect(within(rows[0]).getByTestId('overview-session-link')).toHaveAttribute('href', `/virtual/sessions/${state.sessions[0].id}`);
    expect(screen.getByTestId('overview-all-sessions')).toHaveAttribute('href', '/virtual/sessions');
    const bests = screen.getAllByTestId('overview-best-lap');
    expect(bests.length).toBeLessThanOrEqual(5);
    expect(within(bests[0]).getByRole('link').getAttribute('href')).toMatch(/^\/virtual\/compare\?a=/);
  });
});

describe('the period', () => {
  it('is kept per person: a choice is read again with the next visit, and the numbers are asked for that period', async () => {
    const first = await dashboard();
    expect(statsRequests(first.state).map((request) => request.params.range)).toEqual(['30d']);
    fireEvent.click(screen.getByTestId('range-90d'));
    expect(localStorage.getItem(rangeStorageKey('ana'))).toBe('90d');
    await waitFor(() => expect(statsRequests(first.state).map((request) => request.params.range)).toContain('90d'));
    expect(screen.getByRole('radio', { name: '90 days' })).toHaveAttribute('aria-checked', 'true');
    cleanup();

    const again = renderSim(<SimOverview />, { state: dashboardState(), route: '/virtual' });
    await screen.findByTestId('overview-dashboard');
    expect(screen.getByRole('radio', { name: '90 days' })).toHaveAttribute('aria-checked', 'true');
    expect(statsRequests(again.state).map((request) => request.params.range)).toEqual(['90d']);
    expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'false');
  });

  it('works with the keyboard: arrows move between the five options and choose, only the chosen one is a tab stop', async () => {
    await dashboard();
    const selected = screen.getByRole('radio', { name: '30 days' });
    expect(selected).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('tabindex', '-1');
    selected.focus();
    fireEvent.keyDown(selected, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: '90 days' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '90 days' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('radio', { name: '90 days' }), { key: 'ArrowLeft' });
    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radio', { name: '7 days' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem(rangeStorageKey('ana'))).toBe('all');
  });

  it('still works when the browser will not keep it (storage that throws): 30 days, and a choice is used for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const view = renderSim(<SimOverview />, { state: dashboardState(), route: '/virtual' });
    await screen.findByTestId('overview-dashboard');
    expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('range-7d'));
    await waitFor(() => expect(statsRequests(view.state).map((request) => request.params.range)).toContain('7d'));
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the numbers on screen, dimmed, while a new period loads, instead of falling back to a skeleton', async () => {
    const view = await dashboard();
    view.state.delayMs = 80;
    fireEvent.click(screen.getByTestId('range-7d'));
    await waitFor(() => expect(screen.getByTestId('overview-dashboard')).toHaveAttribute('aria-busy', 'true'));
    expect(screen.queryByTestId('overview-skeleton')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('overview-dashboard')).not.toHaveAttribute('aria-busy'));
  });
});

describe('the states', () => {
  it('shows a skeleton shaped like the blocks while it loads', async () => {
    const state = dashboardState();
    state.delayMs = 40;
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const skeleton = await screen.findByTestId('overview-skeleton');
    expect(within(skeleton).getByTestId('skeleton-activity')).toBeInTheDocument();
    expect(within(skeleton).getByTestId('skeleton-progress')).toBeInTheDocument();
    expect(within(skeleton).getByTestId('skeleton-where')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Overview' })).toBeInTheDocument();
    await screen.findByTestId('overview-dashboard');
    expect(screen.queryByTestId('overview-skeleton')).not.toBeInTheDocument();
  });

  it('with no laps at all: the Companion banner, tiles with dashes (not zeros) and one friendly panel, and no numbers asked for', async () => {
    const state = fakeV1State({ now: NOW });
    const view = renderSim(<SimOverview />, { state, route: '/virtual' });
    const empty = await screen.findByTestId('overview-empty');
    expect(empty).toHaveTextContent('Your dashboard fills in as you drive');
    expect(empty).toHaveTextContent('Once Xpeed Companion sends your first laps');
    expect(within(screen.getByTestId('overview-companion')).getByTestId('overview-download')).toHaveAttribute('href', '/companion');
    expect(screen.getByTestId('kpi-tiles')).toHaveAttribute('data-empty', 'true');
    for (const id of ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars']) {
      expect(screen.getByTestId(`kpi-${id}-value`)).toHaveTextContent('–');
      expect(screen.getByTestId(`kpi-${id}-value`).textContent).not.toMatch(/\d/);
    }
    expect(screen.queryByTestId('sparkline')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-activity')).not.toBeInTheDocument();
    expect(statsRequests(view.state)).toHaveLength(0);
  });

  it('with a paired computer and no laps yet: no invitation to connect, and the panel explains what will appear', async () => {
    const state = fakeV1State({ now: NOW, devices: dashboardState().devices });
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-empty');
    expect(screen.queryByTestId('overview-companion')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-download')).not.toBeInTheDocument();
  });

  it('with one lap, flagged not valid by the game: 1 lap, 0% valid, no best, and every block still intentional (no NaN, no empty axes)', async () => {
    const state = oneInvalidLapState();
    const view = renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-dashboard');
    expect(screen.getByTestId('kpi-laps-value')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-laps-sub')).toHaveTextContent('0% valid');
    expect(screen.getByTestId('kpi-time-value')).toHaveTextContent(formatDuration(154_252, 'en'));
    expect(screen.getByTestId('kpi-sessions-value')).toHaveTextContent('1');
    expect(screen.getByTestId('kpi-personalBests-value')).toHaveTextContent('0');
    expect(screen.getByTestId('kpi-tracksCars-value')).toHaveTextContent('1 · 1');
    expect(screen.getByTestId('kpi-tracksCars-sub')).toHaveTextContent('1 track · 1 car');
    for (const id of ['laps', 'time', 'distance', 'sessions', 'personalBests', 'tracksCars']) expect(within(tile(id)).getByTestId('kpi-change')).toHaveAttribute('data-trend', 'none');
    expect(screen.getByTestId('activity-chart').getAttribute('aria-label')).toContain('1 lap over 30 days');
    expect(screen.getByTestId('streak-current')).toHaveTextContent('Driving streak: 1 day');
    expect(screen.getByTestId('improvements-empty')).toBeInTheDocument();
    expect(screen.getByTestId('pair-empty')).toHaveTextContent('Not enough laps yet');
    expect(screen.getByTestId('consistency-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('consistency-chart')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('where-tracks')).getAllByTestId('where-row')).toHaveLength(1);
    expect(screen.getByTestId('overview-best')).toHaveTextContent('No valid lap yet.');
    for (const range of ['7d', '90d', '1y', 'all'] as const) {
      fireEvent.click(screen.getByTestId(`range-${range}`));
      await waitFor(() => expect(statsRequests(view.state).some((request) => request.params.range === range)).toBe(true));
      await waitFor(() => expect(screen.getByRole('radio', { name: { '7d': '7 days', '90d': '90 days', '1y': '12 months', all: 'All' }[range] })).toHaveAttribute('aria-checked', 'true'));
      await waitFor(() => expect(screen.getByTestId('overview-dashboard')).not.toHaveAttribute('aria-busy'));
    }
    expect(screen.getByTestId('overview').textContent).not.toMatch(/NaN|Infinity|undefined/);
    // The names of the one lap are in the Where block, and the heatmap (all, 12 months) has its one day.
    expect(within(screen.getByTestId('heatmap')).getAllByTestId('heat-cell').filter((cell) => cell.getAttribute('data-laps') === '1')).toHaveLength(1);
  });

  it('with laps, but none in the chosen period: zeros with n/a, quiet lines in every block, no empty chart, and the latest sessions are still listed', async () => {
    const state = fakeV1State({ now: NOW, devices: dashboardState().devices });
    addSession(state, { track: MONZA, car: FERRARI, startedAt: '2026-05-01T19:00:00.000Z', times: [101_000, 100_500, 100_900] });
    await dashboard(state);
    expect(screen.getByTestId('kpi-laps-value')).toHaveTextContent('0');
    expect(screen.getByTestId('kpi-laps-sub')).toHaveTextContent('no laps yet');
    expect(screen.getByTestId('kpi-time-value')).toHaveTextContent(/^0\s?s/);
    expect(within(tile('laps')).getByTestId('kpi-change')).toHaveAttribute('data-trend', 'none');
    expect(screen.getByTestId('activity-empty')).toHaveTextContent('No laps in this period. Try a longer one.');
    expect(screen.queryByTestId('activity-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('streak-current')).toHaveTextContent('No driving streak right now');
    expect(screen.queryByTestId('best-day')).not.toBeInTheDocument();
    expect(screen.getByTestId('improvements-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('progress-pair')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('overview-where')).getAllByText('Nothing in this period.')).toHaveLength(3);
    // Consistency is a trend of the latest sessions, whatever the period: it is still there.
    expect(screen.getByTestId('consistency-sentence')).toHaveTextContent(/^Your spread is \d\.\d\d s/);
    expect(screen.getAllByTestId('overview-session')).toHaveLength(1);
    expect(screen.getByTestId('overview').textContent).not.toMatch(/NaN|Infinity|undefined/);
    // A longer period finds them.
    fireEvent.click(screen.getByTestId('range-1y'));
    await waitFor(() => expect(screen.getByTestId('kpi-laps-value')).toHaveTextContent('3'));
  });

  it('says the server is not answering (503), which is not an empty account', async () => {
    const state = fakeV1State();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSim(<SimOverview />, { state, route: '/virtual' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-companion')).not.toBeInTheDocument();
    expect(screen.getByTestId('range-select')).toBeInTheDocument();
  });

  it('asks to sign in again when the sign-in no longer works (401)', async () => {
    const state = fakeV1State();
    state.failing = { status: 401, error: 'unauthorized', retryable: false };
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const panel = await screen.findByTestId('sim-error');
    expect(within(panel).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });

  it('says the numbers could not be loaded, with a retry, when only the dashboard\'s own call fails', async () => {
    const state = dashboardState();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    state.failingPath = '/stats';
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const panel = await screen.findByTestId('sim-error');
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    // The header, with the period, is still there.
    expect(screen.getByTestId('range-select')).toBeInTheDocument();
    state.failing = null;
    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('overview-dashboard');
  });
});

describe('language', () => {
  it('says its text in the language of the person', async () => {
    await i18n.changeLanguage('pt-BR');
    await dashboard();
    expect(screen.getByRole('radiogroup', { name: 'Período' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '12 meses' })).toBeInTheDocument();
    expect(screen.getByText('Atividade')).toBeInTheDocument();
    expect(screen.getByTestId('streak-current')).toHaveTextContent('Sequência: 2 dias seguidos pilotando');
    expect(screen.getByText('Onde você ficou mais rápido')).toBeInTheDocument();
    expect(screen.getByTestId('consistency-sentence').textContent).toMatch(/^Sua dispersão é de/);
    await i18n.changeLanguage('en');
  });

  it('never shows the word "Sim" to a person', async () => {
    await dashboard();
    expect(screen.getByTestId('overview').textContent).not.toMatch(/\bSim\b/);
    fireEvent.click(screen.getByTestId('range-90d'));
    await screen.findByTestId('heatmap');
    expect(screen.getByTestId('overview').textContent).not.toMatch(/\bSim\b/);
  });
});

describe('Game cars', () => {
  it('lists the cars, each with its game, its laps and its best valid lap', async () => {
    const state = fakeV1State({
      cars: [
        { id: FERRARI.id, game: 'lmu', name: FERRARI.name, brand: null, class: null, lapCount: 8, validLapCount: 6, sessionCount: 2, trackCount: 3, bestLapMs: 99_000, lastDrivenAt: '2026-11-12T10:00:00.000Z' },
        { id: 'c2', game: 'ac', name: 'Porsche 911 GT3 R', brand: null, class: null, lapCount: 1, validLapCount: 0, sessionCount: 1, trackCount: 1, bestLapMs: null, lastDrivenAt: '2026-11-11T10:00:00.000Z' },
      ],
    });
    renderSim(<SimCars />, { state, route: '/virtual/cars' });
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(2));
    const [lmu, ac] = screen.getAllByTestId('cars-car');
    expect(lmu).toHaveTextContent('Ferrari 499P');
    expect(lmu).toHaveTextContent('Le Mans Ultimate');
    expect(lmu).toHaveTextContent('75% valid');
    expect(within(lmu).getByTestId('car-laps')).toHaveTextContent('8');
    // The fake holds no laps, so each card's detail is a 404: the card then says the best lap of the list item itself.
    await waitFor(() => expect(lmu).toHaveTextContent('1:39.000'));
    expect(ac).toHaveTextContent('Porsche 911 GT3 R');
    await waitFor(() => expect(ac).toHaveTextContent('–'));
  });

  it('invites to connect Xpeed Companion when there are no cars', async () => {
    renderSim(<SimCars />, { state: fakeV1State(), route: '/virtual/cars' });
    expect(await screen.findByTestId('cars-empty')).toHaveTextContent('No cars yet');
  });
});
