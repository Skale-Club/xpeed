import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { gzipLap } from '@/lib/sim/lap-file';
import { buildSyntheticLap, exampleCorners } from '@/lib/sim/synthetic-lap';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim } from '@/test/sim-render';
import type { V1SessionInsights } from '@/lib/sim/v1-client';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { SimOverview } from './SimOverview';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
// The real charts need a layout engine; the numbers they are given are tested with the dashboard.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  LineChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Bar: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

const monza = ref('Monza');
const spa = ref('Spa-Francorchamps');
const ferrari = ref('Ferrari 499P');

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

/** A session of `count` laps on Monza, `voided` of them voided by the game, each with a real lap file whose hairpin brake point moves. */
async function sessionWithLaps(state: FakeV1State, count: number, voided = 0, extra: { startedAt?: string; track?: typeof monza } = {}) {
  const track = extra.track ?? monza;
  const session = v1Session({ track, car: ferrari, kind: 'race', startedAt: extra.startedAt ?? '2026-11-12T18:00:00.000Z', lapCount: count, bestLapMs: 90_000 });
  state.sessions.push(session);
  for (let i = 0; i < count; i++) {
    const shift = [0, 7, -6, 4, 9, -3, 2, -8][i % 8];
    const built = buildSyntheticLap({
      lengthM: 4200, hz: 10, lapNumber: i + 1, valid: i >= voided, trackName: track.name, car: ferrari.name,
      corners: exampleCorners().map((corner, k) => (k === 1 ? { ...corner, brakeDist: corner.brakeDist + shift } : corner)),
    }).lap;
    const lap = v1Lap({ track, car: ferrari, sessionId: session.id, lapNumber: i + 1, timeMs: built.header.lap.timeMs, valid: i >= voided, startedAt: new Date(Date.parse(session.startedAt) + i * 100_000).toISOString() });
    state.laps.push(lap);
    state.files.set(lap.id, await gzipLap(built));
  }
  return session;
}

const lapFileRequests = (state: FakeV1State) => state.requests.filter((request) => request.path.endsWith('/file'));

