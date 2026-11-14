import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { buildInsights } from '@/test/v1-insights';
import { chartRows } from '@/lib/sim/session-stats';
import { SessionPage } from './SessionPage';
import { SessionsList } from './SessionsList';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock);
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

/** One session of six laps: an out lap, a lap the game voided, three flying laps and an in lap. */
function seeded(): { state: FakeV1State; sessionId: string; laps: ReturnType<typeof v1Lap>[] } {
  const session = v1Session({ track: monza, car: ferrari, kind: 'qualifying', weather: 'dry', airTempC: 24, trackTempC: 31, lapCount: 6, bestLapMs: 99_500 });
  const base = { sessionId: session.id, track: monza, car: ferrari };
  const laps = [
    v1Lap({ ...base, lapNumber: 1, timeMs: 112_000, outLap: true, sectorsMs: [33_000, 44_000, 35_000], startedAt: '2026-11-10T12:00:00.000Z' }),
    v1Lap({ ...base, lapNumber: 2, timeMs: 99_500, sectorsMs: [29_500, 40_500, 29_500], startedAt: '2026-11-10T12:02:00.000Z' }),
    v1Lap({ ...base, lapNumber: 3, timeMs: 98_000, valid: false, sectorsMs: [28_000, 39_000, 31_000], startedAt: '2026-11-10T12:04:00.000Z' }),
    v1Lap({ ...base, lapNumber: 4, timeMs: 100_200, sectorsMs: [30_200, 39_800, 30_200], startedAt: '2026-11-10T12:06:00.000Z' }),
    v1Lap({ ...base, lapNumber: 5, timeMs: 101_000, sectorsMs: [30_000, 40_000, 31_000], startedAt: '2026-11-10T12:08:00.000Z' }),
    v1Lap({ ...base, lapNumber: 6, timeMs: 108_000, inLap: true, sectorsMs: [31_000, 41_000, 36_000], startedAt: '2026-11-10T12:10:00.000Z' }),
  ];
  return { state: fakeV1State({ sessions: [session], laps }), sessionId: session.id, laps };
}

function renderSession(state: FakeV1State, sessionId: string) {
  return renderSim(
    <Routes>
      <Route path="/virtual/sessions" element={<SessionsList />} />
      <Route path="/virtual/sessions/:id" element={<SessionPage />} />
    </Routes>,
    { state, route: `/virtual/sessions/${sessionId}` },
  );
}
/** Renders the page and waits until the session and the personal best have both been read. */
async function openSession(state: FakeV1State, sessionId: string) {
  const view = renderSession(state, sessionId);
  await screen.findByTestId('session-header');
  await waitFor(() => expect(state.requests.some((request) => request.path === '/pbs')).toBe(true));
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  return view;
}
const rows = () => screen.getAllByTestId('session-lap');
const row = (n: number) => rows()[n - 1];
const sectorRows = () => screen.getAllByTestId('sector-row');
const sectorRow = (n: number) => sectorRows()[n - 1];
const tones = (element: HTMLElement) => within(element).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-tone'));
const heats = (element: HTMLElement) => within(element).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-heat'));
const lapOrder = () => rows().map((r) => r.querySelector('td')!.textContent);

