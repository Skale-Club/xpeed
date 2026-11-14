// The phone layout of the track and car screens. jsdom has no layout engine, so what is checked here is the contract the layout is built on: the
// classes that say "one column until a width is reached", what hides on a phone, what scrolls inside its card, the order things come in when they
// stack. (The pages were also looked at in a browser at 375 px: no horizontal scroll on any of them, with data, an empty account and one lap.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { renderGarage } from '@/test/garage-render';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { CarPage } from '../CarPage';
import { SimCars } from '../SimCars';
import { TrackPage } from '../TrackPage';
import { TracksList } from '../TracksList';

vi.mock('../SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Bar: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');
const toyota = ref('Toyota GR010');

let state: FakeV1State;
beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
  state = fakeV1State();
  const session = v1Session({ track: monza, car: ferrari, lapCount: 2, bestLapMs: 99_000, startedAt: '2026-11-10T10:00:00.000Z' });
  state.sessions.push(session);
  state.laps.push(
    v1Lap({ track: monza, car: ferrari, sessionId: session.id, timeMs: 99_000, sectorsMs: [30_000, 35_000, 34_000], startedAt: '2026-11-10T10:00:00.000Z' }),
    v1Lap({ track: monza, car: toyota, sessionId: session.id, timeMs: 100_500, sectorsMs: [30_500, 35_200, 34_800], startedAt: '2026-11-12T10:00:00.000Z' }),
  );
  buildCatalog(state, { Monza: 5793 });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const classes = (element: Element) => element.getAttribute('class') ?? '';
/** The first class that sets the column count at a given breakpoint prefix ('' for none: the phone). */
const baseColumns = (element: Element) => (classes(element).split(/\s+/).find((name) => /^grid-cols-\d+$/.test(name)) ?? null);
const hiddenOnPhone = (cell: Element) => /(^|\s)hidden(\s|$)/.test(classes(cell)) && /(sm|md|lg):table-cell/.test(classes(cell));

describe('the lists on a phone', () => {
  it('stacks the filters and the cards in one column, the tiles two across, and lets the page never be wider than the screen', async () => {
    renderGarage(<TracksList />, { state, route: '/virtual/tracks' });
    await screen.findAllByTestId('track');
    expect(baseColumns(screen.getByRole('search'))).toBeNull(); // one column; sm: and lg: add more
    expect(classes(screen.getByRole('search'))).toMatch(/sm:grid-cols-2/);
    expect(baseColumns(screen.getByTestId('tracks-summary'))).toBe('grid-cols-2');
    expect(baseColumns(screen.getByTestId('tracks-grid'))).toBeNull();
    expect(classes(screen.getByTestId('tracks-grid'))).toMatch(/md:grid-cols-2/);
    // The search box and the drop-downs take the full width of their column and may shrink (min-w-0) instead of pushing the page wider.
    expect(classes(screen.getByTestId('filter-search'))).toMatch(/w-full/);
    expect(classes(screen.getByTestId('filter-game'))).toMatch(/w-full/);
    for (const element of document.querySelectorAll('[class*="min-w-["]')) expect(classes(element)).not.toMatch(/min-w-\[(\d{3,})px\]/);
  });

  it('does the same for the cars', async () => {
    renderGarage(<SimCars />, { state, route: '/virtual/cars' });
    await screen.findAllByTestId('cars-car');
    expect(baseColumns(screen.getByRole('search'))).toBeNull();
    expect(baseColumns(screen.getByTestId('cars-summary'))).toBe('grid-cols-2');
    expect(baseColumns(screen.getByTestId('cars-grid'))).toBeNull();
    expect(classes(screen.getByTestId('cars-grid'))).toMatch(/md:grid-cols-2/);
  });

  it('keeps the name of a track or car from pushing a card wider: it wraps in two lines or is cut with an ellipsis', async () => {
    state.tracks[0].name = 'Circuit de la Sarthe 24 Heures du Mans Grand Prix Layout Extended Name';
    renderGarage(<TracksList />, { state, route: '/virtual/tracks' });
    const title = (await screen.findAllByTestId('track'))[0].querySelector('h3')!;
    expect(classes(title)).toMatch(/line-clamp-2/);
  });
});