describe('the Overview cards', () => {
  it('shows the personal bests, the latest sessions with their badges and the games with their lap counts', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z', devices: [{ id: 'd1', name: 'Racing PC', pairedAt: '2026-11-01T00:00:00.000Z', lastSeenAt: '2026-11-13T09:00:00.000Z', lastLapAt: null }] });
    const race = v1Session({ track: monza, car: ferrari, kind: 'race', lapCount: 2, bestLapMs: 99_000, startedAt: '2026-11-12T10:00:00.000Z' });
    const practice = v1Session({ track: spa, car: ferrari, kind: 'practice', game: 'ac', lapCount: 1, bestLapMs: 135_000, startedAt: '2026-11-11T10:00:00.000Z' });
    state.sessions.push(race, practice);
    const fast = v1Lap({ track: monza, car: ferrari, sessionId: race.id, timeMs: 99_000, startedAt: '2026-11-12T10:02:00.000Z', createdAt: '2026-11-12T10:05:00.000Z' });
    const slow = v1Lap({ track: monza, car: ferrari, sessionId: race.id, timeMs: 101_000, startedAt: '2026-11-12T10:00:00.000Z' });
    const other = v1Lap({ track: spa, car: ferrari, game: 'ac', sessionId: practice.id, timeMs: 135_000, startedAt: '2026-11-11T10:00:00.000Z' });
    state.laps.push(fast, slow, other);
    renderSim(<SimOverview />, { state, route: '/virtual' });

    // Personal bests: the time, a link to the lap analysis and, when the lap beat an earlier best, by how much.
    await screen.findByTestId('overview-best');
    const bests = screen.getAllByTestId('overview-best-lap');
    expect(bests).toHaveLength(2);
    const monzaBest = bests.find((item) => item.textContent?.includes('Monza'))!;
    expect(within(monzaBest).getByTestId('overview-best-time')).toHaveTextContent('1:39.000');
    expect(within(monzaBest).getByRole('link')).toHaveAttribute('href', `/virtual/compare?a=${fast.id}`);
    expect(within(monzaBest).getByTestId('overview-best-gain')).toHaveTextContent('2.000 s faster than your previous best');
    const spaBest = bests.find((item) => item.textContent?.includes('Spa'))!;
    expect(within(spaBest).queryByTestId('overview-best-gain')).not.toBeInTheDocument();

    // Latest sessions, with the badges of the Sessions page, in a table.
    const sessions = screen.getAllByTestId('overview-session');
    expect(sessions).toHaveLength(2);
    expect(within(sessions[0]).getByTestId('session-kind')).toHaveTextContent('Race');
    expect(within(sessions[0]).getByTestId('session-game')).toHaveTextContent('Le Mans Ultimate');
    expect(within(sessions[1]).getByTestId('session-kind')).toHaveTextContent('Practice');
    expect(within(sessions[1]).getByTestId('session-game')).toHaveTextContent('Assetto Corsa');
    expect(within(sessions[0]).getByRole('link')).toHaveAttribute('href', `/virtual/sessions/${race.id}`);

    // The games, with their laps, inside "Where you drive".
    const games = await screen.findAllByTestId('where-row');
    const lmu = games.find((row) => row.textContent?.includes('Le Mans Ultimate'))!;
    const ac = games.find((row) => row.textContent?.includes('Assetto Corsa'))!;
    expect(within(lmu).getByTestId('where-count')).toHaveTextContent('2');
    expect(within(ac).getByTestId('where-count')).toHaveTextContent('1');
  });

  it('shows at most five personal bests and five sessions', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z' });
    for (let i = 0; i < 7; i++) {
      const track = ref(`Track ${i}`);
      const session = v1Session({ track, car: ferrari, lapCount: 1, bestLapMs: 100_000 + i, startedAt: `2026-11-0${i + 1}T10:00:00.000Z` });
      state.sessions.push(session);
      state.laps.push(v1Lap({ track, car: ferrari, sessionId: session.id, timeMs: 100_000 + i, startedAt: `2026-11-0${i + 1}T10:00:00.000Z` }));
    }
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-best');
    expect(screen.getAllByTestId('overview-best-lap')).toHaveLength(5);
    expect(screen.getAllByTestId('overview-session')).toHaveLength(5);
  });

  it('says to get Xpeed Companion, with the download link, when no computer is connected', async () => {
    renderSim(<SimOverview />, { state: fakeV1State(), route: '/virtual' });
    const banner = await screen.findByTestId('overview-companion');
    expect(within(banner).getByTestId('overview-download')).toHaveAttribute('href', '/companion');
    expect(within(banner).getByRole('link', { name: 'Connect Xpeed Companion' })).toHaveAttribute('href', '/virtual/companion');
    expect(screen.queryByTestId('work-on')).not.toBeInTheDocument();
  });

  it('keeps the old numbers on screen with a notice when a later read fails, and says the server is not answering when there are none', async () => {
    const state = fakeV1State();
    state.failing = { status: 503, error: 'unavailable', retryable: true };
    renderSim(<SimOverview />, { state, route: '/virtual' });
    expect(await screen.findByTestId('sim-error')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-companion')).not.toBeInTheDocument();
  });

  it('asks to sign in again when the sign-in no longer works', async () => {
    const state = fakeV1State();
    state.failing = { status: 401, error: 'unauthorized', retryable: false };
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const panel = await screen.findByTestId('sim-error');
    expect(within(panel).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  });
});