let idb: FakeIdb;
beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the session page', () => {
  it('links the track and the car to their pages', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('session-track-link')).toHaveAttribute('href', `/virtual/tracks/${monza.id}`);
    expect(screen.getByTestId('session-car-link')).toHaveAttribute('href', `/virtual/cars/${ferrari.id}`);
  });

  it('opens with a hero: the track, car, kind, game, date, how many laps and the conditions the game gave, as chips', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const header = screen.getByTestId('session-header');
    expect(header).toHaveTextContent('Monza');
    expect(within(header).getByTestId('session-kind')).toHaveTextContent('Qualifying');
    expect(within(header).getByTestId('session-game')).toHaveTextContent('Le Mans Ultimate');
    expect(within(header).getByTestId('fact-laps')).toHaveTextContent('6 laps');
    expect(within(header).getByTestId('fact-weather')).toHaveTextContent('Dry');
    expect(within(header).getByTestId('fact-air')).toHaveTextContent('air 24 °C');
    expect(within(header).getByTestId('fact-track')).toHaveTextContent('track 31 °C');
    expect(within(header).getByTestId('fact-origin')).toHaveTextContent('From Xpeed Companion');
    expect(within(header).getByRole('button', { name: 'Delete session' })).toBeInTheDocument();
  });

  it('leaves out the chips of what the game did not say', async () => {
    const { state, sessionId } = seeded();
    state.sessions[0] = { ...state.sessions[0], weather: null, airTempC: null, trackTempC: null };
    await openSession(state, sessionId);
    expect(screen.queryByTestId('fact-weather')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fact-air')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fact-track')).not.toBeInTheDocument();
  });

  it('shows the session, a chart of the lap times and the table of laps in driving order', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('session-best')).toHaveTextContent('1:39.500');

    expect(screen.getByTestId('chart')).toHaveAttribute('data-points', '6');
    expect(screen.getByTestId('chart-legend')).toHaveTextContent('Valid lap');
    expect(screen.getByTestId('chart-legend')).toHaveTextContent('Out or in lap');

    expect(rows()).toHaveLength(6);
    expect(rows().map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(within(row(2)).getAllByRole('cell')[1]).toHaveTextContent('1:39.500');
  });

  it('shows the gap to the session best lap, for valid laps only', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const gap = (n: number) => within(row(n)).getByTestId('lap-gap').textContent;
    expect(gap(2)).toBe('–'); // the best lap
    expect(gap(3)).toBe('–'); // voided by the game
    expect(gap(4)).toBe('+0.700');
    expect(gap(5)).toBe('+1.500');
  });

  it('colours the sector times: purple for the session best, green for the personal best lap, yellow for slower', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    // The personal best of this track and car is lap 2 (the fastest valid lap on the account).
    expect(tones(sectorRow(2))).toEqual(['purple', 'green', 'purple']); // S1 and S3 are the session's best; S2 is slower, but this is the personal best lap
    expect(tones(sectorRow(4))).toEqual(['yellow', 'purple', 'yellow']);
    expect(tones(sectorRow(5))).toEqual(['yellow', 'yellow', 'yellow']);
    expect(tones(sectorRow(3))).toEqual(['none', 'none', 'none']); // voided: no colour
    expect(within(sectorRow(2)).getAllByTestId('lap-sector').map((cell) => cell.firstChild?.textContent)).toEqual(['29.500', '40.500', '29.500']);
    expect(screen.getByTestId('sector-legend')).toBeInTheDocument();
  });

  it('shades each sector time by how far it is from the best of the session in that sector (the pit laps and the voided lap are left uncoloured)', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    // The flying laps are 2, 4 and 5. S1: best 29.500, laps 4 and 5 are 0.700 and 0.500 over (the scale is 0.700). S2: best 39.800. S3: best 29.500, scale 1.500.
    expect(heats(sectorRow(2))).toEqual(['0', '4', '0']);
    expect(heats(sectorRow(4))).toEqual(['4', '0', '2']);
    expect(heats(sectorRow(5))).toEqual(['3', '2', '4']);
    expect(heats(sectorRow(1))).toEqual([null, null, null].map(() => null)); // an out lap
    expect(within(sectorRow(1)).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-kind'))).toEqual(['pit', 'pit', 'pit']);
    expect(within(sectorRow(6)).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-kind'))).toEqual(['pit', 'pit', 'pit']); // an in lap
    expect(within(sectorRow(3)).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-kind'))).toEqual(['none', 'none', 'none']); // voided
    // The gap is written under the time: the colour is never the only cue.
    expect(within(sectorRow(4)).getAllByTestId('sector-delta')[0]).toHaveTextContent('+0.700');
  });

  it('has no green when the personal best lap is in another session', async () => {
    const { state, sessionId } = seeded();
    const faster = v1Lap({ track: monza, car: ferrari, timeMs: 97_000, sessionId: 'another-session', startedAt: '2026-10-01T12:00:00.000Z' });
    state.laps.push(faster);
    await openSession(state, sessionId);
    expect(tones(sectorRow(2))).toEqual(['purple', 'yellow', 'purple']);
    expect(within(row(2)).queryByText('Personal best')).not.toBeInTheDocument();
  });

  it('shows the best sectors with the lap that holds each, and the theoretical best lap, which beats the best lap', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const best = within(screen.getByTestId('best-sectors')).getAllByTestId('best-sector');
    expect(best.map((cell) => cell.firstChild?.textContent)).toEqual(['29.500', '39.800', '29.500']);
    expect(best.map((cell) => cell.textContent)).toEqual(['29.500lap 2', '39.800lap 4', '29.500lap 2']);
    expect(screen.getByTestId('theoretical-best')).toHaveTextContent('1:38.800');
    expect(screen.getByTestId('theoretical-gain')).toHaveTextContent('0.700 s faster than the best lap');
  });

  it('shows no sector table and no theoretical best when the laps have no sectors', async () => {
    const { state, sessionId } = seeded();
    state.laps = state.laps.map((lap) => ({ ...lap, sectorsMs: null }));
    await openSession(state, sessionId);
    expect(screen.queryByTestId('theoretical-best')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sector-heat')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('lap-sector')).toHaveLength(0);
    expect(screen.queryByTestId('best-sectors')).not.toBeInTheDocument();
  });

  it('works out the tiles: average, spread, valid and clean laps, best 3 (pit laps left out of the average and the spread)', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('kpi-average-value')).toHaveTextContent('1:40.233'); // laps 2, 4 and 5
    expect(screen.getByTestId('spread')).toHaveTextContent('±0.751 s');
    expect(screen.getByTestId('kpi-valid-value')).toHaveTextContent('83 %'); // 5 of the 6 laps have a valid time
    expect(screen.getByTestId('kpi-valid-sub')).toHaveTextContent('5 of 6');
    expect(screen.getByTestId('clean')).toHaveTextContent('75 %'); // 3 of the 4 laps that were not out or in laps
    expect(screen.getByTestId('best-three')).toHaveTextContent('1:40.233');
    // A tile whose number the laps do not carry is not there.
    expect(screen.queryByTestId('kpi-topspeed')).not.toBeInTheDocument();
    expect(screen.queryByTestId('kpi-fuel')).not.toBeInTheDocument();
  });

  it('says how the best lap stands against the personal best: it is it, or this far from it', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('session-best-sub')).toHaveTextContent('your personal best');
    cleanup();

    const other = seeded();
    other.state.laps.push(v1Lap({ track: monza, car: ferrari, timeMs: 98_800, sessionId: 'another-session', startedAt: '2026-10-01T12:00:00.000Z' }));
    await openSession(other.state, other.sessionId);
    expect(screen.getByTestId('session-best-sub')).toHaveTextContent('+0.700 s from your personal best');
  });

  it('shows the top speed (in the unit chosen) and the fuel a lap used, when the laps carry them', async () => {
    localStorage.setItem('settings_distanceUnit', 'mi');
    const { state, sessionId } = seeded();
    state.laps = state.laps.map((lap) => ({ ...lap, topSpeedKmh: lap.lapNumber === 2 ? 320 : 300, fuelUsedL: lap.outLap ? 5 : 2 })); // the out lap's fuel is left out
    await openSession(state, sessionId);
    expect(screen.getByTestId('kpi-topspeed-value')).toHaveTextContent('199 mph');
    expect(screen.getByTestId('kpi-fuel-value')).toHaveTextContent(/0\.53 gal/); // 2 L, in the gallons that miles come with
  });

  it('tags the out lap, the in lap, the voided lap, the best lap and the personal best', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const tags = (n: number) => within(row(n)).getByTestId('lap-tags').textContent;
    expect(tags(1)).toBe('Out lap');
    expect(tags(6)).toBe('In lap');
    expect(tags(3)).toBe('not valid');
    expect(tags(2)).toContain('Best lap');
    expect(tags(2)).toContain('Personal best');
    expect(tags(4)).toBe('');
  });

  it('opens the analysis, and the two comparisons, with the ids the server gave the laps', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    const [, best, , four] = laps;
    expect(within(row(4)).getByRole('link', { name: /Analyze 4/ })).toHaveAttribute('href', `/virtual/compare?a=${four.id}`);

    fireEvent.click(within(row(4)).getByRole('button', { name: 'Compare with my best' }));
    const where = whereNow(screen.getByTestId('where'));
    expect(where.pathname).toBe('/virtual/compare');
    expect([where.searchParams.get('a'), where.searchParams.get('b')]).toEqual([four.id, best.id]); // lap 2 is the personal best
  });

  it('compares with the session best too, and never a lap with itself', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    expect(within(row(2)).getByRole('button', { name: 'Compare with the session best' })).toBeDisabled();
    expect(within(row(2)).getByRole('button', { name: 'Compare with my best' })).toBeDisabled();
    fireEvent.click(within(row(5)).getByRole('button', { name: 'Compare with the session best' }));
    const where = whereNow(screen.getByTestId('where'));
    expect([where.searchParams.get('a'), where.searchParams.get('b')]).toEqual([laps[4].id, laps[1].id]);
  });

  it('says so when the session is not in the account any more', async () => {
    renderSession(fakeV1State(), '00000000-0000-4000-8000-0000000000ff');
    expect(await screen.findByTestId('session-not-found')).toHaveTextContent('not in your account any more');
  });

  it('shows a skeleton of the page while the session is on its way, then the page', async () => {
    const { state, sessionId } = seeded();
    state.delayMs = 40;
    renderSession(state, sessionId);
    expect(screen.getByTestId('session-skeleton')).toBeInTheDocument();
    expect(await screen.findByTestId('session-header')).toBeInTheDocument();
    expect(screen.queryByTestId('session-skeleton')).not.toBeInTheDocument();
  });

  it('says the server is not answering, and tries again', async () => {
    const { state, sessionId } = seeded();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSession(state, sessionId);
    const error = await screen.findByTestId('sim-error');
    expect(error).toHaveTextContent('could not be loaded');
    state.failing = null;
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('session-header')).toBeInTheDocument();
  });

  it('is whole for an account with one lap the game voided: the tiles say what they cannot, the chart and the table still show it', async () => {
    const session = v1Session({ track: monza, car: ferrari, lapCount: 1, bestLapMs: null });
    const only = v1Lap({ sessionId: session.id, track: monza, car: ferrari, lapNumber: 1, timeMs: 154_252, valid: false, outLap: true });
    const state = fakeV1State({ sessions: [session], laps: [only] });
    await openSession(state, session.id);
    expect(screen.getByTestId('session-best-value')).toHaveTextContent('–');
    expect(screen.getByTestId('session-best-sub')).toHaveTextContent('no valid lap');
    expect(screen.getByTestId('kpi-average-value')).toHaveTextContent('–');
    expect(screen.getByTestId('spread')).toHaveTextContent('–');
    expect(screen.getByTestId('kpi-valid-value')).toHaveTextContent('0 %');
    expect(screen.getByTestId('chart')).toHaveAttribute('data-points', '1');
    expect(screen.getByTestId('session-chart-plot')).toHaveAttribute('aria-label', expect.stringContaining('is not valid'));
    expect(screen.queryByTestId('sector-heat')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(within(row(1)).getByTestId('lap-tags')).toHaveTextContent('Out lap');
    expect(within(row(1)).getByTestId('lap-tags')).toHaveTextContent('not valid');
  });
});

