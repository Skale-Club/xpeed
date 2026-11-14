import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { gzipLap } from '@/lib/sim/lap-file';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderGarage, type FakeCatalogItem } from '@/test/garage-render';
import { makeLapFixtures } from '@/test/lap-fixture';
import { whereNow } from '@/test/sim-render';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, selectOptions } from '@/test/select';
import { TrackPage } from './TrackPage';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
// The real chart needs a layout engine; what matters is the rows it is given and the series it draws.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-rows={JSON.stringify(data)}>{children}</figure>,
  Bar: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  Line: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const toyota = ref('Toyota GR010');

let state: FakeV1State;
let idb: FakeIdb;
beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
  state = fakeV1State();
  const sessionA = v1Session({ track: monza, car: ferrari, kind: 'race', lapCount: 3, bestLapMs: 99_000, startedAt: '2026-11-10T10:00:00.000Z' });
  const sessionB = v1Session({ track: monza, car: toyota, kind: 'practice', lapCount: 2, bestLapMs: 100_500, startedAt: '2026-11-12T10:00:00.000Z' });
  state.sessions.push(sessionA, sessionB, v1Session({ track: spa, car: ferrari, lapCount: 1, bestLapMs: 135_000 }));
  state.laps.push(
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 101_000, sectorsMs: [31_000, 34_500, 35_500], startedAt: '2026-11-10T10:00:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 99_000, sectorsMs: [30_000, 35_000, 34_000], startedAt: '2026-11-10T10:03:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 98_000, valid: false, sectorsMs: [29_000, 34_000, 35_000], startedAt: '2026-11-10T10:06:00.000Z' }),
    v1Lap({ track: monza, car: toyota, sessionId: sessionB.id, timeMs: 100_500, sectorsMs: [30_500, 35_200, 34_800], startedAt: '2026-11-12T10:00:00.000Z' }),
    v1Lap({ track: monza, car: toyota, sessionId: sessionB.id, timeMs: 102_000, sectorsMs: [31_500, 35_500, 35_000], startedAt: '2026-11-12T10:03:00.000Z' }),
    v1Lap({ track: spa, car: ferrari, timeMs: 135_000, startedAt: '2026-11-11T10:00:00.000Z' }),
  );
  buildCatalog(state, { Monza: 5793 });
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const openTrack = (id: string, options: { accountTracks?: AccountTrack[]; files?: Map<string, Uint8Array>; catalog?: FakeCatalogItem[] | 'down'; on?: FakeV1State } = {}) =>
  renderGarage(<TrackPage />, {
    state: options.on ?? state, route: `/virtual/tracks/${id}`, accountTracks: options.accountTracks, files: options.files, catalog: options.catalog,
    wrap: (page) => <Routes><Route path="/virtual/tracks/:id" element={page} /><Route path="*" element={<p>elsewhere</p>} /></Routes>,
  });

/** The layout of Monza as the account holds it, gzipped, and the lap file of the best Monza lap (a made-up lap; only its path matters). */
async function layoutAndLap() {
  const layout = await gzipBytes(packLayout(makeLayout({ points: circle(300, 80), width: 8, closed: true, game: 'lmu', name: 'Monza', ideal: true })));
  const [lap] = makeLapFixtures();
  return { layout, lap: await gzipLap(lap) };
}

