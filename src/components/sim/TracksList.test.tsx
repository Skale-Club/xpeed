import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import type { AccountTrack } from '@/lib/sim/account-tracks';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderGarage } from '@/test/garage-render';
import { whereNow } from '@/test/sim-render';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { buildCatalog, fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import type { V1TrackItem } from '@/lib/sim/v1-client';
import { TracksList } from './TracksList';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const toyota = ref('Toyota GR010');

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let state: FakeV1State;
let idb: FakeIdb;
beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
  state = fakeV1State();
  const sessionA = v1Session({ track: monza, car: ferrari, lapCount: 3, bestLapMs: 99_000, startedAt: '2026-11-10T10:00:00.000Z' });
  const sessionB = v1Session({ track: monza, car: toyota, lapCount: 2, bestLapMs: 100_500, startedAt: '2026-11-12T10:00:00.000Z' });
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

const layout = (trackName: string): AccountTrack => ({ id: `layout-${trackName}`, game: 'lmu', trackName, variant: null, title: null, lengthM: 5793, size: 1000, updatedAt: '2026-11-10T00:00:00.000Z' });
const open = (route = '/virtual/tracks', options: Parameters<typeof renderGarage>[1] = {}) => renderGarage(<TracksList />, { state, route, ...options });
const names = () => screen.getAllByTestId('track').map((card) => card.querySelector('h3')?.textContent);
const item = (extra: Partial<V1TrackItem> & { id: string; name: string }): V1TrackItem => ({
  game: 'lmu', lengthM: 4000, lapCount: 1, validLapCount: 1, sessionCount: 1, carCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-01T00:00:00.000Z', ...extra,
});

describe('the list of tracks', () => {
  it('lists the tracks as cards with the game, the length, the laps, the best lap and when each was last driven, each opening its page', async () => {
    open();
    const cards = await screen.findAllByTestId('track');
    expect(cards).toHaveLength(2);
    // Most recently driven first: Monza (12 Nov) before Spa (11 Nov).
    expect(cards[0]).toHaveTextContent('Monza');
    expect(cards[0]).toHaveTextContent('Le Mans Ultimate');
    expect(within(cards[0]).getByTestId('track-length')).toHaveTextContent('5.79 km');
    expect(within(cards[0]).getByTestId('track-laps')).toHaveTextContent('5');
    expect(within(cards[0]).getByTestId('track-laps')).toHaveTextContent('80% valid');
    expect(within(cards[0]).getByTestId('track-sessions')).toHaveTextContent('2');
    expect(within(cards[0]).getByTestId('track-best-time')).toHaveTextContent('1:39.000');
    expect(cards[0]).toHaveTextContent('Last driven Nov 12, 2026');
    expect(cards[1]).toHaveTextContent('Spa-Francorchamps');
    expect(within(cards[1]).getByTestId('track-length')).toHaveTextContent('Length not known');
    expect(screen.getAllByTestId('track-link')[0]).toHaveAttribute('href', `/virtual/tracks/${monza.id}`);
  });

  it('adds up what the list shows in a strip: tracks, laps with the valid share, sessions and the most driven track', async () => {
    open();
    await screen.findAllByTestId('track');
    expect(screen.getByTestId('tracks-summary-tracks-value')).toHaveTextContent('2');
    expect(screen.getByTestId('tracks-summary-laps-value')).toHaveTextContent('6');
    expect(screen.getByTestId('tracks-summary-laps')).toHaveTextContent('83% valid');
    expect(screen.getByTestId('tracks-summary-sessions-value')).toHaveTextContent('3');
    expect(screen.getByTestId('tracks-summary-most-value')).toHaveTextContent('Monza');
    expect(screen.getByTestId('tracks-summary-most')).toHaveTextContent('5 laps');
  });

  it('shows the best car of each track, and how the best lap moved in 30 days with a sparkline of the best so far', async () => {
    state.laps = [
      // Monza: 100.0 s two months ago, 99.0 s 40 days ago, 98.0 s five days ago: 1.0 s faster than 30 days ago.
      v1Lap({ track: monza, car: ferrari, timeMs: 100_000, startedAt: ago(60) }), v1Lap({ track: monza, car: ferrari, timeMs: 99_000, startedAt: ago(40) }), v1Lap({ track: monza, car: ferrari, timeMs: 98_000, startedAt: ago(5) }),
      // Spa: the first valid lap came this week.
      v1Lap({ track: spa, car: toyota, timeMs: 135_000, startedAt: ago(2) }),
    ];
    state.sessions = [];
    buildCatalog(state, { Monza: 5793 });
    open();
    const cards = await screen.findAllByTestId('track');
    const monzaCard = cards.find((card) => card.textContent?.includes('Monza'))!;
    const spaCard = cards.find((card) => card.textContent?.includes('Spa'))!;
    await waitFor(() => expect(within(monzaCard).getByTestId('pb-trend')).toHaveAttribute('data-trend', 'faster'));
    expect(within(monzaCard).getByTestId('pb-trend')).toHaveTextContent('-1.000 s');
    expect(within(monzaCard).getByTestId('pb-trend')).toHaveTextContent('1.000 s faster than 30 days ago');
    expect(within(monzaCard).getByTestId('track-best-car')).toHaveTextContent('Ferrari 499P');
    expect(within(monzaCard).getByTestId('pb-spark')).toHaveAttribute('data-points', '3');
    expect(within(monzaCard).getByTestId('pb-spark').querySelector('path')?.getAttribute('d')).not.toMatch(/NaN|Infinity/);
    await waitFor(() => expect(within(spaCard).getByTestId('pb-trend')).toHaveAttribute('data-trend', 'first'));
    expect(within(spaCard).getByTestId('pb-spark')).toHaveAttribute('data-points', '1');
    expect(within(spaCard).getByTestId('track-best-car')).toHaveTextContent('Toyota GR010');
  });

  it('says the best lap has not moved when no lap in the last 30 days beat it', async () => {
    state.laps = [v1Lap({ track: monza, car: ferrari, timeMs: 99_000, startedAt: ago(50) }), v1Lap({ track: monza, car: ferrari, timeMs: 100_000, startedAt: ago(3) })];
    state.sessions = [];
    buildCatalog(state, { Monza: 5793 });
    open();
    const card = await screen.findByTestId('track');
    await waitFor(() => expect(within(card).getByTestId('pb-trend')).toHaveAttribute('data-trend', 'steady'));
  });

  it('marks a track whose layout Xpeed Companion has sent, matched by name through the account tracks', async () => {
    open('/virtual/tracks', { accountTracks: [layout('monza')] });
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
    const { asked } = open('/virtual/tracks', { accountTracks: [layout('monza')] });
    const cards = await screen.findAllByTestId('track');
    expect(cards[0]).toHaveTextContent('Monza');
    expect(within(cards[0]).queryByTestId('track-layout-badge')).not.toBeInTheDocument();
    expect(within(cards[1]).getByTestId('track-layout-badge')).toHaveTextContent('Layout');
    expect(asked).not.toContain('/api/sim/tracks');
  });

  it('draws a small shape of the track on a card that has a layout, and none on a card that has not', async () => {
    const bytes = await gzipBytes(packLayout(makeLayout({ points: circle(300, 80), width: 8, closed: true, game: 'lmu', name: 'Spa-Francorchamps' })));
    Object.assign(state.tracks.find((track) => track.id === monza.id)!, { hasLayout: false, layoutId: null });
    Object.assign(state.tracks.find((track) => track.id === spa.id)!, { hasLayout: true, layoutId: 'layout-spa' });
    const { asked } = open('/virtual/tracks', { files: new Map([['layout-spa', bytes]]) });
    const cards = await screen.findAllByTestId('track');
    const spaCard = cards.find((card) => card.textContent?.includes('Spa'))!;
    const monzaCard = cards.find((card) => card.textContent?.includes('Monza'))!;
    const shape = await within(spaCard).findByTestId('track-preview-shape');
    expect(shape.querySelector('polyline')?.getAttribute('points')).not.toMatch(/NaN|Infinity/);
    expect(within(monzaCard).queryByTestId('track-preview')).not.toBeInTheDocument();
    expect(within(monzaCard).queryByTestId('track-preview-shape')).not.toBeInTheDocument();
    // One small file for the one layout, nothing for the other card.
    expect(asked.filter((path) => path.includes('/file'))).toEqual(['/api/sim/tracks/layout-spa/file']);
  });

  it('shows the layout badge and a place for the shape, and no shape, when the layout file cannot be read', async () => {
    Object.assign(state.tracks.find((track) => track.id === spa.id)!, { hasLayout: true, layoutId: 'layout-spa' });
    open();
    const cards = await screen.findAllByTestId('track');
    const spaCard = cards.find((card) => card.textContent?.includes('Spa'))!;
    await waitFor(() => expect(within(spaCard).getByTestId('track-preview')).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(spaCard).queryByTestId('track-preview-shape')).not.toBeInTheDocument();
  });

  it('reads the detail and the layout of a card only when it comes on screen', async () => {
    const watched = new Map<Element, () => void>();
    class FakeObserver {
      private readonly callback: IntersectionObserverCallback;
      constructor(callback: IntersectionObserverCallback) { this.callback = callback; }
      observe(element: Element) { watched.set(element, () => this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver)); }
      disconnect() { /* nothing to release */ }
      unobserve() { /* nothing to release */ }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    open();
    const links = await screen.findAllByTestId('track-link');
    expect(links).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const detailCalls = () => state.requests.filter((request) => /^\/tracks\/[^/]+$/.test(request.path));
    expect(detailCalls()).toHaveLength(0);
    watched.get(links[1])!();
    await waitFor(() => expect(detailCalls().map((request) => request.path)).toEqual([`/tracks/${spa.id}`]));
    watched.get(links[0])!();
    await waitFor(() => expect(detailCalls()).toHaveLength(2));
  });

  it('filters by game', async () => {
    state.tracks.push({ id: 'ac-track', game: 'ac', name: 'Imola', lengthM: 4909, lapCount: 1, validLapCount: 1, sessionCount: 1, carCount: 1, bestLapMs: 108_000, lastDrivenAt: '2026-11-01T00:00:00.000Z' });
    state.laps.push(v1Lap({ game: 'ac', track: ref('Imola', 'ac-track'), car: ref('Ferrari 488 GT3'), timeMs: 108_000 }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(3));
    await waitFor(() => expect((screen.getByTestId('filter-game') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    fireEvent.change(screen.getByTestId('filter-game'), { target: { value: 'ac' } });
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(1));
    expect(screen.getByTestId('track')).toHaveTextContent('Imola');
    expect(state.requests.filter((request) => request.path === '/tracks').at(-1)?.params.game).toBe('ac');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('game')).toBe('ac');
  });

  it('searches by name, without regard to case, accents or punctuation, and keeps the search in the address', async () => {
    state.tracks.push(item({ id: 'nord', name: 'Nürburgring Nordschleife', lastDrivenAt: '2026-11-02T00:00:00.000Z' }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(3));
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'NURBURG' } });
    await waitFor(() => expect(names()).toEqual(['Nürburgring Nordschleife']));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('q')).toBe('NURBURG');
    expect(screen.getByTestId('tracks-summary-tracks-value')).toHaveTextContent('1');
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: 'spa francorchamps' } });
    await waitFor(() => expect(names()).toEqual(['Spa-Francorchamps']));
    fireEvent.change(screen.getByTestId('filter-search'), { target: { value: '' } });
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(3));
    expect(whereNow(screen.getByTestId('where')).searchParams.has('q')).toBe(false);
  });

  it('says nothing matches, and the way out clears the filters', async () => {
    open('/virtual/tracks?q=zzz&sort=az&layout=1');
    expect(await screen.findByTestId('tracks-no-results')).toHaveTextContent('No track matches your search.');
    expect(screen.getByTestId('filter-search')).toHaveValue('zzz');
    fireEvent.click(within(screen.getByTestId('tracks-no-results')).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(2));
    expect(whereNow(screen.getByTestId('where')).search).toBe('');
  });

  it('sorts by the most driven, by name and by the most recently driven, and keeps the sort in the address', async () => {
    state.tracks.push(item({ id: 'big', name: 'Imola', lapCount: 90, validLapCount: 80, lastDrivenAt: '2026-11-01T00:00:00.000Z' }), item({ id: 'ab', name: 'Albert Park', lastDrivenAt: '2026-11-03T00:00:00.000Z' }));
    open();
    await waitFor(() => expect(names()).toEqual(['Monza', 'Spa-Francorchamps', 'Albert Park', 'Imola']));
    const sort = screen.getByTestId('sort-select') as HTMLSelectElement;
    expect([...sort.options].map((option) => option.textContent)).toEqual(['Recently driven', 'Most driven', 'Name (A to Z)']);
    fireEvent.change(sort, { target: { value: 'most' } });
    await waitFor(() => expect(names()).toEqual(['Imola', 'Monza', 'Spa-Francorchamps', 'Albert Park']));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('sort')).toBe('most');
    fireEvent.change(sort, { target: { value: 'az' } });
    await waitFor(() => expect(names()).toEqual(['Albert Park', 'Imola', 'Monza', 'Spa-Francorchamps']));
    fireEvent.change(sort, { target: { value: 'recent' } });
    await waitFor(() => expect(names()).toEqual(['Monza', 'Spa-Francorchamps', 'Albert Park', 'Imola']));
    expect(whereNow(screen.getByTestId('where')).searchParams.has('sort')).toBe(false);
  });

  it('filters to the tracks that have a layout', async () => {
    Object.assign(state.tracks.find((track) => track.id === monza.id)!, { hasLayout: false, layoutId: null });
    Object.assign(state.tracks.find((track) => track.id === spa.id)!, { hasLayout: true, layoutId: 'layout-spa' });
    open();
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(2));
    const toggle = screen.getByTestId('filter-layout');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(names()).toEqual(['Spa-Francorchamps']));
    expect(screen.getByTestId('filter-layout')).toHaveAttribute('aria-pressed', 'true');
    expect(whereNow(screen.getByTestId('where')).searchParams.get('layout')).toBe('1');
    fireEvent.click(screen.getByTestId('filter-layout'));
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(2));
  });

  it('shows a page at a time, with a Load more button', async () => {
    state.tracks = Array.from({ length: 60 }, (_, i) => item({ id: `t${i}`, name: `Track ${i}` }));
    open();
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(50));
    expect(screen.getByTestId('tracks-summary-tracks-value')).toHaveTextContent('50+');
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('track')).toHaveLength(60));
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracks-summary-tracks-value')).toHaveTextContent('60');
  });

  it('reads the rest of the pages by itself when a search needs the whole list', async () => {
    state.tracks = Array.from({ length: 60 }, (_, i) => item({ id: `t${i}`, name: `Track ${i}` }));
    open('/virtual/tracks?q=track 55');
    await waitFor(() => expect(names()).toEqual(['Track 55']));
    expect(state.requests.filter((request) => request.path === '/tracks')).toHaveLength(2);
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
  });

  it('invites to connect Xpeed Companion when there are no tracks, and shows no filters over an empty list', async () => {
    open('/virtual/tracks', { state: fakeV1State() });
    expect(await screen.findByTestId('tracks-empty')).toHaveTextContent('No tracks yet');
    expect(screen.queryByTestId('filter-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tracks-summary')).not.toBeInTheDocument();
  });

  it('says there is no track of the game when the game has none', async () => {
    open('/virtual/tracks?game=ac');
    expect(await screen.findByTestId('tracks-no-match')).toBeInTheDocument();
    expect(screen.getByTestId('filter-search')).toBeInTheDocument();
  });

  it('says the server is not answering', async () => {
    const down = fakeV1State();
    down.failing = { status: 503, error: 'unavailable', retryable: true };
    open('/virtual/tracks', { state: down });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
  });

  it('stands in a skeleton of cards while the first read runs', async () => {
    state.delayMs = 40;
    open();
    expect(screen.getByTestId('garage-skeleton')).toHaveAttribute('role', 'status');
    expect(await screen.findAllByTestId('track')).toHaveLength(2);
  });

  it('looks intentional with the one lap of an account, flagged not valid by the game: a dash, no spark, no NaN', async () => {
    const interlagos = ref('Interlagos');
    const only = fakeV1State();
    only.laps.push(v1Lap({ track: interlagos, car: ref('Ginetta G40'), timeMs: 154_252, valid: false, startedAt: ago(0.1) }));
    buildCatalog(only, { Interlagos: 4309 });
    open('/virtual/tracks', { state: only });
    const card = await screen.findByTestId('track');
    expect(card).toHaveTextContent('Interlagos');
    expect(within(card).getByTestId('track-best-time')).toHaveTextContent('–');
    expect(card).toHaveTextContent('No valid lap yet');
    expect(within(card).getByTestId('track-laps')).toHaveTextContent('0% valid');
    expect(within(card).queryByTestId('pb-spark')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('pb-trend')).not.toBeInTheDocument();
    expect(screen.getByTestId('tracks-list').textContent).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('is written in Portuguese and in Spanish', async () => {
    await i18n.changeLanguage('pt-BR');
    open();
    await screen.findAllByTestId('track');
    expect(screen.getByText('Buscar pelo nome')).toBeInTheDocument();
    expect(screen.getByText('Com traçado')).toBeInTheDocument();
    expect(screen.getByText('Pilotados recentemente')).toBeInTheDocument();
    expect(screen.getByText('Mais pilotado')).toBeInTheDocument();
    cleanup();
    await i18n.changeLanguage('es-ES');
    open();
    await screen.findAllByTestId('track');
    expect(screen.getByText('Buscar por nombre')).toBeInTheDocument();
    expect(screen.getByText('Con trazado')).toBeInTheDocument();
  });
});
