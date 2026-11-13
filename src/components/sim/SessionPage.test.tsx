import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim, whereNow } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { chartRows } from '@/lib/sim/session-stats';
import { SessionPage } from './SessionPage';
import { SessionsList } from './SessionsList';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));
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
const tones = (element: HTMLElement) => within(element).getAllByTestId('lap-sector').map((cell) => cell.getAttribute('data-tone'));

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
  it('shows the session, a chart of the lap times and the table of laps in driving order', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('session-header')).toHaveTextContent('Monza');
    expect(screen.getByTestId('session-header')).toHaveTextContent('Qualifying');
    expect(screen.getByTestId('session-header')).toHaveTextContent('Dry · air 24 °C · track 31 °C');
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
    expect(tones(row(2))).toEqual(['purple', 'green', 'purple']); // S1 and S3 are the session's best; S2 is slower, but this is the personal best lap
    expect(tones(row(4))).toEqual(['yellow', 'purple', 'yellow']);
    expect(tones(row(5))).toEqual(['yellow', 'yellow', 'yellow']);
    expect(tones(row(3))).toEqual(['none', 'none', 'none']); // voided: no colour
    expect(within(row(2)).getAllByTestId('lap-sector').map((cell) => cell.textContent)).toEqual(['29.500', '40.500', '29.500']);
    expect(screen.getByTestId('sector-legend')).toBeInTheDocument();
  });

  it('has no green when the personal best lap is in another session', async () => {
    const { state, sessionId } = seeded();
    const faster = v1Lap({ track: monza, car: ferrari, timeMs: 97_000, sessionId: 'another-session', startedAt: '2026-10-01T12:00:00.000Z' });
    state.laps.push(faster);
    await openSession(state, sessionId);
    expect(tones(row(2))).toEqual(['purple', 'yellow', 'purple']);
    expect(within(row(2)).queryByText('Personal best')).not.toBeInTheDocument();
  });

  it('shows the best sectors and the theoretical best lap, which beats the best lap', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    const best = within(screen.getByTestId('best-sectors')).getAllByRole('cell').map((cell) => cell.textContent).filter(Boolean);
    expect(best).toEqual(['29.500', '39.800', '29.500']);
    expect(screen.getByTestId('theoretical-best')).toHaveTextContent('1:38.800');
    expect(screen.getByTestId('theoretical-best')).toHaveTextContent('-0.700');
  });

  it('shows no sector columns and no theoretical best when the laps have no sectors', async () => {
    const { state, sessionId } = seeded();
    state.laps = state.laps.map((lap) => ({ ...lap, sectorsMs: null }));
    await openSession(state, sessionId);
    expect(screen.queryByTestId('theoretical-best')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('lap-sector')).toHaveLength(0);
    expect(screen.queryByTestId('best-sectors')).not.toBeInTheDocument();
  });

  it('works out the consistency: spread, clean laps and the average of the best 3 (pit laps left out of the first two)', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('spread')).toHaveTextContent('±0.751 s'); // laps 2, 4 and 5
    expect(screen.getByTestId('clean')).toHaveTextContent('75 %'); // 3 of the 4 laps that were not out or in laps
    expect(screen.getByTestId('best-three')).toHaveTextContent('1:40.233');
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
    expect(screen.getByTestId('session-header')).toHaveTextContent('Laps: 5');
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
  it('mark the best lap, the laps the game voided and the out and in laps', () => {
    const { laps } = seeded();
    const rowsOf = chartRows(laps, laps[1].id);
    expect(rowsOf.map((r) => r.kind)).toEqual(['valid', 'best', 'invalid', 'valid', 'valid', 'valid']);
    expect(rowsOf.map((r) => r.pit)).toEqual(['out', null, null, null, null, 'in']);
    expect(rowsOf[1].seconds).toBe(99.5);
  });
});
