import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/lib/i18n';
import { gzipLap } from '@/lib/sim/lap-file';
import { buildSyntheticLap, exampleCorners } from '@/lib/sim/synthetic-lap';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { SimOverview } from './SimOverview';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  LineChart: ({ children }: { children: ReactNode }) => <figure>{children}</figure>,
  Bar: () => null, Cell: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null,
}));

const monza = ref('Monza');
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

/** A session of `count` valid laps on Monza with real lap files, so "what to work on" has something to say. */
async function sessionWithLaps(state: FakeV1State, count: number, startedAt = '2026-11-12T18:00:00.000Z') {
  const session = v1Session({ track: monza, car: ferrari, kind: 'race', startedAt, lapCount: count, bestLapMs: 90_000 });
  state.sessions.push(session);
  for (let i = 0; i < count; i++) {
    const shift = [0, 7, -6, 4, 9, -3, 2, -8][i % 8];
    const built = buildSyntheticLap({
      lengthM: 4200, hz: 10, lapNumber: i + 1, valid: true, trackName: monza.name, car: ferrari.name,
      corners: exampleCorners().map((corner, k) => (k === 1 ? { ...corner, brakeDist: corner.brakeDist + shift } : corner)),
    }).lap;
    const lap = v1Lap({ track: monza, car: ferrari, sessionId: session.id, lapNumber: i + 1, timeMs: built.header.lap.timeMs, valid: true, startedAt: new Date(Date.parse(startedAt) + i * 100_000).toISOString() });
    state.laps.push(lap);
    state.files.set(lap.id, await gzipLap(built));
  }
  // The session's best is its fastest lap, so it is also the personal best the overview lists.
  session.bestLapMs = Math.min(...state.laps.filter((lap) => lap.sessionId === session.id).map((lap) => lap.timeMs));
  return session;
}

describe('the Overview on a phone', () => {
  it('shows four tiles: sessions, time, laps and personal bests', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z' });
    await sessionWithLaps(state, 4);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-sessions');
    const tiles = screen.getByTestId('kpi-tiles');
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(4);
    for (const id of ['sessions', 'time', 'laps', 'personalBests']) expect(within(tiles).getByTestId(`kpi-${id}`)).toBeInTheDocument();
    expect(within(tiles).queryByTestId('kpi-distance')).not.toBeInTheDocument();
    expect(within(tiles).queryByTestId('kpi-tracksCars')).not.toBeInTheDocument();
  });

  it('shows the same four tiles, as dashes, when there are no laps', async () => {
    renderSim(<SimOverview />, { state: fakeV1State(), route: '/virtual' });
    const tiles = await screen.findByTestId('kpi-tiles');
    expect(tiles).toHaveAttribute('data-empty', 'true');
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(4);
    expect(within(tiles).queryByTestId('kpi-distance')).not.toBeInTheDocument();
  });

  it('puts the latest three sessions, as cards that open the session, before what to work on and progress', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z' });
    const newest = await sessionWithLaps(state, 5, '2026-11-12T18:00:00.000Z');
    await sessionWithLaps(state, 3, '2026-11-11T18:00:00.000Z');
    await sessionWithLaps(state, 3, '2026-11-10T18:00:00.000Z');
    await sessionWithLaps(state, 3, '2026-11-09T18:00:00.000Z');
    renderSim(<SimOverview />, { state, route: '/virtual' });

    const cards = await screen.findAllByTestId('overview-session');
    expect(cards).toHaveLength(3);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(within(cards[0]).getByRole('link')).toHaveAttribute('href', `/virtual/sessions/${newest.id}`);
    expect(within(cards[0]).getByTestId('overview-session-best')).toHaveTextContent(/\d:\d\d\.\d{3}/);
    // Monza in the Ferrari has one personal best; the session that holds it (if among the three) carries the badge, the others do not.
    expect(screen.queryAllByTestId('overview-session-pb').length).toBeLessThanOrEqual(1);
    expect(screen.getByTestId('overview-all-sessions')).toHaveAttribute('href', '/virtual/sessions');

    const workOn = await screen.findByTestId('work-on');
    const follows = (a: HTMLElement, b: HTMLElement) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(screen.getByTestId('overview-sessions'), workOn)).toBe(true);
    expect(follows(workOn, screen.getByTestId('overview-progress'))).toBe(true);
    expect(follows(screen.getByTestId('overview-progress'), screen.getByTestId('overview-best'))).toBe(true);
  });

  it('keeps "More stats" closed, without the activity, and opens it on a tap', async () => {
    const state = fakeV1State({ now: '2026-11-13T12:00:00.000Z' });
    await sessionWithLaps(state, 4);
    renderSim(<SimOverview />, { state, route: '/virtual' });
    await screen.findByTestId('overview-sessions');

    const toggle = screen.getByRole('button', { name: 'More stats' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.className).toMatch(/\bh-10\b/);
    for (const id of ['overview-activity', 'overview-consistency', 'overview-where']) expect(screen.queryByTestId(id)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const more = screen.getByTestId('overview-more');
    await waitFor(() => expect(within(more).getByTestId('overview-activity')).toBeInTheDocument());
    expect(within(more).getByTestId('overview-consistency')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.queryByTestId('overview-more')).not.toBeInTheDocument();
  });
});
