import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import type { V1CarItem, V1TrackItem } from '@/lib/sim/v1-client';
import { SessionsList } from './SessionsList';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const porsche = ref('Porsche 963');
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() - offsetMs).toISOString();

const trackItem = (track: { id: string; name: string }): V1TrackItem => ({ id: track.id, game: 'lmu', name: track.name, lengthM: 5793, lapCount: 5, validLapCount: 4, sessionCount: 1, carCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' });
const carItem = (car: { id: string; name: string }): V1CarItem => ({ id: car.id, game: 'lmu', name: car.name, brand: null, class: null, lapCount: 5, validLapCount: 4, sessionCount: 1, trackCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' });

/** Monza in the Ferrari three times (a personal best, a slower practice the same day, an older race), and Spa in the Porsche once, a session the game voided entirely. */
function seeded() {
  const fast = v1Session({ track: monza, car: ferrari, kind: 'race', startedAt: '2026-11-12T18:00:00.000Z', endedAt: '2026-11-12T18:30:00.000Z', lapCount: 3, bestLapMs: 99_000 });
  const slow = v1Session({ track: monza, car: ferrari, kind: 'practice', startedAt: '2026-11-12T09:00:00.000Z', endedAt: '2026-11-12T09:20:00.000Z', lapCount: 2, bestLapMs: 99_900 });
  const older = v1Session({ track: monza, car: ferrari, kind: 'practice', startedAt: '2026-11-05T09:00:00.000Z', endedAt: '2026-11-05T09:40:00.000Z', lapCount: 1, bestLapMs: 101_000 });
  const voided = v1Session({ game: 'ac', track: spa, car: porsche, kind: 'qualifying', startedAt: '2026-11-11T10:00:00.000Z', endedAt: '2026-11-11T10:10:00.000Z', lapCount: 1, bestLapMs: null });
  const on = (session: typeof fast, number: number, timeMs: number, extra = {}) => v1Lap({ game: session.game, sessionId: session.id, track: session.track, car: session.car, lapNumber: number, timeMs, startedAt: session.startedAt, ...extra });
  const laps = [
    on(fast, 1, 105_000, { outLap: true }), on(fast, 2, 99_000), on(fast, 3, 99_400),
    on(slow, 1, 99_900), on(slow, 2, 100_300),
    on(older, 1, 101_000),
    on(voided, 1, 120_000, { valid: false }),
  ];
  const state = fakeV1State({ sessions: [fast, slow, older, voided], laps, tracks: [trackItem(monza), trackItem(spa)], cars: [carItem(ferrari), carItem(porsche)] });
  return { state, fast, slow, older, voided };
}

/** A browser that tells every observed element it is on screen, at once. */
function seeEverything() {
  class Seeing {
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    disconnect() {}
    unobserve() {}
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', Seeing);
}

const search = () => whereNow(screen.getByTestId('where')).searchParams;
const sessionsShown = () => screen.getAllByTestId('session');

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('settings_timezone', 'UTC');
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the days', () => {
  it('groups the sessions under the day they started on, newest day first, each with its session and lap counts', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const headings = screen.getAllByTestId('day-heading');
    expect(headings.map((heading) => heading.getAttribute('data-day'))).toEqual(['2026-11-12', '2026-11-11', '2026-11-05']);
    expect(headings[0]).toHaveTextContent('Thursday, November 12');
    expect(headings[0]).toHaveTextContent('2 sessions · 5 laps');
    expect(headings[1]).toHaveTextContent('1 session · 1 lap');
    const groups = within(screen.getByTestId('session-groups')).getAllByRole('region');
    expect(within(groups[0]).getAllByTestId('session')).toHaveLength(2);
    expect(within(groups[1]).getAllByTestId('session')).toHaveLength(1);
  });

  it('keeps the heading of a day in view while its sessions scroll (it is sticky)', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    expect(screen.getAllByTestId('day-heading')[0].className).toMatch(/\bsticky\b/);
  });

  it('calls the latest days Today and Yesterday', async () => {
    const state = fakeV1State({
      sessions: [
        v1Session({ track: monza, car: ferrari, startedAt: at(1000), endedAt: at(0), lapCount: 1, bestLapMs: 100_000 }),
        v1Session({ track: monza, car: ferrari, startedAt: at(DAY + 1000), endedAt: at(DAY), lapCount: 1, bestLapMs: 100_000 }),
        v1Session({ track: monza, car: ferrari, startedAt: at(5 * DAY), endedAt: at(5 * DAY - 1000), lapCount: 1, bestLapMs: 100_000 }),
      ],
    });
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const headings = screen.getAllByTestId('day-heading');
    expect(headings[0]).toHaveTextContent(/^Today/);
    expect(headings[1]).toHaveTextContent(/^Yesterday/);
    expect(headings[2]).not.toHaveTextContent(/Today|Yesterday/);
  });

  it('is a list of cards, not a table, so a phone has nothing to squeeze', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getAllByRole('list').length).toBeGreaterThan(0);
    expect(within(sessionsShown()[0]).getByTestId('session-laps-metric').closest('dl')!.className).toMatch(/grid-cols-2/);
  });
});

