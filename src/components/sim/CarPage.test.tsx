import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { renderGarage } from '@/test/garage-render';
import { whereNow } from '@/test/sim-render';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, selectOptions } from '@/test/select';
import { CarPage } from './CarPage';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
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
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  state = fakeV1State();
  const sessionA = v1Session({ track: monza, car: ferrari, kind: 'race', lapCount: 4, bestLapMs: 99_000, startedAt: '2026-11-10T10:00:00.000Z' });
  const sessionB = v1Session({ track: spa, car: ferrari, kind: 'qualifying', lapCount: 2, bestLapMs: 134_000, startedAt: '2026-11-12T10:00:00.000Z' });
  state.sessions.push(sessionA, sessionB, v1Session({ track: monza, car: toyota, lapCount: 1, bestLapMs: 100_000 }));
  state.laps.push(
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 101_000, startedAt: '2026-11-10T10:00:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 99_000, startedAt: '2026-11-10T10:03:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 98_000, valid: false, startedAt: '2026-11-10T10:06:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 100_000, startedAt: '2026-11-10T10:09:00.000Z' }),
    v1Lap({ track: spa, car: ferrari, sessionId: sessionB.id, timeMs: 134_000, startedAt: '2026-11-12T10:00:00.000Z' }),
    v1Lap({ track: spa, car: ferrari, sessionId: sessionB.id, timeMs: 136_000, startedAt: '2026-11-12T10:03:00.000Z' }),
    v1Lap({ track: monza, car: toyota, timeMs: 100_000, startedAt: '2026-11-11T10:00:00.000Z' }),
  );
  buildCatalog(state);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const openCar = (id: string, on: FakeV1State = state) =>
  renderGarage(<CarPage />, {
    state: on, route: `/virtual/cars/${id}`,
    wrap: (page) => <Routes><Route path="/virtual/cars/:id" element={page} /><Route path="*" element={<p>elsewhere</p>} /></Routes>,
  });