describe('in Portuguese and Spanish', () => {
  it.each([
    ['pt-BR', '6 voltas', 'Melhor volta', 'Tendência: ficando mais lento', 'O que se destacou', 'Setores'],
    ['es-ES', '6 vueltas', 'Mejor vuelta', 'Tendencia: cada vez más lento', 'Qué destacó', 'Sectores'],
  ])('%s: the hero, the tiles, the chart, the sectors and the findings are translated, and the plural follows the count', async (language, laps, best, trend, stood, sectors) => {
    await i18n.changeLanguage(language);
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('fact-laps')).toHaveTextContent(laps);
    expect(screen.getByTestId('session-best')).toHaveTextContent(best);
    expect(screen.getByTestId('chart-legend')).toHaveTextContent(trend);
    expect(screen.getByTestId('sector-heat')).toHaveTextContent(sectors);
    expect(await screen.findByTestId('stood-out')).toHaveTextContent(stood);
    expect(screen.getByTestId('session-chart-plot').getAttribute('aria-label')).toMatch(/6 (voltas|vueltas)/);
    // No key is shown as a key: every sentence of this page has its translation.
    expect(screen.getByTestId('session-page').textContent).not.toMatch(/sessionsDash\./);
  });
});

describe('the lap chart', () => {
  it('has a bar for each lap, marked as the best, valid, voided or a pit lap, and says it in words for a screen reader', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const bars = screen.getAllByTestId('bar');
    expect(bars.map((bar) => bar.getAttribute('data-kind'))).toEqual(['valid', 'best', 'invalid', 'valid', 'valid', 'valid']);
    expect(bars.map((bar) => bar.getAttribute('data-pit'))).toEqual(['out', null, null, null, null, 'in']);
    const plot = screen.getByTestId('session-chart-plot');
    expect(plot).toHaveAttribute('role', 'img');
    expect(plot.getAttribute('aria-label')).toContain('6 laps; the best is lap 2 in 1:39.500; the slowest flying lap is 1:41.000');
  });

  it('opens the analysis of a lap when its bar is clicked', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(screen.getAllByTestId('bar')[3]);
    const where = whereNow(screen.getByTestId('where'));
    expect(where.pathname).toBe('/virtual/compare');
    expect(where.searchParams.get('a')).toBe(laps[3].id);
    expect(where.searchParams.get('b')).toBeNull();
  });

  it('draws a trend through the flying laps, and says which way it points', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('chart-legend')).toHaveTextContent('Trend: getting slower'); // 99.5, 100.2, 101.0 s
  });

  it('draws no trend under three flying laps', async () => {
    const { state, sessionId } = seeded();
    state.laps = state.laps.filter((lap) => lap.lapNumber !== 5);
    await openSession(state, sessionId);
    expect(screen.getByTestId('chart-legend')).not.toHaveTextContent('Trend');
  });
});

