import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import type { V1CarItem } from '@/lib/sim/v1-client';
import { renderGarage } from '@/test/garage-render';
import { whereNow } from '@/test/sim-render';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, selectOptions, waitForOptions } from '@/test/select';
import { SimCars } from './SimCars';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const toyota = ref('Toyota GR010');
const porsche = ref('Porsche 911 GT3 R');

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let state: FakeV1State;
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  state = fakeV1State();
  const sessionA = v1Session({ track: monza, car: ferrari, lapCount: 3, bestLapMs: 99_000, startedAt: ago(2) });
  state.sessions.push(sessionA);
  state.laps.push(
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 101_000, startedAt: ago(2) }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 99_000, startedAt: ago(2) }),
    v1Lap({ track: monza, car: ferrari, sessionId: sessionA.id, timeMs: 98_000, valid: false, startedAt: ago(1) }),
    v1Lap({ track: spa, car: ferrari, timeMs: 134_000, startedAt: ago(1) }),
    v1Lap({ track: spa, car: toyota, timeMs: 135_000, startedAt: ago(60) }),
    v1Lap({ track: monza, car: porsche, game: 'ac', timeMs: 105_000, startedAt: ago(5) }),
  );
  buildCatalog(state);
  Object.assign(state.cars.find((car) => car.id === ferrari.id)!, { class: 'Hypercar', brand: 'Ferrari' });
  Object.assign(state.cars.find((car) => car.id === toyota.id)!, { class: 'Hypercar', brand: 'Toyota' });
  Object.assign(state.cars.find((car) => car.id === porsche.id)!, { class: 'GT3', brand: 'Porsche' });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const open = (route = '/virtual/cars', on: FakeV1State = state) => renderGarage(<SimCars />, { state: on, route });
const carItem = (extra: Partial<V1CarItem> & { id: string; name: string }): V1CarItem => ({
  game: 'lmu', brand: null, class: null, lapCount: 1, validLapCount: 1, sessionCount: 1, trackCount: 1, bestLapMs: 90_000, lastDrivenAt: '2026-11-01T00:00:00.000Z', ...extra,
});