describe('in Portuguese and Spanish', () => {
  it.each([
    ['pt-BR', /quinta-feira, 12 de novembro/i, '2 sessões · 5 voltas', '1 sessão · 1 volta', 'Só voltas válidas', 'Sessões'],
    ['es-ES', /jueves, 12 de noviembre/i, '2 sesiones · 5 vueltas', '1 sesión · 1 vuelta', 'Solo vueltas válidas', 'Sesiones'],
  ])('%s: the day headings, the counts and the filters are translated, and the plural follows the count', async (language, date, two, one, valid, sessionsLabel) => {
    await i18n.changeLanguage(language);
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const headings = screen.getAllByTestId('day-heading');
    expect(headings[0]).toHaveTextContent(date);
    expect(headings[0]).toHaveTextContent(two);
    expect(headings[1]).toHaveTextContent(one);
    expect(screen.getByTestId('session-filters')).toHaveTextContent(valid);
    expect(screen.getByTestId('sum-sessions')).toHaveTextContent(sessionsLabel);
    expect(screen.getByTestId('sessions').textContent).not.toMatch(/sessionsDash\./);
  });
});

describe('against the personal best', () => {
  it('marks the session that holds the personal best with a PB badge, and gives the others their gap to it', async () => {
    const { state, fast, slow, older } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const card = (id: string) => sessionsShown().find((element) => element.closest('a')!.getAttribute('href')!.endsWith(id))!;
    await waitFor(() => expect(within(card(fast.id)).getByTestId('session-pb')).toHaveTextContent('PB'));
    expect(within(card(fast.id)).queryByTestId('session-delta')).not.toBeInTheDocument();
    expect(within(card(slow.id)).queryByTestId('session-pb')).not.toBeInTheDocument();
    expect(within(card(slow.id)).getByTestId('session-delta')).toHaveTextContent('+0.900'); // 1:39.900 against 1:39.000
    expect(within(card(older.id)).getByTestId('session-delta')).toHaveTextContent('+2.000');
  });

  it('says nothing about the personal best for a session with no valid lap', async () => {
    const { state, voided } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const card = sessionsShown().find((element) => element.closest('a')!.getAttribute('href')!.endsWith(voided.id))!;
    await waitFor(() => expect(state.requests.some((request) => request.path === '/pbs')).toBe(true));
    expect(within(card).getByTestId('session-best')).toHaveTextContent('–');
    expect(within(card).queryByTestId('session-pb')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('session-delta')).not.toBeInTheDocument();
  });
});

describe('the laps behind a row', () => {
  it('are read when the row comes into view, for the valid-lap count, the spread and a sparkline of the lap times', async () => {
    seeEverything();
    const { state, fast } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    const card = sessionsShown().find((element) => element.closest('a')!.getAttribute('href')!.endsWith(fast.id))!;
    await waitFor(() => expect(within(card).getByTestId('session-valid')).toHaveTextContent('3 valid'));
    // Two flying laps in the session (the out lap is left out of the line and of the spread): a spread needs a third, so it says nothing, not zero.
    expect(within(card).getByTestId('session-spark')).toHaveAttribute('data-points', '2');
    expect(within(card).getByTestId('session-spread')).toHaveTextContent('–');
    expect(within(card).getByTestId('session-spark')).toHaveAttribute('role', 'img');
    expect(state.requests.some((request) => request.path === `/sessions/${fast.id}`)).toBe(true);
    expect(state.requests.some((request) => request.path.includes('/file'))).toBe(false);
  });

  it('give the spread of a session once it has three clean laps', async () => {
    seeEverything();
    const session = v1Session({ track: monza, car: ferrari, startedAt: '2026-11-12T18:00:00.000Z', lapCount: 4, bestLapMs: 99_000 });
    const laps = [99_000, 100_000, 101_000, 100_500].map((timeMs, i) => v1Lap({ sessionId: session.id, track: monza, car: ferrari, lapNumber: i + 1, timeMs, startedAt: session.startedAt }));
    renderSim(<SessionsList />, { state: fakeV1State({ sessions: [session], laps }) });
    await screen.findAllByTestId('session');
    await waitFor(() => expect(screen.getByTestId('session-spread')).toHaveTextContent('±0.85 s'));
    expect(screen.getByTestId('session-spark')).toHaveAttribute('data-points', '4');
  });

  it('are not read for a row that has not been near the screen', async () => {
    const { state } = seeded(); // no IntersectionObserver here: nothing is ever "in view"
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    expect(screen.queryAllByTestId('session-spark')).toHaveLength(0);
    expect(state.requests.filter((request) => /^\/sessions\/[^/]+$/.test(request.path))).toHaveLength(0);
  });
});