describe('the laps table', () => {
  it('starts in driving order and sorts by time, with the laps the game voided after the valid ones, and back', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(lapOrder()).toEqual(['1', '2', '3', '4', '5', '6']);
    const header = (key: string) => screen.getByTestId(`sort-${key}`).closest('th')!;
    expect(header('lap')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('time')).toHaveAttribute('aria-sort', 'none');

    fireEvent.click(screen.getByTestId('sort-time'));
    expect(header('time')).toHaveAttribute('aria-sort', 'ascending');
    expect(header('lap')).toHaveAttribute('aria-sort', 'none');
    expect(lapOrder()).toEqual(['2', '4', '5', '6', '1', '3']); // 1:39.5, 1:40.2, 1:41.0, 1:48.0, 1:52.0, then the voided 1:38.0
    fireEvent.click(screen.getByTestId('sort-time'));
    expect(header('time')).toHaveAttribute('aria-sort', 'descending');
    expect(lapOrder()).toEqual(['1', '6', '5', '4', '2', '3']);

    fireEvent.click(screen.getByTestId('sort-lap'));
    expect(lapOrder()).toEqual(['1', '2', '3', '4', '5', '6']);
    fireEvent.click(screen.getByTestId('sort-lap'));
    expect(lapOrder()).toEqual(['6', '5', '4', '3', '2', '1']);
  });

  it('sorts by the gap to the best lap, the same order as the time', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(screen.getByTestId('sort-gap'));
    expect(screen.getByTestId('sort-gap').closest('th')).toHaveAttribute('aria-sort', 'ascending');
    expect(lapOrder()).toEqual(['2', '4', '5', '6', '1', '3']);
  });

  it('keeps each lap with its own actions after sorting', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(screen.getByTestId('sort-time'));
    expect(rows()[1].getAttribute('data-lap-id')).toBe(laps[3].id);
    expect(within(rows()[1]).getByRole('link', { name: /Analyze 4/ })).toHaveAttribute('href', `/virtual/compare?a=${laps[3].id}`);
  });
});