describe('the track page', () => {
  it('is a dashboard: the header with the track, the game and the length, and a tile for every number', async () => {
    openTrack(monza.id);
    expect(await screen.findByTestId('track-header')).toHaveTextContent('Monza');
    expect(screen.getByTestId('track-header')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('track-subtitle')).toHaveTextContent('5.79 km');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('5');
    expect(screen.getByTestId('totals-laps-sub')).toHaveTextContent('80% valid');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('80%');
    expect(screen.getByTestId('totals-valid-sub')).toHaveTextContent('4 of 5');
    expect(screen.getByTestId('totals-sessions')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-cars')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-best')).toHaveTextContent('1:39.000');
    expect(screen.getByTestId('totals-best-sub')).toHaveTextContent('Ferrari 499P');
    expect(screen.getByTestId('totals-last')).toHaveTextContent('Nov 12');
    expect(screen.getByTestId('totals-last-sub')).toHaveTextContent(/ago|yesterday|today/);
  });

  it('works out the average valid lap and the time driven from the laps of the track', async () => {
    openTrack(monza.id);
    // Valid laps 101.000, 99.000, 100.500 and 102.000 (the voided 98.000 does not count) average 1:40.625; every lap counts for the time at the wheel.
    await waitFor(() => expect(screen.getByTestId('totals-average')).toHaveTextContent('1:40.625'));
    expect(screen.getByTestId('totals-time')).toHaveTextContent('8m 21s');
    expect(state.requests.filter((request) => request.path === '/laps').every((request) => request.params.track === monza.id)).toBe(true);
  });

  it('shows a skeleton, not a zero, in the tiles that need the laps while they come', async () => {
    openTrack(monza.id);
    await screen.findByTestId('track-header');
    expect(screen.queryByTestId('totals-average-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('totals-average-loading')).not.toBeInTheDocument());
  });

  it('draws the progress: the best valid lap of each day as a line and the laps of each day as bars', async () => {
    openTrack(monza.id);
    const chart = await screen.findByTestId('chart');
    const rows = JSON.parse(chart.getAttribute('data-rows') as string) as Array<{ day: string; bestS: number | null; laps: number; validLaps: number }>;
    // 10 Nov: 3 laps, one voided: the best valid is 99.000 s, not the voided 98.000. 12 Nov: 2 laps.
    expect(rows.map((row) => [row.day, row.bestS, row.laps, row.validLaps])).toEqual([
      ['2026-11-10', 99, 3, 2],
      ['2026-11-12', 100.5, 2, 2],
    ]);
    expect(within(chart).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps', 'bestS']);
    expect(screen.getByTestId('track-progress-chart')).toHaveAttribute('role', 'img');
    expect(screen.getByTestId('track-progress-chart').getAttribute('aria-label')).toMatch(/1:39\.000/);
  });

  it('filters the progress by car, from the laps of that car only', async () => {
    state.laps.push(v1Lap({ track: monza, car: toyota, timeMs: 101_500, startedAt: '2026-11-13T10:00:00.000Z' }));
    buildCatalog(state, { Monza: 5793 });
    openTrack(monza.id);
    const rows = () => JSON.parse(screen.getByTestId('chart').getAttribute('data-rows') as string) as Array<{ day: string; bestS: number | null; laps: number }>;
    await screen.findByTestId('chart');
    expect(rows().map((row) => row.day)).toEqual(['2026-11-10', '2026-11-12', '2026-11-13']);
    const pick = screen.getByTestId('track-progress-car');
    expect(selectOptions(pick)).toEqual(['All cars', 'Ferrari 499P', 'Toyota GR010']);
    chooseOption(pick, 'Toyota GR010');
    await waitFor(() => expect(rows().map((row) => [row.day, row.bestS, row.laps])).toEqual([['2026-11-12', 100.5, 2], ['2026-11-13', 101.5, 1]]));
    chooseOption(pick, 'All cars');
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('lists the best lap with each car, the fastest first with the gap to it, each car opening its page and each lap its analysis', async () => {
    openTrack(monza.id);
    const rows = await screen.findAllByTestId('best-car-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ferrari 499P');
    expect(within(rows[0]).getByTestId('best-car-rank')).toHaveTextContent('1');
    expect(within(rows[0]).getByTestId('best-car-time')).toHaveTextContent('1:39.000');
    expect(within(rows[0]).getByTestId('best-car-gap')).toHaveTextContent('Fastest');
    expect(rows[1]).toHaveTextContent('Toyota GR010');
    expect(within(rows[1]).getByTestId('best-car-time')).toHaveTextContent('1:40.500');
    expect(within(rows[1]).getByTestId('best-car-gap')).toHaveTextContent('+1.500');
    expect(within(rows[0]).getByTestId('best-car-link')).toHaveAttribute('href', `/virtual/cars/${ferrari.id}`);
    const bestLap = state.laps.find((lap) => lap.timeMs === 99_000)!;
    expect(within(rows[0]).getByTestId('best-car-analyze')).toHaveAttribute('href', `/virtual/compare?a=${bestLap.id}`);
  });

  it('shows the best of each sector over every lap, who set it, and the theoretical lap against the best lap', async () => {
    openTrack(monza.id);
    const sectors = await screen.findAllByTestId('sector-best');
    expect(sectors.map((sector) => within(sector).getByTestId('sector-best-time').textContent)).toEqual(['30.000', '34.500', '34.000']);
    expect(sectors.map((sector) => within(sector).getByTestId('sector-best-car').textContent)).toEqual(['Ferrari 499P', 'Ferrari 499P', 'Ferrari 499P']);
    // The best sectors add up to 1:38.500: half a second under the best lap of 1:39.000. The voided lap's 29.000 does not count.
    expect(screen.getByTestId('theoretical-time')).toHaveTextContent('1:38.500');
    expect(screen.getByTestId('theoretical-gain')).toHaveTextContent('0.500 s faster than your best lap, 1:39.000');
    const second = state.laps.find((lap) => lap.timeMs === 101_000)!;
    expect(within(sectors[1]).getByTestId('sector-best-lap')).toHaveAttribute('href', `/virtual/compare?a=${second.id}`);
  });

  it('marks, in the table of cars, the sectors that are the best of all in purple', async () => {
    openTrack(monza.id);
    const rows = await screen.findAllByTestId('best-car-row');
    expect(within(rows[0]).getAllByTestId('best-car-sector').map((cell) => [cell.textContent, cell.getAttribute('data-best')])).toEqual([['30.000', 'true'], ['34.500', 'true'], ['34.000', 'true']]);
    expect(within(rows[1]).getAllByTestId('best-car-sector').map((cell) => [cell.textContent, cell.getAttribute('data-best')])).toEqual([['30.500', null], ['35.200', null], ['34.800', null]]);
  });

  it('says there are no sector times on a track whose laps have none', async () => {
    openTrack(spa.id);
    expect(await screen.findByTestId('track-sectors-empty')).toHaveTextContent('No sector times yet');
    expect(screen.queryByTestId('theoretical-best')).not.toBeInTheDocument();
  });

  it('lists the latest sessions on this track only, and goes on to the sessions list filtered by it', async () => {
    openTrack(monza.id);
    const sessions = await screen.findAllByTestId('latest-session');
    expect(sessions).toHaveLength(2); // not the one on Spa
    expect(sessions[0]).toHaveTextContent('Toyota GR010'); // newest first
    expect(within(sessions[0]).getByRole('link')).toHaveAttribute('href', `/virtual/sessions/${state.sessions.find((s) => s.car.id === toyota.id)!.id}`);
    expect(state.requests.find((request) => request.path === '/sessions')?.params.track).toBe(monza.id);
    expect(within(screen.getByTestId('latest-sessions')).getByRole('link', { name: 'All sessions' })).toHaveAttribute('href', `/virtual/sessions?track=${monza.id}`);
  });

  it('goes back to the list of tracks', async () => {
    openTrack(monza.id);
    fireEvent.click(await screen.findByRole('link', { name: /All tracks/ }));
    await waitFor(() => expect(screen.getByText('elsewhere')).toBeInTheDocument());
    expect(whereNow(screen.getByTestId('where')).pathname).toBe('/virtual/tracks');
  });

  it('says so when the track is not in the catalog', async () => {
    openTrack('00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByTestId('track-not-found')).toBeInTheDocument();
  });

  it('says the server is not answering when it is not', async () => {
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    openTrack(monza.id);
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
  });

  it('stands in a skeleton shaped like the page while the first read runs', async () => {
    state.delayMs = 40;
    openTrack(monza.id);
    expect(screen.getByTestId('garage-skeleton')).toHaveAttribute('role', 'status');
    expect(await screen.findByTestId('track-header')).toBeInTheDocument();
    expect(screen.queryByTestId('garage-skeleton')).not.toBeInTheDocument();
  });

  it('writes the page in Portuguese and in Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    openTrack(monza.id);
    expect(await screen.findByText('Melhor volta com cada carro')).toBeInTheDocument();
    expect(screen.getByText('Todas as pistas')).toBeInTheDocument();
    expect(screen.getByText('Melhores setores')).toBeInTheDocument();
    expect(screen.getByText('Melhor volta teórica')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    openTrack(monza.id);
    expect(await screen.findByText('Mejor vuelta con cada coche')).toBeInTheDocument();
    expect(screen.getByText('Mejores sectores')).toBeInTheDocument();
  });
});

describe('the leaderboard of the track', () => {
  it('links to the board of the car you are fastest with that has public laps, for this track and game', async () => {
    openTrack(monza.id, { catalog: [{ id: toyota.id, game: 'lmu', name: 'Toyota GR010', lapCount: 12, brand: null, class: null }, { id: ferrari.id, game: 'lmu', name: 'Ferrari 499P', lapCount: 40, brand: null, class: null }] });
    const link = await screen.findByTestId('track-leaderboard-link');
    expect(link).toHaveAttribute('href', `/virtual/leaderboards?track=${monza.id}&car=${ferrari.id}&game=lmu`);
  });

  it('opens the board of another car when the fastest has none public', async () => {
    openTrack(monza.id, { catalog: [{ id: toyota.id, game: 'lmu', name: 'Toyota GR010', lapCount: 12, brand: null, class: null }] });
    expect(await screen.findByTestId('track-leaderboard-link')).toHaveAttribute('href', `/virtual/leaderboards?track=${monza.id}&car=${toyota.id}&game=lmu`);
  });

  it('says so when no lap of the track is on the public boards', async () => {
    openTrack(monza.id, { catalog: [] });
    expect(await screen.findByTestId('track-leaderboard-none')).toHaveTextContent('No lap on this track is on the public leaderboards yet.');
    expect(screen.queryByTestId('track-leaderboard-link')).not.toBeInTheDocument();
  });

  it('still offers the leaderboards for the track when the list of boards cannot be read', async () => {
    openTrack(monza.id, { catalog: 'down' });
    expect(await screen.findByTestId('track-leaderboard-link')).toHaveAttribute('href', `/virtual/leaderboards?track=${monza.id}&game=lmu`);
  });
});

describe('the layout of the track', () => {
  const flag = (layoutId: string | null) => {
    const item = state.tracks.find((track) => track.id === monza.id)!;
    Object.assign(item, { hasLayout: layoutId !== null, layoutId });
  };

  it('draws the layout big with the best lap on it when the server says there is one (the file of that layout, no name matching)', async () => {
    const { layout, lap } = await layoutAndLap();
    flag('layout-monza');
    const best = state.laps.find((entry) => entry.timeMs === 99_000)!;
    state.files.set(best.id, lap);
    const { asked } = openTrack(monza.id, { files: new Map([['layout-monza', layout]]) });
    expect(await screen.findByTestId('track-layout-map')).toBeInTheDocument();
    const map = await screen.findByTestId('track-map');
    expect(map.getAttribute('class')).toMatch(/h-72/);
    expect(screen.getByTestId('track-layout')).toBeInTheDocument();
    expect(screen.getByTestId('track-header')).toHaveTextContent('Layout');
    expect(asked).toContain('/api/sim/tracks/layout-monza/file');
    expect(state.requests.filter((request) => request.path === `/laps/${best.id}/file`)).toHaveLength(1);
    expect(state.requests.filter((request) => request.path.endsWith('/file'))).toHaveLength(1);
  });

  it('draws the road alone, and says so, when there is a layout but the best lap cannot be read', async () => {
    const { layout } = await layoutAndLap();
    flag('layout-monza');
    openTrack(monza.id, { files: new Map([['layout-monza', layout]]) });
    expect(await screen.findByTestId('track-layout-shape')).toBeInTheDocument();
    expect(screen.getByTestId('track-layout-no-lap')).toHaveTextContent('could not be drawn');
    expect(screen.queryByTestId('track-map')).not.toBeInTheDocument();
  });

  it('finds the layout by name through the account when the server predates the flag', async () => {
    const { layout, lap } = await layoutAndLap();
    const best = state.laps.find((entry) => entry.timeMs === 99_000)!;
    state.files.set(best.id, lap);
    const account: AccountTrack = { id: 'layout-monza', game: 'lmu', trackName: 'Monza', variant: null, title: null, lengthM: 5793, size: 1000, updatedAt: '2026-11-10T00:00:00.000Z' };
    openTrack(monza.id, { accountTracks: [account], files: new Map([['layout-monza', layout]]) });
    expect(await screen.findByTestId('track-map')).toBeInTheDocument();
  });

  it('says what will appear, and reads no lap file, when the track has no layout', async () => {
    flag(null);
    const { asked } = openTrack(monza.id);
    expect(await screen.findByTestId('track-no-layout')).toHaveTextContent('will appear here after you drive this track');
    await screen.findByTestId('best-per-car');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.requests.filter((request) => request.path.endsWith('/file'))).toHaveLength(0);
    expect(asked.some((path) => path.startsWith('/api/sim/tracks'))).toBe(false);
    expect(screen.queryByTestId('track-layout-map')).not.toBeInTheDocument();
  });

  it('reads no lap file when an older server gives no flag and no layout matches the name', async () => {
    openTrack(monza.id);
    await screen.findByTestId('best-per-car');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.requests.filter((request) => request.path.endsWith('/file'))).toHaveLength(0);
    expect(await screen.findByTestId('track-no-layout')).toBeInTheDocument();
  });
});

describe('the track page with little or nothing to show', () => {
  /** What the owner's account has: one lap, flagged not valid by the game. */
  function oneInvalidLap(): FakeV1State {
    const interlagos = ref('Interlagos');
    const ginetta = ref('Ginetta G40');
    const only = fakeV1State();
    const session = v1Session({ track: interlagos, car: ginetta, lapCount: 1, bestLapMs: null });
    only.sessions.push(session);
    only.laps.push(v1Lap({ track: interlagos, car: ginetta, sessionId: session.id, timeMs: 154_252, valid: false, startedAt: '2026-11-13T19:00:00.000Z' }));
    buildCatalog(only, { Interlagos: 4309 });
    return only;
  }

  it('looks intentional with one lap the game did not count: dashes, no NaN, no chart with empty axes', async () => {
    const only = oneInvalidLap();
    openTrack(only.tracks[0].id, { on: only });
    expect(await screen.findByTestId('track-header')).toHaveTextContent('Interlagos');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('1');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('0%');
    expect(screen.getByTestId('totals-valid-sub')).toHaveTextContent('0 of 1');
    expect(screen.getByTestId('totals-best')).toHaveTextContent('–');
    expect(screen.getByTestId('totals-best-sub')).toHaveTextContent('No valid lap yet');
    await waitFor(() => expect(screen.getByTestId('totals-time')).toHaveTextContent('2m 34s'));
    expect(screen.getByTestId('totals-average')).toHaveTextContent('–');
    // One day is a number, not a chart: there is no chart, no axes to be empty, and the message says why there is no line.
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('track-progress-single')).toHaveTextContent('Only one day of driving so far');
    expect(screen.getByTestId('track-progress-no-valid')).toHaveTextContent('No valid lap yet');
    expect(screen.getByTestId('track-sectors-empty')).toBeInTheDocument();
    const row = screen.getByTestId('best-car-row');
    expect(row).toHaveTextContent('Ginetta G40');
    expect(row).toHaveTextContent('No valid lap yet');
    expect(within(row).getByTestId('best-car-time')).toHaveTextContent('–');
    expect(within(row).getByTestId('best-car-gap')).toHaveTextContent('–');
    expect(screen.getByTestId('track-page').textContent).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it('says a track in the catalog that was never driven has no laps, and draws no chart', async () => {
    const never = fakeV1State();
    never.tracks.push({ id: 'never', game: 'lmu', name: 'Imola', lengthM: 4909, lapCount: 0, validLapCount: 0, sessionCount: 0, carCount: 0, bestLapMs: null, lastDrivenAt: '2026-11-01T00:00:00.000Z' });
    openTrack('never', { on: never });
    expect(await screen.findByTestId('track-no-laps')).toBeInTheDocument();
    expect(screen.getByTestId('totals-best')).toHaveTextContent('–');
    expect(screen.getByTestId('totals-last')).toHaveTextContent('–');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('track-page').textContent).not.toMatch(/NaN|Infinity|undefined/);
  });
});