describe('the track page on a phone', () => {
  const open = () => renderGarage(<TrackPage />, {
    state, route: `/virtual/tracks/${monza.id}`,
    wrap: (page) => <Routes><Route path="/virtual/tracks/:id" element={page} /></Routes>,
  });

  it('stacks the header, the tiles, the layout and the leaderboard in that order, with the tiles two across', async () => {
    open();
    await screen.findByTestId('track-header');
    const tiles = screen.getByTestId('track-tiles');
    expect(baseColumns(tiles)).toBe('grid-cols-2');
    const map = await screen.findByTestId('track-no-layout');
    const board = await screen.findByTestId('track-leaderboard');
    expect(tiles.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(map.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The two-column hero only starts at the large breakpoint: below it the grid has no column count at all.
    expect(baseColumns(tiles.parentElement!.parentElement!)).toBeNull();
    expect(classes(tiles.parentElement!.parentElement!)).toMatch(/lg:grid-cols-12/);
  });

  it('keeps the tables inside their cards, scrolling there if they must, and hides the columns a phone has no room for', async () => {
    open();
    const table = (await within(await screen.findByTestId('best-per-car')).findByRole('table'));
    expect(classes(table.parentElement!)).toMatch(/overflow-x-auto/);
    const head = [...table.querySelectorAll('thead th')];
    const named = (text: string) => head.find((cell) => cell.textContent?.trim() === text)!;
    // What a phone keeps: the rank, the car, the lap, the gap and the analysis link. Laps, the sectors, the date and the class go.
    expect(hiddenOnPhone(named('Laps'))).toBe(true);
    expect(hiddenOnPhone(named('S1'))).toBe(true);
    expect(hiddenOnPhone(named('Set on'))).toBe(true);
    expect(hiddenOnPhone(named('Best valid lap'))).toBe(false);
    expect(hiddenOnPhone(named('Gap'))).toBe(false);
    for (const cell of table.querySelectorAll('tbody tr:first-child td')) {
      // The same columns are hidden in the body as in the head.
      const index = [...(cell.parentElement as HTMLElement).children].indexOf(cell);
      expect(hiddenOnPhone(cell)).toBe(hiddenOnPhone(head[index]));
    }
    // The name of the car is cut to a narrow column on a phone.
    expect(classes(table.querySelector('tbody td:nth-child(2)')!)).toMatch(/max-w-\[6\.5rem\]/);
  });

  it('puts the control of the progress chart (the car filter) beside the title without widening the card', async () => {
    state.laps.push(v1Lap({ track: monza, car: ferrari, timeMs: 99_500, startedAt: '2026-11-13T10:00:00.000Z' }));
    buildCatalog(state, { Monza: 5793 });
    open();
    const select = await screen.findByTestId('track-progress-car');
    expect(classes(select.closest('[class*="max-w-"]')!)).toMatch(/max-w-\[50%\]/);
  });
});

describe('the car page on a phone', () => {
  const open = () => renderGarage(<CarPage />, {
    state, route: `/virtual/cars/${ferrari.id}`,
    wrap: (page) => <Routes><Route path="/virtual/cars/:id" element={page} /></Routes>,
  });

  it('puts the tiles two across and the chart, the consistency and the table one under the other', async () => {
    open();
    await screen.findByTestId('car-header');
    expect(baseColumns(screen.getByTestId('car-tiles'))).toBe('grid-cols-2');
    const progress = await screen.findByTestId('car-progress');
    const consistency = await screen.findByTestId('car-consistency');
    const table = await screen.findByTestId('best-per-track');
    expect(baseColumns(progress.parentElement!.parentElement!)).toBeNull();
    expect(progress.compareDocumentPosition(consistency) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(consistency.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the track table inside its card and drops the laps and the date on a phone', async () => {
    open();
    const table = await within(await screen.findByTestId('best-per-track')).findByRole('table');
    expect(classes(table.parentElement!)).toMatch(/overflow-x-auto/);
    const head = [...table.querySelectorAll('thead th')];
    const named = (text: string) => head.find((cell) => cell.textContent?.trim() === text)!;
    expect(hiddenOnPhone(named('Laps'))).toBe(true);
    expect(hiddenOnPhone(named('Set on'))).toBe(true);
    expect(hiddenOnPhone(named('To your best'))).toBe(false);
    await waitFor(() => expect(table.querySelector('[data-testid="best-track-gap"]')).toBeInTheDocument());
    expect(classes(table.querySelector('tbody td:first-child')!)).toMatch(/max-w-\[6\.5rem\]/);
  });
});
