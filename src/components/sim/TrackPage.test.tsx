import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim, whereNow } from '@/test/sim-render';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { TrackPage } from './TrackPage';
import { TracksList } from './TracksList';

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
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 101_000, startedAt: '2026-11-10T10:00:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 99_000, startedAt: '2026-11-10T10:03:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 98_000, valid: false, startedAt: '2026-11-10T10:06:00.000Z' }),
    v1Lap({ track: monza, car: toyota, sessionId: sessionB.id, timeMs: 100_500, startedAt: '2026-11-12T10:00:00.000Z' }),
    v1Lap({ track: monza, car: toyota, sessionId: sessionB.id, timeMs: 102_000, startedAt: '2026-11-12T10:03:00.000Z' }),
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

const openTrack = (id: string, accountTracks?: AccountTrack[]) =>
  renderSim(<TrackPage />, {
    state, route: `/virtual/tracks/${id}`, accountTracks,
    wrap: (page) => <Routes><Route path="/virtual/tracks/:id" element={page} /><Route path="*" element={<p>elsewhere</p>} /></Routes>,
  });

describe('the track page', () => {
  it('shows the totals of the track', async () => {
    openTrack(monza.id);
    expect(await screen.findByTestId('track-header')).toHaveTextContent('Monza');
    expect(screen.getByTestId('track-header')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('track-header')).toHaveTextContent('5.79 km');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('5');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('4');
    expect(screen.getByTestId('totals-sessions')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-cars')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-best')).toHaveTextContent('1:39.000');
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
  });

  it('lists the best lap with each car, the fastest first, each car opening its page and each lap its analysis', async () => {
    openTrack(monza.id);
    const rows = await screen.findAllByTestId('best-car-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ferrari 499P');
    expect(within(rows[0]).getByTestId('best-car-time')).toHaveTextContent('1:39.000');
    expect(rows[1]).toHaveTextContent('Toyota GR010');
    expect(within(rows[1]).getByTestId('best-car-time')).toHaveTextContent('1:40.500');
    expect(within(rows[0]).getByTestId('best-car-link')).toHaveAttribute('href', `/virtual/cars/${ferrari.id}`);
    const bestLap = state.laps.find((lap) => lap.timeMs === 99_000)!;
    expect(within(rows[0]).getByTestId('best-car-analyze')).toHaveAttribute('href', `/virtual/compare?a=${bestLap.id}`);
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

  it('reads no lap file when the track has no layout (the map needs one)', async () => {
    openTrack(monza.id);
    await screen.findByTestId('best-per-car');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.requests.filter((request) => request.path.endsWith('/file'))).toHaveLength(0);
    expect(screen.queryByTestId('track-layout-map')).not.toBeInTheDocument();
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

  it('writes the totals in Portuguese', async () => {
    await i18n.changeLanguage('pt-BR');
    openTrack(monza.id);
    expect(await screen.findByText('Melhor volta com cada carro')).toBeInTheDocument();
    expect(screen.getByText('Todas as pistas')).toBeInTheDocument();
  });
});

describe('the list of tracks', () => {
  const layout = (trackName: string): AccountTrack => ({ id: `layout-${trackName}`, game: 'lmu', trackName, variant: null, title: null, lengthM: 5793, size: 1000, updatedAt: '2026-11-10T00:00:00.000Z' });

  it('lists the tracks with the laps, the best lap and when each was last driven, each opening its page', async () => {
    renderSim(<TracksList />, { state, route: '/virtual/tracks' });
    const cards = await screen.findAllByTestId('track');
    expect(cards).toHaveLength(2);
    // Most recently driven first: Monza (12 Nov) before Spa (11 Nov).
    expect(cards[0]).toHaveTextContent('Monza');
    expect(within(cards[0]).getByTestId('track-laps')).toHaveTextContent('Laps: 5');
    expect(within(cards[0]).getByTestId('track-best')).toHaveTextContent('1:39.000');
    expect(cards[0]).toHaveTextContent('Last driven Nov 12, 2026');
    expect(cards[1]).toHaveTextContent('Spa-Francorchamps');
    expect(screen.getAllByTestId('track-link')[0]).toHaveAttribute('href', `/virtual/tracks/${monza.id}`);
  });

  it('marks a track whose layout Xpeed Companion has sent, matched by name through the account tracks', async () => {
    renderSim(<TracksList />, { state, route: '/virtual/tracks', accountTracks: [layout('monza')] });
    const cards = await screen.findAllByTestId('track');
    await waitFor(() => expect(within(cards[0]).getByTestId('track-layout-badge')).toHaveTextContent('Layout'));
    expect(within(cards[1]).queryByTestId('track-layout-badge')).not.toBeInTheDocument();
  });

  it('takes the layout badge from the hasLayout flag of the server, and then reads no layout list nor matches names itself', async () => {
    const monzaItem = state.tracks.find((track) => track.id === monza.id)!;
    const spaItem = state.tracks.find((track) => track.id === spa.id)!;
    Object.assign(monzaItem, { hasLayout: false, layoutId: null });
    Object.assign(spaItem, { hasLayout: true, layoutId: '30000000-0000-4000-8000-000000000001' });
    // The account list would say the opposite (it holds a Monza layout): the server's flag wins, and the list is not even asked for.
    renderSim(<TracksList />, { state, route: '/virtual/tracks', accountTracks: [layout('monza')] });
    const cards = await screen.findAllByTestId('track');
    expect(cards[0]).toHaveTextContent('Monza');
    expect(within(cards[0]).queryByTestId('track-layout-badge')).not.toBeInTheDocument();
    expect(within(cards[1]).getByTestId('track-layout-badge')).toHaveTextContent('Layout');
    const asked = (globalThis.fetch as unknown as { mock: { calls: Array<[RequestInfo | URL]> } }).mock.calls.map(([input]) => new URL(String(input), 'http://localhost').pathname);
    expect(asked).not.toContain('/api/sim/tracks');
  });

  it('filters by game', async () => {
    state.tracks.push({ id: 'ac-track', game: 'ac', name: 'Imola', lengthM: 4909, lapCount: 1, validLapCount: 1, sessionCount: 1, carCount: 1, bestLapMs: 108_000, lastDrivenAt: '2026-11-01T00:00:00.000Z' });
    state.laps.push(v1Lap({ game: 'ac', track: ref('Imola', 'ac-track'), car: ref('Ferrari 488 GT3'), timeMs: 108_000 }));
    renderSim(<TracksList />, { state, route: '/virtual/tracks' });
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(3));
    await waitFor(() => expect((screen.getByTestId('filter-game') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    fireEvent.change(screen.getByTestId('filter-game'), { target: { value: 'ac' } });
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(1));
    expect(screen.getByTestId('track')).toHaveTextContent('Imola');
    expect(state.requests.filter((request) => request.path === '/tracks').at(-1)?.params.game).toBe('ac');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('game')).toBe('ac');
  });

  it('shows a page at a time, with a Load more button', async () => {
    state.tracks = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, game: 'lmu', name: `Track ${i}`, lengthM: 4000, lapCount: 1, validLapCount: 1, sessionCount: 1, carCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-01T00:00:00.000Z' }));
    renderSim(<TracksList />, { state, route: '/virtual/tracks' });
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(50));
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(60));
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
  });

  it('invites to connect Xpeed Companion when there are no tracks, and reads no lap file', async () => {
    renderSim(<TracksList />, { state: fakeV1State(), route: '/virtual/tracks' });
    expect(await screen.findByTestId('tracks-empty')).toHaveTextContent('No tracks yet');
  });

  it('says the server is not answering', async () => {
    const down = fakeV1State();
    down.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSim(<TracksList />, { state: down, route: '/virtual/tracks' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
  });
});