describe('the summary of the filtered set', () => {
  it('counts the sessions, the laps and the time, and names how many tracks and cars are in it', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    expect(screen.getByTestId('sum-sessions-value')).toHaveTextContent('4');
    expect(screen.getByTestId('sum-laps-value')).toHaveTextContent('7');
    expect(screen.getByTestId('sum-time-value')).toHaveTextContent('1h 40m'); // 30 + 20 + 40 + 10 minutes
    expect(screen.getByTestId('sum-pairs-value')).toHaveTextContent('2 · 2');
    expect(screen.queryByTestId('sum-best')).not.toBeInTheDocument();
  });

  it('shows the best lap only when the filters name one track and one car, where lap times can be compared', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state, route: `/virtual/sessions?track=${monza.id}&car=${ferrari.id}` });
    await screen.findAllByTestId('session');
    expect(screen.getByTestId('sum-best-value')).toHaveTextContent('1:39.000');
    expect(screen.getByTestId('sum-sessions-value')).toHaveTextContent('3');
    expect(screen.queryByTestId('sum-pairs')).not.toBeInTheDocument();
  });

  it('follows the filters: it counts what is shown, and says "so far" while more pages are to come', async () => {
    const state = fakeV1State({
      sessions: Array.from({ length: 57 }, (_, i) => v1Session({ track: monza, car: ferrari, startedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), endedAt: new Date(Date.UTC(2026, 10, 1, 0, i + 5)).toISOString(), lapCount: 2, bestLapMs: 100_000 })),
    });
    renderSim(<SessionsList />, { state });
    await waitFor(() => expect(sessionsShown()).toHaveLength(50));
    expect(screen.getByTestId('sum-sessions-value')).toHaveTextContent('50+');
    expect(screen.getByTestId('sum-sessions-sub')).toHaveTextContent('so far');
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(sessionsShown()).toHaveLength(57));
    expect(screen.getByTestId('sum-sessions-value')).toHaveTextContent(/^57$/);
    expect(screen.getByTestId('sum-laps-value')).toHaveTextContent('114');
  });
});

