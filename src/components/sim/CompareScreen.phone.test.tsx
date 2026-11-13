import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { gzipLap } from '@/lib/sim/lap-file';
import { installFakeIndexedDb, type FakeIdb } from '@/test/fake-idb';
import { makeLapFixtures } from '@/test/lap-fixture';
import { renderSim } from '@/test/sim-render';
import { fakeV1State, ref, v1Lap, type FakeV1State } from '@/test/v1-fake-server';
import { CompareScreen } from './CompareScreen';

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => true }));
vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));
vi.mock('@/lib/auth/google', () => ({ getAccessToken: async () => 'token' }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

const [mine, best] = makeLapFixtures();
const track = ref('Sample Ring');
const car = ref('Sample Car');
const base = { game: 'sample', track, car };
const myLap = v1Lap({ ...base, lapNumber: 7, timeMs: mine.header.lap.timeMs, startedAt: '2026-11-10T12:10:00.000Z' });
const bestLap = v1Lap({ ...base, lapNumber: 5, timeMs: best.header.lap.timeMs, startedAt: '2026-11-09T12:00:00.000Z' });

let state: FakeV1State;
let idb: FakeIdb;
beforeEach(async () => {
  localStorage.clear();
  idb = installFakeIndexedDb();
  await i18n.changeLanguage('en');
  const [a, b] = await Promise.all([gzipLap(mine), gzipLap(best)]);
  state = fakeV1State({ laps: [myLap, bestLap], files: new Map([[myLap.id, a], [bestLap.id, b]]) });
});
afterEach(() => {
  cleanup();
  idb.uninstall();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the Compare screen on a phone', () => {
  it('keeps the two laps in a slim bar that stays in view, and the analysis in tabs', async () => {
    renderSim(<CompareScreen />, { state, route: `/virtual/compare?a=${myLap.id}&b=${bestLap.id}` });
    const bar = await screen.findByTestId('sticky-laps');
    expect(bar.className).toMatch(/sticky/);
    expect(within(bar).getByTestId('sticky-lap')).toHaveTextContent(/Lap 7 · 0:41\.\d{3} · Sample Ring/);
    await waitFor(() => expect(within(bar).getByTestId('sticky-reference')).toHaveTextContent(/Reference 5 · 0:41\.\d{3}/));
    // One thing at a time: the tabs, not one very long page.
    expect(await screen.findByTestId('analysis-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('lap-analysis')).toHaveAttribute('data-layout', 'tabs');
    expect(screen.queryByTestId('lap-charts')).not.toBeInTheDocument();
    // The full selector (the slots, the swap, the picker) is folded away until "Change" is pressed.
    expect(screen.queryByTestId('compare-slots')).not.toBeInTheDocument();
  });

  it('opens the full selector with Change, and folds it again', async () => {
    renderSim(<CompareScreen />, { state, route: `/virtual/compare?a=${myLap.id}&b=${bestLap.id}` });
    const change = await screen.findByTestId('sticky-change');
    fireEvent.click(change);
    expect(screen.getByTestId('compare-slots')).toBeInTheDocument();
    expect(change).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(change);
    expect(screen.queryByTestId('compare-slots')).not.toBeInTheDocument();
  });

  it('starts with the selector open when no lap is chosen yet', async () => {
    renderSim(<CompareScreen />, { state, route: '/virtual/compare' });
    expect(await screen.findByTestId('compare-slots')).toBeInTheDocument();
    expect(screen.queryByTestId('sticky-laps')).not.toBeInTheDocument();
  });
});
