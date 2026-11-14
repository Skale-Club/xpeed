import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { renderSim, whereNow } from '@/test/sim-render';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { CarPage } from './CarPage';
import { SimCars } from './SimCars';

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
  const sessionA = v1Session({ track: monza, car: ferrari, kind: 'race', lapCount: 3, bestLapMs: 99_000, startedAt: '2026-11-10T10:00:00.000Z' });
  const sessionB = v1Session({ track: spa, car: ferrari, kind: 'qualifying', lapCount: 2, bestLapMs: 134_000, startedAt: '2026-11-12T10:00:00.000Z' });
  state.sessions.push(sessionA, sessionB, v1Session({ track: monza, car: toyota, lapCount: 1, bestLapMs: 100_000 }));
  state.laps.push(
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 101_000, startedAt: '2026-11-10T10:00:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 99_000, startedAt: '2026-11-10T10:03:00.000Z' }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 98_000, valid: false, startedAt: '2026-11-10T10:06:00.000Z' }),
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

const openCar = (id: string) =>
  renderSim(<CarPage />, {
    state, route: `/virtual/cars/${id}`,
    wrap: (page) => <Routes><Route path="/virtual/cars/:id" element={page} /><Route path="*" element={<p>elsewhere</p>} /></Routes>,
  });

describe('the car page', () => {
  it('shows the totals of the car', async () => {
    openCar(ferrari.id);
    expect(await screen.findByTestId('car-header')).toHaveTextContent('Ferrari 499P');
    expect(screen.getByTestId('car-header')).toHaveTextContent('Le Mans Ultimate');
    expect(screen.getByTestId('totals-laps')).toHaveTextContent('5');
    expect(screen.getByTestId('totals-valid')).toHaveTextContent('4');
    expect(screen.getByTestId('totals-sessions')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-tracks')).toHaveTextContent('2');
    expect(screen.getByTestId('totals-best')).toHaveTextContent('1:39.000');
  });

  it('lists the best valid lap on each track, by track name, each opening its track page and each lap its analysis', async () => {
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

  it('draws the laps of each day as bars and the best valid lap of each day on one track as a line (the API gives it per day and track)', async () => {
    openCar(ferrari.id);
    const chart = await screen.findByTestId('chart');
    const rows = () => JSON.parse(screen.getByTestId('chart').getAttribute('data-rows') as string) as Array<{ day: string; bestS: number | null; laps: number }>;
    // Both tracks have one day: the first by name (Monza) is drawn, and the day with laps on the other track only has a bar.
    expect(rows().map((row) => [row.day, row.laps, row.bestS])).toEqual([['2026-11-10', 3, 99], ['2026-11-12', 2, null]]);
    expect(within(chart).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps', 'bestS']);
    // The track is chosen from a list of the tracks the car has a daily best on.
    const pick = screen.getByTestId('car-progress-track') as HTMLSelectElement;
    expect([...pick.options].map((option) => option.textContent)).toEqual(['Monza', 'Spa-Francorchamps']);
    fireEvent.change(pick, { target: { value: spa.id } });
    await waitFor(() => expect(rows().map((row) => row.bestS)).toEqual([null, 134]));
  });

  it('has no track to choose for a car with a best lap on one track only', async () => {
    openCar(toyota.id);
    await screen.findByTestId('chart');
    expect(screen.queryByTestId('car-progress-track')).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('chart').getAttribute('data-rows') as string).map((row: { bestS: number | null }) => row.bestS)).toEqual([100]);
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
});

describe('the list of cars', () => {
  it('groups the cars by game, each opening its page, with a page at a time', async () => {
    state.cars = [
      ...state.cars,
      ...Array.from({ length: 55 }, (_, i) => ({ id: `ac-${i}`, game: 'ac', name: `Car ${i}`, brand: null, class: null, lapCount: 1, validLapCount: 1, sessionCount: 1, trackCount: 1, bestLapMs: 90_000, lastDrivenAt: '2026-11-01T00:00:00.000Z' })),
    ];
    renderSim(<SimCars />, { state, route: '/virtual/cars' });
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(50));
    expect(screen.getAllByTestId('car-link')[0]).toHaveAttribute('href', `/virtual/cars/${state.cars[0].id}`);
    expect(screen.getAllByTestId('cars-game').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(state.cars.length));
  });
});