describe('what to work on', () => {
  it('is shown, after the page, for a session of at least 3 valid laps: the two biggest findings and a button into the session', async () => {
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 6);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    // The page comes first...
    await screen.findByTestId('overview-best');
    // ...and the card is worked out after it.
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    const findings = within(card).getAllByTestId('work-on-finding');
    expect(findings.length).toBeLessThanOrEqual(2);
    expect(findings[0]).toHaveTextContent(/corner \d/);
    expect(findings.map((item) => item.getAttribute('data-kind'))).toEqual(['variable', 'bestVsAverage']);
    expect(within(card).getByTestId('work-on-open')).toHaveAttribute('href', `/virtual/sessions/${session.id}`);
    expect(within(card).getByTestId('work-on-session')).toHaveTextContent('Monza');
    expect(within(card).getByTestId('work-on-session')).toHaveTextContent('6 laps analysed');
  });

  it('sits in the right column beside Progress, above Consistency, not in the full-width flow', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z' });
    await sessionWithLaps(state, 6);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    const column = card.parentElement!;
    expect(column.className).toMatch(/lg:col-span-4/);
    expect(within(column).getByTestId('overview-consistency')).toBeInTheDocument();
    expect(column.previousElementSibling?.className).toMatch(/lg:col-span-8/);
    expect(within(column.previousElementSibling as HTMLElement).getByTestId('overview-progress')).toBeInTheDocument();
  });

  it('reads the lap files of that one session only, and nothing for the other cards', async () => {
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 5);
    await sessionWithLaps(state, 5, 0, { startedAt: '2026-11-05T18:00:00.000Z', track: spa });
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await waitFor(() => expect(screen.getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    const files = lapFileRequests(state).map((request) => request.path);
    expect(files).toHaveLength(5);
    const mine = state.laps.filter((lap) => lap.sessionId === session.id).map((lap) => `/laps/${lap.id}/file`);
    expect(files.sort()).toEqual(mine.sort());
    // The overview, the dashboard's numbers and the session are read; no list of laps is.
    // (The server is asked first: this one has no insights endpoint, so it answers 404 and the files are read.)
    expect(state.requests.map((request) => request.path).filter((path) => !path.endsWith('/file')).sort()).toEqual(['/overview', `/sessions/${session.id}/insights`, `/sessions/${session.id}`, '/stats'].sort());
  });

  it('shows a skeleton while it is being worked out', async () => {
    const state = fakeV1State();
    await sessionWithLaps(state, 4);
    state.delayMs = 40;
    renderSim(<SimOverview />, { state, route: '/virtual' });
    expect(await screen.findByTestId('work-on-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('work-on-loading')).not.toBeInTheDocument();
  });

  it('is hidden when no session has 3 laps', async () => {
    const state = fakeV1State();
    await sessionWithLaps(state, 2);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-best');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('work-on')).not.toBeInTheDocument();
    expect(lapFileRequests(state)).toHaveLength(0);
  });

  it('is hidden when a session has 3 laps but fewer than 3 are valid (the others were voided by the game)', async () => {
    const state = fakeV1State();
    await sessionWithLaps(state, 4, 2);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-best');
    await waitFor(() => expect(state.requests.some((request) => request.path.startsWith('/sessions/'))).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('work-on')).not.toBeInTheDocument();
    expect(lapFileRequests(state)).toHaveLength(0);
  });

  it('looks further back for a session that qualifies, newest first', async () => {
    const state = fakeV1State();
    await sessionWithLaps(state, 4, 3, { startedAt: '2026-11-12T18:00:00.000Z' }); // newest, but only one valid lap
    const older = await sessionWithLaps(state, 5, 0, { startedAt: '2026-11-10T18:00:00.000Z', track: spa });
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getByTestId('work-on-open')).toHaveAttribute('href', `/virtual/sessions/${older.id}`));
    expect(within(card).getByTestId('work-on-session')).toHaveTextContent('Spa-Francorchamps');
  });

  it('is hidden, without a word, when the lap files cannot be had', async () => {
    const state = fakeV1State();
    await sessionWithLaps(state, 4);
    state.files.clear();
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-best');
    await waitFor(() => expect(lapFileRequests(state).length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByTestId('work-on')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sim-error')).not.toBeInTheDocument();
    // The rest of the page is still there.
    expect(screen.getByTestId('overview-sessions')).toBeInTheDocument();
  });

  it('says its sentences in the language of the person', async () => {
    await i18n.changeLanguage('pt-BR');
    const state = fakeV1State();
    await sessionWithLaps(state, 5);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    expect(card).toHaveTextContent('No que trabalhar');
    expect(within(card).getAllByTestId('work-on-finding')[0]).toHaveTextContent(/curva \d/);
    fireEvent.click(within(card).getByTestId('work-on-open'));
  });
});

/** What the server says of a session from its stored lap metadata (`GET /sessions/<id>/insights`). */
const serverInsights = (sessionId: string, extra: Partial<V1SessionInsights> = {}): V1SessionInsights => ({
  sessionId, source: 'metadata', lapsUsed: 5, lapsConsidered: 5,
  summary: { bestLapMs: 90_000, bestLapId: null, averageMs: 91_000, consistencyMs: 1000, sectors: null },
  findings: [{ kind: 'sectorGain', sector: 2, gainMs: 412, lapId: 'lap-x' }, { kind: 'consistency', stdDevMs: 640, laps: 5 }],
  ...extra,
});

describe('what to work on, from the server', () => {
  it('uses the findings the server worked out from the lap metadata, and reads no lap file at all', async () => {
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 5);
    state.insights.set(session.id, serverInsights(session.id));
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getAllByTestId('work-on-finding')).toHaveLength(2));
    const findings = within(card).getAllByTestId('work-on-finding');
    expect(findings.map((finding) => finding.getAttribute('data-kind'))).toEqual(['sectorGain', 'consistency']);
    expect(findings[0]).toHaveTextContent('Your best lap loses most in sector 2: it is 0.41 s slower than your best time there in this session.');
    expect(findings[1]).toHaveTextContent('Your laps vary by about 0.64 s from one to the next (5 laps).');
    expect(within(card).getByTestId('work-on-session')).toHaveTextContent('5 laps analysed');
    expect(within(card).getByTestId('work-on-open')).toHaveAttribute('href', `/virtual/sessions/${session.id}`);
    // Nothing but the overview, the dashboard's numbers and the one answer: no session detail, no lap file.
    expect(state.requests.map((request) => request.path).sort()).toEqual(['/overview', `/sessions/${session.id}/insights`, '/stats'].sort());
  });

  it('says them in the language of the person', async () => {
    await i18n.changeLanguage('es-ES');
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 5);
    state.insights.set(session.id, serverInsights(session.id, { findings: [{ kind: 'sectorSpread', sector: 3, stdDevMs: 280, laps: 5 }] }));
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getAllByTestId('work-on-finding')).toHaveLength(1));
    expect(within(card).getByTestId('work-on-finding')).toHaveTextContent('Donde más varías es el sector 3: su tiempo cambia unos 0.28 s de vuelta en vuelta.');
  });

  it('falls back to the lap files when the server has nothing to say about the session', async () => {
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 5);
    state.insights.set(session.id, serverInsights(session.id, { findings: [] }));
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await waitFor(() => expect(screen.getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    expect(lapFileRequests(state)).toHaveLength(5);
    expect(screen.getAllByTestId('work-on-finding')[0].getAttribute('data-kind')).toMatch(/variable|bestVsAverage/);
  });

  it('falls back to the lap files when the answer is not one it understands', async () => {
    const state = fakeV1State();
    const session = await sessionWithLaps(state, 5);
    state.insights.set(session.id, { sessionId: session.id, source: 'files', lapsUsed: 5, findings: [] } as unknown as V1SessionInsights);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await waitFor(() => expect(screen.getAllByTestId('work-on-finding').length).toBeGreaterThan(0));
    expect(lapFileRequests(state)).toHaveLength(5);
  });

  it('skips a session the server says has fewer than 3 usable laps and looks further back, newest first', async () => {
    const state = fakeV1State();
    const newer = await sessionWithLaps(state, 4);
    const older = await sessionWithLaps(state, 5, 0, { startedAt: '2026-11-05T18:00:00.000Z', track: spa });
    state.insights.set(newer.id, serverInsights(newer.id, { lapsUsed: 2, findings: [] }));
    state.insights.set(older.id, serverInsights(older.id));
    renderSim(<SimOverview />, { state, route: '/virtual' });
    const card = await screen.findByTestId('work-on');
    await waitFor(() => expect(within(card).getByTestId('work-on-open')).toHaveAttribute('href', `/virtual/sessions/${older.id}`));
    expect(within(card).getByTestId('work-on-session')).toHaveTextContent('Spa-Francorchamps');
    expect(lapFileRequests(state)).toHaveLength(0);
  });
});