describe('the list of cars', () => {
  it('shows each car as a card: identity, game, class and brand, the laps with the valid share, the tracks, and when it was last driven; each opening its page', async () => {
    open();
    const cards = await screen.findAllByTestId('cars-car');
    expect(cards).toHaveLength(3);
    // Most recently driven first: Ferrari (yesterday), Porsche (5 days ago), Toyota (60 days ago).
    expect(cards[0]).toHaveTextContent('Ferrari 499P');
    expect(cards[0]).toHaveTextContent('Le Mans Ultimate');
    expect(within(cards[0]).getByTestId('car-class')).toHaveTextContent('Hypercar');
    // The brand is not repeated when the name already starts with it.
    expect(within(cards[0]).queryByTestId('car-brand')).not.toBeInTheDocument();
    expect(within(cards[0]).getByTestId('car-laps')).toHaveTextContent('4');
    expect(within(cards[0]).getByTestId('car-laps')).toHaveTextContent('75% valid');
    expect(within(cards[0]).getByTestId('car-tracks')).toHaveTextContent('2');
    expect(cards[0]).toHaveTextContent(/Last driven/);
    expect(screen.getAllByTestId('car-link')[0]).toHaveAttribute('href', `/virtual/cars/${ferrari.id}`);
    expect(cards[1]).toHaveTextContent('Assetto Corsa');
    expect(within(cards[1]).getByTestId('car-class')).toHaveTextContent('GT3');
  });

  it('shows the best lap on the track driven the most, and the laps of the last 30 days as a sparkline (or says there were none)', async () => {
    open();
    const cards = await screen.findAllByTestId('cars-car');
    const ferrariCard = cards.find((card) => card.textContent?.includes('Ferrari 499P'))!;
    const toyotaCard = cards.find((card) => card.textContent?.includes('Toyota GR010'))!;
    await waitFor(() => expect(within(ferrariCard).getByTestId('car-best-time')).toHaveTextContent('1:39.000'));
    expect(within(ferrariCard).getByTestId('car-best')).toHaveTextContent('Best valid lap on Monza');
    const spark = within(ferrariCard).getByTestId('sparkline');
    expect(spark).toHaveAttribute('data-points', '30');
    expect(spark.querySelector('path')?.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    // The Toyota's only lap is 60 days old: nothing in the last 30 days, said in words and not drawn as a flat line.
    await waitFor(() => expect(within(toyotaCard).getByTestId('car-activity-none')).toHaveTextContent('No laps in the last 30 days'));
    expect(within(toyotaCard).queryByTestId('sparkline')).not.toBeInTheDocument();
  });

  it('adds up what the list shows in a strip: cars, laps with the valid share, sessions and the most driven car', async () => {
    open();
    await screen.findAllByTestId('cars-car');
    expect(screen.getByTestId('cars-summary-cars-value')).toHaveTextContent('3');
    expect(screen.getByTestId('cars-summary-laps-value')).toHaveTextContent('6');
    expect(screen.getByTestId('cars-summary-laps')).toHaveTextContent('83% valid');
    expect(screen.getByTestId('cars-summary-most-value')).toHaveTextContent('Ferrari 499P');
    expect(screen.getByTestId('cars-summary-most')).toHaveTextContent('4 laps');
  });

  it('filters by game', async () => {
    open();
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(3));
    await waitForOptions(() => screen.getByTestId('filter-game'), (labels) => labels.length > 2);
    chooseOption(screen.getByTestId('filter-game'), 'Assetto Corsa');
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(1));
    expect(screen.getByTestId('cars-car')).toHaveTextContent('Porsche 911 GT3 R');
    expect(state.requests.filter((request) => request.path === '/cars').at(-1)?.params.game).toBe('ac');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('game')).toBe('ac');
  });

  it('filters by class, offering the classes the cars have', async () => {
    open();
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(3));
    const pick = screen.getByTestId('filter-class');
    expect(selectOptions(pick)).toEqual(['All', 'GT3', 'Hypercar']);
    chooseOption(pick, 'Hypercar');
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(2));
    expect(screen.queryByText('Porsche 911 GT3 R')).not.toBeInTheDocument();
    expect(whereNow(screen.getByTestId('where')).searchParams.get('class')).toBe('Hypercar');
  });

  it('offers no class filter when no car has a class', async () => {
    for (const car of state.cars) car.class = null;
    open();
    await screen.findAllByTestId('cars-car');
    expect(screen.queryByTestId('filter-class')).not.toBeInTheDocument();
  });

  it('searches by name or brand, without regard to case or accents', async () => {
    state.cars.push(carItem({ id: 'cit', name: 'Citroën C3 Rally', brand: 'Citroën' }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(4));
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'CITROEN' } });
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(1));
    expect(screen.getByTestId('cars-car')).toHaveTextContent('Citroën C3 Rally');
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'gt3 porsche' } });
    await waitFor(() => expect(screen.getByTestId('cars-car')).toHaveTextContent('Porsche 911 GT3 R'));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('q')).toBe('gt3 porsche');
  });

  it('sorts by the most driven and by name, and keeps the sort in the address', async () => {
    // A car driven a lot, a long time ago, comes first by laps, first by name and last by recency.
    state.cars.push(carItem({ id: 'old', name: 'Alpine A424', lapCount: 500, validLapCount: 400, lastDrivenAt: '2025-01-01T00:00:00.000Z' }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(4));
    const order = () => screen.getAllByTestId('cars-car').map((card) => ['Alpine A424', 'Ferrari 499P', 'Porsche 911 GT3 R', 'Toyota GR010'].find((name) => card.textContent?.includes(name)));
    expect(order()).toEqual(['Ferrari 499P', 'Porsche 911 GT3 R', 'Toyota GR010', 'Alpine A424']); // by last driven
    const sort = screen.getByTestId('sort-select');
    expect(selectOptions(sort)).toEqual(['Recently driven', 'Most driven', 'Name (A to Z)']);
    chooseOption(sort, 'Name (A to Z)');
    await waitFor(() => expect(order()).toEqual(['Alpine A424', 'Ferrari 499P', 'Porsche 911 GT3 R', 'Toyota GR010']));
    chooseOption(sort, 'Most driven');
    await waitFor(() => expect(order()).toEqual(['Alpine A424', 'Ferrari 499P', 'Porsche 911 GT3 R', 'Toyota GR010']));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('sort')).toBe('most');
    chooseOption(sort, 'Recently driven');
    await waitFor(() => expect(order()).toEqual(['Ferrari 499P', 'Porsche 911 GT3 R', 'Toyota GR010', 'Alpine A424']));
    expect(whereNow(screen.getByTestId('where')).searchParams.has('sort')).toBe(false);
  });

  it('says nothing matches, and the way out clears the filters', async () => {
    open('/virtual/cars?q=zzz&class=GT3&sort=az');
    expect(await screen.findByTestId('cars-no-results')).toHaveTextContent('No car matches your search.');
    fireEvent.click(within(screen.getByTestId('cars-no-results')).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(3));
    expect(whereNow(screen.getByTestId('where')).search).toBe('');
  });

  it('shows a page at a time, with a Load more button, and reads the rest by itself when a search needs the whole list', async () => {
    state.cars = Array.from({ length: 60 }, (_, i) => carItem({ id: `c${i}`, name: `Car ${i}` }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(50));
    expect(screen.getAllByTestId('car-link')[0]).toHaveAttribute('href', '/virtual/cars/c0');
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(60));
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
    cleanup();
    state.requests.length = 0;
    open('/virtual/cars?q=car 57');
    await waitFor(() => expect(screen.getAllByTestId('cars-car')).toHaveLength(1));
    expect(screen.getByTestId('cars-car')).toHaveTextContent('Car 57');
    expect(state.requests.filter((request) => request.path === '/cars')).toHaveLength(2);
  });

  it('invites to connect Xpeed Companion when there are no cars, with no filters over an empty list', async () => {
    open('/virtual/cars', fakeV1State());
    expect(await screen.findByTestId('cars-empty')).toHaveTextContent('No cars yet');
    expect(screen.queryByTestId('filter-search')).not.toBeInTheDocument();
  });

  it('says the server is not answering, and stands in a skeleton while it waits', async () => {
    state.delayMs = 40;
    open();
    expect(screen.getByTestId('garage-skeleton')).toHaveAttribute('role', 'status');
    await screen.findAllByTestId('cars-car');
    cleanup();
    const down = fakeV1State();
    down.failing = { status: 503, error: 'unavailable', retryable: true };
    open('/virtual/cars', down);
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
  });

  it('looks intentional with the one lap of an account, flagged not valid by the game: a dash, no NaN', async () => {
    const only = fakeV1State();
    const ginetta = ref('Ginetta G40');
    only.laps.push(v1Lap({ track: ref('Interlagos'), car: ginetta, timeMs: 154_252, valid: false, startedAt: ago(0.1) }));
    buildCatalog(only, { Interlagos: 4309 });
    open('/virtual/cars', only);
    const card = await screen.findByTestId('cars-car');
    expect(card).toHaveTextContent('Ginetta G40');
    await waitFor(() => expect(within(card).getByTestId('car-best')).toHaveTextContent('Best valid lap on Interlagos'));
    expect(within(card).getByTestId('car-best-time')).toHaveTextContent('–');
    expect(card).toHaveTextContent('No valid lap yet');
    expect(within(card).getByTestId('car-laps')).toHaveTextContent('0% valid');
    expect(screen.getByTestId('cars').textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('is written in Portuguese and in Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    open();
    await screen.findAllByTestId('cars-car');
    expect(screen.getByLabelText('Buscar pelo nome')).toBeInTheDocument();
    expect(screen.getByText('Classe')).toBeInTheDocument();
    expect(screen.getByText('Mais pilotado')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    open();
    await screen.findAllByTestId('cars-car');
    expect(screen.getByText('Clase')).toBeInTheDocument();
    expect(screen.getByText('Más conducido')).toBeInTheDocument();
  });
});

describe('the toolbar of the list of cars', () => {
  it('is one wrapping row of compact controls (search, game, class, sort) with no card around it', async () => {
    open();
    await screen.findAllByTestId('cars-car');
    const bar = screen.getByTestId('cars-toolbar');
    expect(bar).toBe(screen.getByRole('search', { name: 'Filter the cars' }));
    expect(bar).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-2');
    for (const chrome of ['border', 'bg-card', 'p-3', 'p-4', 'grid']) expect(bar).not.toHaveClass(chrome);
    const parts = [...bar.children].map((child) => child.getAttribute('data-testid') ?? child.querySelector('[data-testid]')?.getAttribute('data-testid'));
    expect(parts).toEqual(['filter-search', 'filter-game', 'filter-class', 'sort-select']);
  });

  it('makes every control small (h-8, text-xs) with its name inside it, and has no caption above any of them', async () => {
    open();
    await screen.findAllByTestId('cars-car');
    for (const id of ['filter-game', 'filter-class', 'sort-select', 'filter-search']) expect(screen.getByTestId(id)).toHaveClass('h-8', 'text-xs');
    expect(screen.getByRole('combobox', { name: 'Class' })).toHaveTextContent(/^ClassAll$/);
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveTextContent(/^Sort byRecently driven$/);
    expect(screen.getByRole('searchbox', { name: 'Search by name' }).previousElementSibling?.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByTestId('cars-toolbar').querySelector('label')).toBeNull();
  });
});