describe('what stood out', () => {
  it('says what the server found, and what the laps on screen say', async () => {
    const { state, sessionId, laps } = seeded();
    state.insights.set(sessionId, buildInsights(sessionId, laps));
    await openSession(state, sessionId);
    const card = await screen.findByTestId('stood-out');
    await waitFor(() => expect(within(card).getAllByTestId('stood-sentence').length).toBe(4));
    const sentences = within(card).getAllByTestId('stood-sentence');
    expect(sentences.map((sentence) => sentence.getAttribute('data-kind'))).toEqual(['sectorGain', 'sectorSpread', 'theoretical', 'voided']);
    expect(sentences[0]).toHaveTextContent('Your best lap loses most in sector 2: it is 0.70 s slower than your best time there in this session.');
    expect(sentences[1]).toHaveTextContent('You vary most in sector 3');
    expect(sentences[2]).toHaveTextContent('0.700 s faster than your best lap');
    expect(sentences[3]).toHaveTextContent('The game voided 1 lap, so it does not count.');
    expect(state.requests.some((request) => request.path === `/sessions/${sessionId}/insights`)).toBe(true);
  });

  it('still says what the laps say when the server cannot (an older server: the insights are a 404)', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const card = await screen.findByTestId('stood-out');
    await waitFor(() => expect(within(card).queryByTestId('stood-loading')).not.toBeInTheDocument());
    expect(within(card).getAllByTestId('stood-sentence').map((sentence) => sentence.getAttribute('data-kind'))).toEqual(['theoretical', 'voided']);
  });

  it('is not there when there is nothing to say', async () => {
    const session = v1Session({ track: monza, car: ferrari, lapCount: 2, bestLapMs: 99_000 });
    const base = { sessionId: session.id, track: monza, car: ferrari };
    const state = fakeV1State({ sessions: [session], laps: [v1Lap({ ...base, lapNumber: 1, timeMs: 99_000 }), v1Lap({ ...base, lapNumber: 2, timeMs: 99_100 })] });
    await openSession(state, session.id);
    await waitFor(() => expect(screen.queryByTestId('stood-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('stood-out')).not.toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('asks first, and deletes nothing until the person confirms', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The 6 laps of this session are deleted from your account');
    expect(state.requests.some((request) => request.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(state.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect(state.laps).toHaveLength(6);
  });

  it('deletes the laps of the session from the account, and the session is gone from the list', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(whereNow(screen.getByTestId('where')).pathname).toBe('/virtual/sessions'));
    const deleted = state.requests.filter((request) => request.method === 'DELETE').map((request) => request.path).sort();
    expect(deleted).toEqual(laps.map((lap) => `/laps/${lap.id}`).sort());
    expect(state.laps).toHaveLength(0);
    // The list is read again: no session left, so the invitation shows, not the old card.
    expect(await screen.findByTestId('sessions-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('session')).not.toBeInTheDocument();
  });

  it('deletes one lap after asking, and the table loses that row while the session stays', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    fireEvent.click(within(row(5)).getByRole('button', { name: /Delete lap 5/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Lap 5 is deleted from your account');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(state.requests.filter((request) => request.method === 'DELETE').map((request) => request.path)).toEqual([`/laps/${laps[4].id}`]);
    expect(whereNow(screen.getByTestId('where')).pathname).toBe(`/virtual/sessions/${sessionId}`);
    expect(screen.getByTestId('session-header')).toHaveTextContent('5 laps');
  });

  it('says when some laps could not be deleted, and stays on the page', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByTestId('session-problem')).toHaveTextContent('6 laps could not be deleted');
    expect(whereNow(screen.getByTestId('where')).pathname).toBe(`/virtual/sessions/${sessionId}`);
  });
});

describe('the chart rows', () => {
  it('mark the best lap, the laps the game voided and the out and in laps, and carry the id of each lap', () => {
    const { laps } = seeded();
    const rowsOf = chartRows(laps, laps[1].id);
    expect(rowsOf.map((r) => r.kind)).toEqual(['valid', 'best', 'invalid', 'valid', 'valid', 'valid']);
    expect(rowsOf.map((r) => r.pit)).toEqual(['out', null, null, null, null, 'in']);
    expect(rowsOf.map((r) => r.id)).toEqual(laps.map((lap) => lap.id));
    expect(rowsOf[1].seconds).toBe(99.5);
  });
});
