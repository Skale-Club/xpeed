import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import i18n from '@/lib/i18n';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, v1Session, type FakeV1State } from '@/test/v1-fake-server';
import { SessionPage } from '../SessionPage';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('../SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('recharts', async () => (await import('@/test/recharts-mock')).rechartsMock);
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const monza = ref('Monza');
const ferrari = ref('Ferrari 499P');

/** One session of six laps: an out lap, a lap the game voided, three flying laps (2 is the best, 5 the slowest) and an in lap. */
function seeded(): { state: FakeV1State; sessionId: string; laps: ReturnType<typeof v1Lap>[] } {
  const session = v1Session({ track: monza, car: ferrari, kind: 'qualifying', lapCount: 6, bestLapMs: 99_500 });
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

async function openSession(state: FakeV1State, sessionId: string) {
  const view = renderSim(
    <Routes>
      <Route path="/virtual/sessions/:id" element={<SessionPage />} />
    </Routes>,
    { state, route: `/virtual/sessions/${sessionId}` },
  );
  await screen.findByTestId('session-header');
  await waitFor(() => expect(state.requests.some((request) => request.path === '/pbs')).toBe(true));
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  return view;
}
const cards = () => screen.getAllByTestId('lap-card');
const cardOrder = () => cards().map((card) => card.getAttribute('data-lap-id'));

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

describe('the session page on a phone', () => {
  it('lists the laps as cards, not a table, with a sort control and no horizontal scroll', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    expect(screen.queryByTestId('session-laps')).not.toBeInTheDocument();
    expect(cards()).toHaveLength(6);
    expect(cardOrder()).toEqual(laps.map((lap) => lap.id));
    expect(screen.getByTestId('lap-sort-select').className).toMatch(/h-10/);
    expect(screen.getByTestId('lap-sort-direction').className).toMatch(/h-10/);
    expect(screen.getByTestId('lap-cards').closest('.overflow-x-auto')).toBeNull();
  });

  it('shows the time large, the gap, and marks the best lap clearly and the slowest valid lap subtly', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    const best = cards()[1];
    expect(best).toHaveAttribute('data-best', 'true');
    expect(within(best).getByTestId('lap-time')).toHaveTextContent('1:39.500');
    expect(within(best).getByTestId('lap-time').className).toMatch(/font-mono/);
    expect(within(best).getByTestId('lap-gap')).toHaveTextContent('–');
    expect(within(best).getByText('Best lap')).toBeInTheDocument();
    const four = cards()[3];
    expect(within(four).getByTestId('lap-gap')).toHaveTextContent('+0.700');
    // Lap 5 is the slowest valid flying lap; the voided, out and in laps never are.
    expect(cards().filter((card) => card.hasAttribute('data-worst')).map((card) => card.getAttribute('data-lap-id'))).toEqual([laps[4].id]);
    expect(within(cards()[4]).getByTestId('lap-worst')).toHaveTextContent('slowest');
    // The voided lap says so.
    expect(within(cards()[2]).getByTestId('lap-tags')).toHaveTextContent('not valid');
  });

  it('keeps the card tap going to the analysis of that lap', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    const link = within(cards()[1]).getByTestId('lap-card-link');
    expect(link).toHaveAttribute('href', expect.stringContaining(laps[1].id));
    expect(link.className).toMatch(/min-h-10/);
  });

  it('sorts with the select (voided laps last) and reverses with the direction button', async () => {
    const { state, sessionId, laps } = seeded();
    await openSession(state, sessionId);
    fireEvent.change(screen.getByTestId('lap-sort-select'), { target: { value: 'time' } });
    expect(cardOrder()).toEqual([laps[1], laps[3], laps[4], laps[5], laps[0], laps[2]].map((lap) => lap.id));
    fireEvent.click(screen.getByTestId('lap-sort-direction'));
    expect(screen.getByTestId('lap-sort-direction')).toHaveAttribute('data-direction', 'desc');
    expect(cardOrder()).toEqual([laps[0], laps[5], laps[4], laps[3], laps[1], laps[2]].map((lap) => lap.id));
  });

  it('shows the sectors of each lap as chips in a row of its own, in the same colour scale, with the legend', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.queryByTestId('sector-table')).not.toBeInTheDocument();
    const chips = screen.getByTestId('sector-chips');
    expect(chips.closest('.overflow-x-auto')).toBeNull();
    const rows = within(chips).getAllByTestId('sector-row');
    expect(rows).toHaveLength(6);
    const second = within(rows[1]).getAllByTestId('lap-sector');
    expect(second).toHaveLength(3);
    expect(second[0]).toHaveTextContent('S1');
    expect(second[0].className).toMatch(/text-xs/);
    expect(second[0].getAttribute('data-heat')).toBe('0'); // lap 2 holds the best first sector among the timed laps shown
    expect(within(chips).getAllByTestId('best-sector')).toHaveLength(3);
    expect(screen.getByTestId('sector-legend').className).toMatch(/text-xs/);
    expect(screen.getByTestId('sector-heat').innerHTML).not.toContain('text-[10px]');
  });

  it('draws the chart shorter and says tap, not click', async () => {
    const { state, sessionId } = seeded();
    await openSession(state, sessionId);
    expect(screen.getByTestId('session-chart-plot')).toHaveStyle({ height: '180px' });
    expect(screen.getByText('Tap a bar to open the analysis of that lap.')).toBeInTheDocument();
    expect(screen.queryByText(/Click a bar/)).not.toBeInTheDocument();
  });
});