describe('the filters in the address', () => {
  it('keep the kind, the period and "valid laps only" in the address, next to the game, track and car', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?game=lmu' });
    await screen.findAllByTestId('session');
    fireEvent.click(screen.getByTestId('kind-race'));
    expect(search().get('kind')).toBe('race');
    expect(search().get('game')).toBe('lmu'); // the others are kept
    fireEvent.click(screen.getByTestId('period-30d'));
    expect(search().get('period')).toBe('30d');
    fireEvent.click(screen.getByTestId('filter-valid'));
    expect(search().get('valid')).toBe('1');
    fireEvent.click(screen.getByTestId('kind-all'));
    expect(search().get('kind')).toBeNull();
    fireEvent.click(screen.getByTestId('period-all'));
    expect(search().get('period')).toBeNull();
    fireEvent.click(screen.getByTestId('filter-valid'));
    expect(search().get('valid')).toBeNull();
  });

  it('start from the address: the kind is applied, marked in the header and said in a chip', async () => {
    const { state, fast } = seeded();
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?kind=race' });
    await waitFor(() => expect(sessionsShown()).toHaveLength(1));
    expect(sessionsShown()[0].closest('a')).toHaveAttribute('href', `/virtual/sessions/${fast.id}`);
    expect(screen.getByTestId('kind-race')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('kind-all')).toHaveAttribute('aria-checked', 'false');
    expect(within(screen.getByTestId('active-filters')).getByTestId('chip-kind')).toHaveTextContent('Race');
    expect(screen.getByTestId('sum-sessions-value')).toHaveTextContent('1');
  });

  it('move between the choices of a group with the arrow keys', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    fireEvent.keyDown(screen.getByTestId('kind-all'), { key: 'ArrowRight' });
    expect(search().get('kind')).toBe('practice');
    expect(screen.getByTestId('kind-practice')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('kind-practice')).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('kind-all')).toHaveAttribute('tabindex', '-1');
  });

  it('keeps only the sessions of the period, counted back from now', async () => {
    const state = fakeV1State({
      sessions: [
        v1Session({ track: monza, car: ferrari, startedAt: at(2 * DAY), endedAt: at(2 * DAY - 60_000), lapCount: 1, bestLapMs: 100_000 }),
        v1Session({ track: monza, car: ferrari, startedAt: at(20 * DAY), endedAt: at(20 * DAY - 60_000), lapCount: 1, bestLapMs: 100_000 }),
        v1Session({ track: monza, car: ferrari, startedAt: at(100 * DAY), endedAt: at(100 * DAY - 60_000), lapCount: 1, bestLapMs: 100_000 }),
      ],
    });
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?period=7d' });
    await waitFor(() => expect(sessionsShown()).toHaveLength(1));
    fireEvent.click(screen.getByTestId('period-30d'));
    await waitFor(() => expect(sessionsShown()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('period-90d'));
    await waitFor(() => expect(sessionsShown()).toHaveLength(2));
    fireEvent.click(screen.getByTestId('period-1y'));
    await waitFor(() => expect(sessionsShown()).toHaveLength(3));
  });

  it('hides the sessions the game counted no valid lap in when "valid laps only" is on', async () => {
    const { state, voided } = seeded();
    renderSim(<SessionsList />, { state });
    await waitFor(() => expect(sessionsShown()).toHaveLength(4));
    fireEvent.click(screen.getByTestId('filter-valid'));
    await waitFor(() => expect(sessionsShown()).toHaveLength(3));
    expect(sessionsShown().some((card) => card.closest('a')!.getAttribute('href')!.endsWith(voided.id))).toBe(false);
  });

  it('read further pages by themselves until a kind is complete, and say they are looking', async () => {
    const state = fakeV1State({
      // Newest first: 55 practice sessions, then the one race, on a second page.
      sessions: Array.from({ length: 56 }, (_, i) =>
        v1Session({ track: monza, car: ferrari, kind: i === 55 ? 'race' : 'practice', startedAt: new Date(Date.UTC(2026, 10, 1, 0, 60 - i)).toISOString(), lapCount: 1, bestLapMs: 100_000 })),
    });
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?kind=race' });
    await waitFor(() => expect(sessionsShown()).toHaveLength(1));
    expect(state.requests.filter((request) => request.path === '/sessions')).toHaveLength(2); // the second page without a click
    expect(screen.queryByTestId('sessions-no-match')).not.toBeInTheDocument();
  });

  it('say so, with a way out, when nothing in the sessions read matches', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?kind=qualifying&valid=1' });
    expect(await screen.findByTestId('sessions-no-match')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('sessions-no-match')).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(sessionsShown()).toHaveLength(4));
    expect(search().toString()).toBe('');
  });

  it('can be taken off one at a time with their chips, or all at once', async () => {
    const { state } = seeded();
    renderSim(<SessionsList />, { state, route: '/virtual/sessions?kind=practice&valid=1' });
    await screen.findAllByTestId('session');
    fireEvent.click(screen.getByTestId('chip-valid'));
    expect(search().get('valid')).toBeNull();
    expect(search().get('kind')).toBe('practice');
    fireEvent.click(screen.getByTestId('clear-filters'));
    expect(search().toString()).toBe('');
    expect(screen.queryByTestId('active-filters')).not.toBeInTheDocument();
  });
});

describe('keeping the place', () => {
  it('goes back to where the list was scrolled to when the person comes back to it', async () => {
    sessionStorage.setItem('xpeed.sim.sessions.scroll.', '420');
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const { state } = seeded();
    renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 420 }));
  });

  it('saves the place when the list goes away', async () => {
    const { state } = seeded();
    const view = renderSim(<SessionsList />, { state });
    await screen.findAllByTestId('session');
    Object.defineProperty(window, 'scrollY', { value: 310, configurable: true });
    view.unmount();
    expect(sessionStorage.getItem('xpeed.sim.sessions.scroll.')).toBe('310');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('works without it when the browser will not keep it (storage that throws)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key.startsWith('xpeed.sim.sessions')) throw new Error('blocked');
      return null;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string) => {
      if (key.startsWith('xpeed.sim.sessions')) throw new Error('blocked');
    });
    const { state } = seeded();
    const view = renderSim(<SessionsList />, { state });
    expect(await screen.findAllByTestId('session')).toHaveLength(4);
    expect(() => view.unmount()).not.toThrow();
  });
});
