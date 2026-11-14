import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chooseOption, waitForOptions } from '@/test/select';
import type { V1CarItem, V1TrackItem } from '@/lib/sim/v1-client';
import { SessionsList } from './SessionsList';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
let token: string | null = 'token';
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => token }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');
const porsche = ref('Porsche 963');

const trackItem = (track: { id: string; name: string }, game = 'lmu'): V1TrackItem => ({ id: track.id, game, name: track.name, lengthM: 5793, lapCount: 5, validLapCount: 4, sessionCount: 1, carCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' });
const carItem = (car: { id: string; name: string }, game = 'lmu'): V1CarItem => ({ id: car.id, game, name: car.name, brand: null, class: null, lapCount: 5, validLapCount: 4, sessionCount: 1, trackCount: 1, bestLapMs: 100_000, lastDrivenAt: '2026-11-10T12:00:00.000Z' });

function seeded(): FakeV1State {
  const race = v1Session({ track: monza, car: ferrari, kind: 'race', startedAt: '2026-11-12T18:00:00.000Z', weather: 'rain', airTempC: 18, trackTempC: 22, origin: 'companion', lapCount: 12, bestLapMs: 99_480 });
  const practice = v1Session({ game: 'ac', track: spa, car: porsche, kind: 'practice', startedAt: '2026-11-11T10:00:00.000Z', origin: 'inferred', lapCount: 3, bestLapMs: null });
  return fakeV1State({
    sessions: [race, practice],
    laps: [v1Lap({ sessionId: race.id, track: monza, car: ferrari }), v1Lap({ game: 'ac', sessionId: practice.id, track: spa, car: porsche })],
    tracks: [trackItem(monza), trackItem(spa, 'ac')],
    cars: [carItem(ferrari), carItem(porsche, 'ac')],
  });
}

beforeEach(async () => {
  localStorage.clear();
  token = 'token';
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the list', () => {
  it('shows each session with its track, car, game, date, kind, weather, laps, best lap and origin, and reads no lap file', async () => {
    const { state } = renderSim(<SessionsList />, { state: seeded() });
    const cards = await screen.findAllByTestId('session');
    expect(cards).toHaveLength(2);

    const race = within(cards[0]);
    expect(race.getByText('Monza')).toBeInTheDocument();
    expect(race.getByTestId('sim-car-identity')).toHaveTextContent('Ferrari 499P');
    expect(race.getByTestId('session-game')).toHaveTextContent('Le Mans Ultimate');
    expect(race.getByTestId('session-kind')).toHaveTextContent('Race');
    expect(race.getByTestId('session-conditions')).toHaveTextContent('Rain · air 18 °C · track 22 °C');
    expect(race.getByTestId('session-lap-count')).toHaveTextContent('12');
    expect(race.getByTestId('session-best')).toHaveTextContent('1:39.480');
    expect(race.getByTestId('session-origin')).toHaveTextContent('From Xpeed Companion');

    const practice = within(cards[1]);
    expect(practice.getByTestId('session-game')).toHaveTextContent('Assetto Corsa');
    expect(practice.getByTestId('session-kind')).toHaveTextContent('Practice');
    expect(practice.getByTestId('session-best')).toHaveTextContent('–'); // no valid lap
    expect(practice.getByTestId('session-origin')).toHaveTextContent('Grouped by Xpeed');
    expect(practice.queryByTestId('session-conditions')).not.toBeInTheDocument();

    // A session is a link to its page.
    expect(screen.getAllByTestId('session-link')[0]).toHaveAttribute('href', `/virtual/sessions/${state.sessions[0].id}`);
    // Only the lists were read: no lap file, not even the laps of a session (a row reads them only when it is about to be seen).
    expect(state.requests.some((request) => request.path.includes('/file') || request.path === '/laps' || /^\/sessions\/[^/]+$/.test(request.path))).toBe(false);
  });

  it('shows the temperatures in Fahrenheit when that is the unit chosen', async () => {
    localStorage.setItem('settings_temperatureUnit', 'F');
    renderSim(<SessionsList />, { state: seeded() });
    expect(await screen.findAllByTestId('session')).toHaveLength(2);
    expect(screen.getAllByTestId('session-conditions')[0]).toHaveTextContent('air 64 °F · track 72 °F');
  });

  it('pages with a "Load more" button, a page at a time', async () => {
    const state = seeded();
    state.sessions = Array.from({ length: 57 }, (_, i) => v1Session({ track: monza, car: ferrari, startedAt: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(), lapCount: 1 }));
    renderSim(<SessionsList />, { state });
    await waitFor(() => expect(screen.getAllByTestId('session')).toHaveLength(50));
    fireEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(screen.getAllByTestId('session')).toHaveLength(57));
    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument();
    expect(state.requests.filter((request) => request.path === '/sessions')[1].params.cursor).toBeTruthy();
  });

  it('shows a skeleton while the first page is on its way', async () => {
    const state = seeded();
    state.delayMs = 40;
    renderSim(<SessionsList />, { state });
    expect(screen.getByTestId('sim-skeleton')).toBeInTheDocument();
    expect(await screen.findAllByTestId('session')).toHaveLength(2);
    expect(screen.queryByTestId('sim-skeleton')).not.toBeInTheDocument();
  });
});

describe('the filters', () => {
  it('send game, track and car to the server and are kept in the address', async () => {
    const { state } = renderSim(<SessionsList />, { state: seeded() });
    await screen.findAllByTestId('session');
    // The games come from the overview.
    await waitForOptions(() => screen.getByTestId('filter-game'), (labels) => labels.length > 1);

    chooseOption(screen.getByTestId('filter-game'), 'Le Mans Ultimate');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/sessions' && request.params.game === 'lmu')).toBe(true));
    expect(whereNow(screen.getByTestId('where')).searchParams.get('game')).toBe('lmu');
    await waitFor(() => expect(screen.getAllByTestId('session')).toHaveLength(1));
    // The track and car lists are those of the game.
    await waitForOptions(() => screen.getByTestId('filter-track'), (labels) => labels.join('|') === 'All|Monza');

    chooseOption(screen.getByTestId('filter-track'), 'Monza');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/sessions' && request.params.track === monza.id && request.params.game === 'lmu')).toBe(true));
    await waitForOptions(() => screen.getByTestId('filter-car'), (labels) => labels.length === 2);
    chooseOption(screen.getByTestId('filter-car'), 'Ferrari 499P');
    await waitFor(() => expect(state.requests.some((request) => request.path === '/sessions' && request.params.car === ferrari.id)).toBe(true));
    const address = whereNow(screen.getByTestId('where')).searchParams;
    expect([address.get('game'), address.get('track'), address.get('car')]).toEqual(['lmu', monza.id, ferrari.id]);

    // Another game starts the track and the car over.
    chooseOption(screen.getByTestId('filter-game'), 'Assetto Corsa');
    await waitFor(() => expect(whereNow(screen.getByTestId('where')).searchParams.get('track')).toBeNull());
    expect(whereNow(screen.getByTestId('where')).searchParams.get('car')).toBeNull();
  });

  it('start from the address, and say so when nothing matches', async () => {
    const { state } = renderSim(<SessionsList />, { state: seeded(), route: `/virtual/sessions?game=lmu&track=${spa.id}` });
    expect(await screen.findByTestId('sessions-no-match')).toHaveTextContent('No session matches these filters.');
    expect(state.requests.find((request) => request.path === '/sessions')!.params).toMatchObject({ game: 'lmu', track: spa.id });
    fireEvent.click(within(screen.getByTestId('sessions-no-match')).getByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(screen.getAllByTestId('session')).toHaveLength(2));
  });
});

describe('the honest states', () => {
  it('invites to install and connect Xpeed Companion when there is nothing yet (and offers no way to add a lap by hand)', async () => {
    const { container } = renderSim(<SessionsList />);
    const empty = await screen.findByTestId('sessions-empty');
    expect(empty).toHaveTextContent('Install Xpeed Companion');
    expect(within(empty).getByRole('link', { name: 'Get Xpeed Companion' })).toHaveAttribute('href', '/companion');
    expect(within(empty).getByRole('link', { name: 'Connect it to your account' })).toHaveAttribute('href', '/virtual/companion');
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByTestId('sim-error')).not.toBeInTheDocument();
  });

  it('says the server is not answering, which is not the same as having no laps, and retries', async () => {
    const state = seeded();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSim(<SessionsList />, { state });
    const error = await screen.findByTestId('sim-error');
    expect(error).toHaveTextContent('could not be loaded');
    expect(screen.queryByTestId('sessions-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session')).not.toBeInTheDocument();

    state.failing = null;
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('session')).toHaveLength(2);
    expect(screen.queryByTestId('sim-error')).not.toBeInTheDocument();
  });

  it('says signed out, with a way to sign in and no retry, when the server says 401', async () => {
    token = null;
    renderSim(<SessionsList />, { state: seeded() });
    const error = await screen.findByTestId('sim-error');
    expect(error).toHaveTextContent('You are signed out');
    expect(within(error).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(within(error).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps the sessions on screen, with a "showing saved data" badge and its age, when a later read fails; retry brings the badge down', async () => {
    const state = seeded();
    const { client } = renderSim(<SessionsList />, { state });
    expect(await screen.findAllByTestId('session')).toHaveLength(2);

    state.failing = { status: 503, error: 'unavailable', retryable: true };
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['sim-v1'] });
    });
    const badge = await screen.findByTestId('sim-stale');
    expect(badge).toHaveTextContent('Showing saved data');
    expect(badge).toHaveTextContent(/Last updated .*\./); // the cache age
    expect(screen.getAllByTestId('session')).toHaveLength(2); // still there
    expect(screen.queryByTestId('sim-error')).not.toBeInTheDocument();

    state.failing = null;
    fireEvent.click(within(badge).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByTestId('sim-stale')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('session')).toHaveLength(2);
  });
});