describe('the car page', () => {
  it('is a dashboard: the identity with the class, the brand and the game, and a tile for every number', async () => {
    Object.assign(state.cars.find((car) => car.id === ferrari.id)!, { class: 'Hypercar', brand: 'Ferrari S.p.A.' });
    openCar(ferrari.id);
    expect(await screen.findByTestId('car-header')).toHaveTextContent('Ferrari 499P');
    expect(screen.getByTestId('car-header')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('car-subtitle')).toHaveTextContent('Last driven Nov 12, 2026');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('6');
    expect(screen.getByTestId('totals-laps-sub')).toHaveTextContent('83% valid');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('83%');
    expect(screen.getByTestId('totals-valid-sub')).toHaveTextContent('5 of 6');
    expect(screen.getByTestId('totals-tracks')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-sessions')).toHaveTextContent('2');
    // The best lap tile is the one on the track driven the most (Monza, 4 laps against 2), not the best over tracks that cannot be compared.
    expect(screen.getByTestId('totals-best')).toHaveTextContent('1:39.000');
    expect(screen.getByTestId('totals-best-sub')).toHaveTextContent('Monza, the most driven');
  });

  it('shows the class and the brand the API gives', async () => {
    // The car list of the fake server carries no class or brand; the detail of a car does, as the API's does.
    const item = state.cars.find((car) => car.id === ferrari.id)!;
    Object.assign(item, { class: 'Hypercar', brand: 'Ferrari' });
    openCar(ferrari.id);
    expect(await screen.findByTestId('car-class')).toHaveTextContent('Hypercar');
    expect(screen.getByTestId('car-brand')).toHaveTextContent('Ferrari');
  });

  it('adds up the time at the wheel from the laps of the car', async () => {
    openCar(ferrari.id);
    await waitFor(() => expect(screen.getByTestId('totals-time')).toHaveTextContent('11m 8s'));
    expect(state.requests.filter((request) => request.path === '/laps').every((request) => request.params.car === ferrari.id)).toBe(true);
  });

  it('lists the best valid lap on each track, the most driven first, each opening its track page and each lap its analysis', async () => {
    openCar(ferrari.id);
    const rows = await screen.findAllByTestId('best-track-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Monza');
    expect(within(rows[0]).getByTestId('best-track-time')).toHaveTextContent('1:39.000'); // not the voided 1:38.000
    expect(rows[1]).toHaveTextContent('Spa-Francorchamps');
    expect(within(rows[1]).getByTestId('best-track-time')).toHaveTextContent('2:14.000');
    expect(within(rows[0]).getByTestId('best-track-link')).toHaveAttribute('href', `/virtual/tracks/${monza.id}`);
    const bestMonza = state.laps.find((lap) => lap.timeMs === 99_000)!;
    expect(within(rows[0]).getByTestId('best-track-analyze')).toHaveAttribute('href', `/virtual/compare?a=${bestMonza.id}`);
  });

  it('gives the gap to your best lap on the track with any car: "Your best" when this car holds it, the seconds behind when another does', async () => {
    openCar(ferrari.id);
    const rows = await screen.findAllByTestId('best-track-row');
    await waitFor(() => expect(within(rows[0]).getByTestId('best-track-pb')).toHaveTextContent('Your best'));
    expect(within(rows[1]).getByTestId('best-track-pb')).toBeInTheDocument();
    cleanup();
    openCar(toyota.id);
    const toyotaRow = await screen.findByTestId('best-track-row');
    // Toyota's 1:40.000 on Monza is one second behind the 1:39.000 the Ferrari set there.
    await waitFor(() => expect(within(toyotaRow).getByTestId('best-track-gap')).toHaveTextContent('+1.000'));
    expect(within(toyotaRow).queryByTestId('best-track-pb')).not.toBeInTheDocument();
  });

  it('leaves the gap as a dash, not a skeleton for ever, when the personal bests cannot be read', async () => {
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    state.failingPath = '/pbs';
    openCar(ferrari.id);
    const rows = await screen.findAllByTestId('best-track-row');
    await waitFor(() => expect(within(rows[0]).getByTestId('best-track-gap')).toHaveTextContent('–'));
    expect(within(rows[0]).getByTestId('best-track-time')).toHaveTextContent('1:39.000');
  });

  it('shows how consistent you are on each track: the spread of the valid laps, and what is missing when there are too few', async () => {
    openCar(ferrari.id);
    const rows = await screen.findAllByTestId('car-consistency-row');
    // Monza: the valid laps 101.000, 99.000 and 100.000 differ by 1.00 s (the voided 98.000 is left out). Spa has two valid laps: not enough for a spread.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Monza');
    expect(within(rows[0]).getByTestId('car-consistency-spread')).toHaveTextContent('±1.00 s');
    expect(rows[0]).toHaveTextContent('3 clean laps');
    expect(rows[1]).toHaveTextContent('Spa-Francorchamps');
    expect(within(rows[1]).getByTestId('car-consistency-spread')).toHaveTextContent('needs 3 laps');
    expect(rows[1]).toHaveTextContent('2 clean laps');
  });

  it('draws the laps of each day as bars and the best valid lap of each day on one track as a line (the API gives it per day and track)', async () => {
    openCar(ferrari.id);
    const chart = await screen.findByTestId('chart');
    const rows = () => JSON.parse(screen.getByTestId('chart').getAttribute('data-rows') as string) as Array<{ day: string; bestS: number | null; laps: number }>;
    // Both tracks have one day: the first by name (Monza) is drawn, and the day with laps on the other track only has a bar.
    expect(rows().map((row) => [row.day, row.laps, row.bestS])).toEqual([['2026-11-10', 4, 99], ['2026-11-12', 2, null]]);
    expect(within(chart).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps', 'bestS']);
    expect(screen.getByTestId('car-progress-chart')).toHaveAttribute('role', 'img');
    expect(screen.getByTestId('car-progress-chart')).toHaveAttribute('aria-label', 'Laps per day: 6 laps on 2 days.');
    expect(screen.getByText('Progress on Monza')).toBeInTheDocument();
    // The track is chosen from a list of the tracks the car has a daily best on.
    const pick = screen.getByTestId('car-progress-track');
    expect(selectOptions(pick)).toEqual(['Monza', 'Spa-Francorchamps']);
    chooseOption(pick, 'Spa-Francorchamps');
    await waitFor(() => expect(rows().map((row) => row.bestS)).toEqual([null, 134]));
    expect(screen.getByText('Progress on Spa-Francorchamps')).toBeInTheDocument();
  });

  it('has no track to choose for a car with a best lap on one track only', async () => {
    openCar(toyota.id);
    await screen.findByTestId('car-header');
    expect(screen.queryByTestId('car-progress-track')).not.toBeInTheDocument();
    // One day of driving: a number, not a chart.
    expect(await screen.findByTestId('car-progress-single')).toHaveTextContent('Only one day of driving so far');
    expect(screen.getByTestId('car-progress-single')).toHaveTextContent('1:40.000');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('says there is no best-lap line, and draws the bars, when the laps of two days were all voided', async () => {
    const only = fakeV1State();
    const bad = ref('Ginetta G40');
    only.laps.push(
      v1Lap({ track: monza, car: bad, timeMs: 154_000, valid: false, startedAt: '2026-11-10T10:00:00.000Z' }),
      v1Lap({ track: monza, car: bad, timeMs: 153_000, valid: false, startedAt: '2026-11-12T10:00:00.000Z' }),
    );
    buildCatalog(only);
    openCar(bad.id, only);
    expect(await screen.findByTestId('chart')).toBeInTheDocument();
    expect(within(screen.getByTestId('chart')).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps']);
    expect(screen.getByTestId('car-progress-no-valid')).toHaveTextContent('No valid lap yet');
    expect(screen.queryByTestId('car-progress-track')).not.toBeInTheDocument();
  });

  it('lists the latest sessions with this car only, newest first', async () => {
    openCar(ferrari.id);
    const sessions = await screen.findAllByTestId('latest-session');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toHaveTextContent('Spa-Francorchamps');
    expect(sessions[1]).toHaveTextContent('Monza');
    expect(state.requests.find((request) => request.path === '/sessions')?.params.car).toBe(ferrari.id);
    expect(within(screen.getByTestId('latest-sessions')).getByRole('link', { name: 'All sessions' })).toHaveAttribute('href', `/virtual/sessions?car=${ferrari.id}`);
  });

  it('goes back to the list of cars, and says so when the car is not in the catalog', async () => {
    openCar(ferrari.id);
    fireEvent.click(await screen.findByRole('link', { name: /All cars/ }));
    await waitFor(() => expect(whereNow(screen.getByTestId('where')).pathname).toBe('/virtual/cars'));
    cleanup();
    openCar('00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByTestId('car-not-found')).toBeInTheDocument();
  });

  it('says the server is not answering, and stands in a skeleton shaped like the page while it waits', async () => {
    state.delayMs = 40;
    openCar(ferrari.id);
    expect(screen.getByTestId('garage-skeleton')).toHaveAttribute('role', 'status');
    await screen.findByTestId('car-header');
    cleanup();
    state.delayMs = 0;
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    openCar(ferrari.id);
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
  });

  it('says a car in the catalog that was never driven has no laps, and shows dashes, not zeros that look like data', async () => {
    const never = fakeV1State();
    never.cars.push({ id: 'never', game: 'lmu', name: 'Porsche 963', brand: null, class: null, lapCount: 0, validLapCount: 0, sessionCount: 0, trackCount: 0, bestLapMs: null, lastDrivenAt: '2026-11-01T00:00:00.000Z' });
    openCar('never', never);
    expect(await screen.findByTestId('car-no-laps')).toBeInTheDocument();
    expect(screen.getByTestId('totals-best')).toHaveTextContent('–');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('–');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('car-page').textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('looks intentional with the one lap of an account, flagged not valid by the game: dashes, messages, no NaN, no empty chart', async () => {
    const only = fakeV1State();
    const ginetta = ref('Ginetta G40');
    const session = v1Session({ track: ref('Interlagos'), car: ginetta, lapCount: 1, bestLapMs: null });
    only.sessions.push(session);
    only.laps.push(v1Lap({ track: session.track, car: ginetta, sessionId: session.id, timeMs: 154_252, valid: false, startedAt: '2026-11-13T19:00:00.000Z' }));
    buildCatalog(only, { Interlagos: 4309 });
    openCar(ginetta.id, only);
    expect(await screen.findByTestId('car-header')).toHaveTextContent('Ginetta G40');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('1');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('0%');
    expect(screen.getByTestId('totals-best')).toHaveTextContent('–');
    expect(screen.getByTestId('totals-best-sub')).toHaveTextContent('No valid lap yet');
    await waitFor(() => expect(screen.getByTestId('totals-time')).toHaveTextContent('2m 34s'));
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('car-progress-single')).toBeInTheDocument();
    expect(await screen.findByTestId('car-consistency-empty')).toBeInTheDocument();
    const row = screen.getByTestId('best-track-row');
    expect(within(row).getByTestId('best-track-time')).toHaveTextContent('–');
    expect(within(row).getByTestId('best-track-gap')).toHaveTextContent('–');
    expect(screen.getByTestId('car-page').textContent).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it('is written in Portuguese and in Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    openCar(ferrari.id);
    expect(await screen.findByText('Melhor volta em cada pista')).toBeInTheDocument();
    expect(screen.getByText('Regularidade por pista')).toBeInTheDocument();
    expect(screen.getByText('Pistas pilotadas')).toBeInTheDocument();
    expect(screen.getByText('Voltas válidas')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    openCar(ferrari.id);
    expect(await screen.findByText('Mejor vuelta en cada circuito')).toBeInTheDocument();
    expect(screen.getByText('Regularidad por circuito')).toBeInTheDocument();
    expect(screen.getByText('Circuitos conducidos')).toBeInTheDocument();
  });
});
