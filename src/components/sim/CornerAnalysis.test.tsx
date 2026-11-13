import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { LapFile } from '@/lib/sim/lap-file';
import { buildSyntheticLap, exampleCorners, type SynthCorner } from '@/lib/sim/synthetic-lap';
import { LapAnalysis, type LoadedLap } from './LapAnalysis';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));

const LENGTH = 4200;
function lapWith(patch: (corners: SynthCorner[]) => SynthCorner[] = (c) => c, extra: { sectors?: boolean } = {}): LapFile {
  const built = buildSyntheticLap({ lengthM: LENGTH, corners: patch(exampleCorners()), hz: 20, trackName: 'Synthetic Ring' });
  if (!extra.sectors) return built.lap;
  // Sector times that follow the clock of the lap, so they add up to the lap time.
  const [a, b] = [built.truth.timeAt(1400), built.truth.timeAt(2900)];
  const sectorsMs = [Math.round(a * 1000), Math.round((b - a) * 1000), built.lap.header.lap.timeMs - Math.round(b * 1000)];
  return { ...built.lap, header: { ...built.lap.header, lap: { ...built.lap.header.lap, sectorsMs } } };
}
const reference = lapWith((c) => c, { sectors: true });
/** The hairpin braked 15 m too early and the last corner taken 8 km/h slower. */
const mine = lapWith((corners) => corners.map((c, i) => (i === 1 ? { ...c, brakeDist: c.brakeDist - 15 } : i === 5 ? { ...c, minSpeedKmh: c.minSpeedKmh - 8 } : c)), { sectors: true });
const loaded = (id: string, lap: LapFile): LoadedLap => ({ id, lap });

function renderAnalysis(lap: LapFile = mine, ref: LapFile | null = reference, extra: Partial<Parameters<typeof LapAnalysis>[0]> = {}) {
  return render(
    <SettingsProvider>
      <LapAnalysis lap={loaded('a', lap)} reference={ref ? loaded('b', ref) : null} {...extra} />
    </SettingsProvider>,
  );
}
const ready = () => screen.findByTestId('where-list');

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('where the time went', () => {
  it('shows a loading state at once, and the findings once the analysis has come back', async () => {
    renderAnalysis();
    // The numbers and the charts do not wait for the analysis.
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();
    expect(screen.getAllByTestId('chart').length).toBeGreaterThan(0);
    expect(screen.getByTestId('where-loading')).toBeInTheDocument();
    const list = await ready();
    expect(screen.queryByTestId('where-loading')).not.toBeInTheDocument();
    const items = within(list).getAllByTestId('where-item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.some((item) => /^You lose 0\.\d\d s in corner 2: you brake 1\d m earlier than the reference\.$/.test(item.textContent ?? ''))).toBe(true);
    expect(items.some((item) => /corner 4: your minimum speed is \d km\/h lower/.test(item.textContent ?? ''))).toBe(true);
  });

  it('says it cannot tell why, naming the missing brake, when a lap has no brake data', async () => {
    const noBrake: LapFile = { ...mine, data: Object.fromEntries(Object.entries(mine.data).filter(([id]) => id !== 'brake' && id !== 'g_long')) };
    renderAnalysis(noBrake);
    const list = await ready();
    const text = within(list).getAllByTestId('where-item').map((item) => item.textContent).join('\n');
    expect(text).not.toMatch(/you brake \d+ m/);
    // A corner that lost time with no brake data: nothing is claimed about the brakes.
    expect(text).not.toMatch(/brakes? (earlier|later)/);
  });

  it('is in Portuguese for a Portuguese reader', async () => {
    await i18n.changeLanguage('pt-BR');
    renderAnalysis();
    const list = await ready();
    expect(screen.getByText('Onde o tempo foi')).toBeInTheDocument();
    expect(within(list).getAllByTestId('where-item')[0].textContent).toMatch(/Você perde|Pierdes/);
  });

  it('is not shown for a lap with no reference, and says why when the laps cannot be compared', async () => {
    renderAnalysis(mine, null);
    expect(screen.queryByTestId('where-time-went')).not.toBeInTheDocument();
    expect(screen.queryByTestId('corner-table')).not.toBeInTheDocument();
    cleanup();
    const longer = buildSyntheticLap({ lengthM: LENGTH * 1.2, corners: exampleCorners(), hz: 20, trackName: 'Synthetic Ring' }).lap;
    renderAnalysis(mine, longer);
    // Different lengths: refused at once, the lap alone is shown, no corner analysis is asked for.
    expect(screen.getByTestId('different-tracks')).toBeInTheDocument();
    expect(screen.queryByTestId('where-time-went')).not.toBeInTheDocument();
  });
});

describe('the corner table', () => {
  it('has a row per corner in the order of the track, a loss red and a gain green, with the cause and the differences', async () => {
    renderAnalysis(lapWith((corners) => corners.map((c, i) => (i === 0 ? { ...c, minSpeedKmh: c.minSpeedKmh + 6, exitSpeedKmh: c.exitSpeedKmh + 6 } : i === 1 ? { ...c, brakeDist: c.brakeDist - 15 } : c))));
    await screen.findByTestId('corner-rows');
    const rows = screen.getAllByTestId('corner-row');
    expect(rows.map((row) => row.getAttribute('data-corner'))).toEqual(['1', '2', '3', '4']);
    const tones = Object.fromEntries(rows.map((row) => [row.getAttribute('data-corner'), row.getAttribute('data-tone')]));
    expect(tones['2']).toBe('loss');
    expect(tones['1']).toBe('gain');
    expect(within(rows[1]).getByTestId('corner-time').className).toMatch(/destructive/);
    expect(within(rows[0]).getByTestId('corner-time').className).toMatch(/green/);
    expect(within(rows[1]).getByTestId('corner-cause')).toHaveTextContent('Brakes early');
    expect(within(rows[1]).getByTestId('corner-brake').textContent).toMatch(/^−1\d$/);
    expect(within(rows[2]).getByTestId('corner-cause')).toHaveTextContent('–'); // no time lost: no cause to name
    expect(screen.getByTestId('corner-totals')).toHaveTextContent(/Corners \+?[-−]?\d\.\d{3} s · straights .* s · whole lap .* s/);
  });

  it('can put the biggest loss first', async () => {
    renderAnalysis();
    await screen.findByTestId('corner-rows');
    fireEvent.click(screen.getByTestId('corner-sort'));
    const rows = screen.getAllByTestId('corner-row');
    const times = rows.map((row) => Number(within(row).getByTestId('corner-time').textContent!.replace('−', '-')));
    expect(times).toEqual([...times].sort((p, q) => q - p));
  });

  it('lists the corners only one lap has, apart from the table', async () => {
    renderAnalysis(mine, lapWith((corners) => corners.filter((_, i) => i !== 1), { sectors: true }));
    await screen.findByTestId('corner-rows');
    const apart = screen.getByTestId('corner-unmatched');
    const items = within(apart).getAllByTestId('unmatched-corner');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-side', 'lap');
    expect(items[0]).toHaveTextContent(/^A corner at \d+ m \(about \d+ km\/h at its slowest\) is only on the lap\.$/);
    // It is not a row of the table.
    expect(screen.getAllByTestId('corner-row')).toHaveLength(3);
  });

  it('zooms the charts and the map to the corner that is clicked, and "Show whole lap" goes back', async () => {
    renderAnalysis();
    await screen.findByTestId('corner-rows');
    expect(screen.getByTestId('lap-charts')).not.toHaveAttribute('data-range');
    expect(screen.getAllByTestId('chart').every((chart) => chart.getAttribute('data-points') === '1200')).toBe(true);
    expect(screen.getByTestId('track-map')).toHaveAttribute('data-zoom', '1');

    fireEvent.click(screen.getByTestId('corner-rows').querySelector('[data-corner="2"]') as HTMLElement);

    const range = screen.getByTestId('lap-charts').getAttribute('data-range') as string;
    const [from, to] = range.split('-').map(Number);
    // The hairpin is at 1040 m with its brake point at 885 m: the stretch holds the corner and some road around it.
    expect(from).toBeLessThan(885);
    expect(to).toBeGreaterThan(1130);
    expect(to - from).toBeLessThan(700);
    expect(screen.getByTestId('zoom-bar')).toHaveTextContent(/Zoomed to corner 2 \(\d+–\d+ m\)/);
    expect(screen.getByTestId('corner-rows').querySelector('[data-corner="2"]')).toHaveAttribute('data-selected', 'true');
    // The charts hold the stretch only, finer than before, and the map is closer in with the corner marked.
    for (const chart of screen.getAllByTestId('chart')) {
      expect(Number(chart.getAttribute('data-points'))).toBeLessThan(1200);
      expect(Number(chart.getAttribute('data-points'))).toBeGreaterThan(50);
    }
    await waitFor(() => expect(Number(screen.getByTestId('track-map').getAttribute('data-zoom'))).toBeGreaterThan(1.5));
    expect(screen.getByTestId('map-highlight')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('show-whole-lap'));
    expect(screen.getByTestId('lap-charts')).not.toHaveAttribute('data-range');
    expect(screen.queryByTestId('zoom-bar')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chart').every((chart) => chart.getAttribute('data-points') === '1200')).toBe(true);
    await waitFor(() => expect(screen.getByTestId('track-map')).toHaveAttribute('data-zoom', '1'));
    expect(screen.queryByTestId('map-highlight')).not.toBeInTheDocument();
  });

  it('zooms from a finding too (the pin beside a sentence of "where the time went")', async () => {
    renderAnalysis();
    const list = await ready();
    const pin = within(list).getAllByRole('button', { name: /Zoom to corner \d/ })[0];
    fireEvent.click(pin);
    expect(screen.getByTestId('lap-charts')).toHaveAttribute('data-range');
    expect(screen.getByTestId('zoom-bar')).toBeInTheDocument();
  });
});

describe('the sector strip', () => {
  it('shows both laps\' sectors with the usual colours, what each left on the table and the theoretical best of the two', async () => {
    renderAnalysis();
    const strip = await screen.findByTestId('sector-strip');
    const sectors = (testId: string) => within(strip).getAllByTestId(testId);
    const seconds = (cell: HTMLElement) => Number(cell.textContent);
    const [a, b] = [mine.header.lap.sectorsMs!, reference.header.lap.sectorsMs!];
    expect(sectors('strip-lap-sector').map(seconds)).toEqual(a.map((ms) => Number((ms / 1000).toFixed(3))));
    expect(sectors('strip-reference-sector').map(seconds)).toEqual(b.map((ms) => Number((ms / 1000).toFixed(3))));
    // The better of the two in each sector is purple, the other yellow.
    sectors('strip-lap-sector').forEach((cell, i) => {
      expect(cell.getAttribute('data-tone')).toBe(a[i] <= b[i] ? 'purple' : 'yellow');
      expect(sectors('strip-reference-sector')[i].getAttribute('data-tone')).toBe(b[i] <= a[i] ? 'purple' : 'yellow');
    });
    const best = a.map((ms, i) => Math.min(ms, b[i]));
    const left = a.reduce((sum, ms, i) => sum + (ms - best[i]), 0);
    expect(within(strip).getByTestId('strip-left-total')).toHaveTextContent(left === 0 ? '0.000' : `+${(left / 1000).toFixed(3)}`);
    const theoretical = best.reduce((sum, ms) => sum + ms, 0);
    const minutes = Math.floor(theoretical / 60_000);
    expect(within(strip).getByTestId('strip-theoretical')).toHaveTextContent(`${minutes}:${String(((theoretical % 60_000) / 1000).toFixed(3)).padStart(6, '0')}`);
  });

  it('is not shown when a lap has no sectors', async () => {
    renderAnalysis(lapWith((c) => c, { sectors: false }));
    // Two identical laps: nothing lost anywhere, which the panel says in a sentence of its own.
    expect(await screen.findByTestId('where-none')).toBeInTheDocument();
    expect(screen.queryByTestId('sector-strip')).not.toBeInTheDocument();
  });
});

describe('on a phone', () => {
  const tabState = (id: string) => screen.getByTestId(`tab-${id}`).getAttribute('data-state');
  const press = (id: string) => fireEvent.mouseDown(screen.getByTestId(`tab-${id}`), { button: 0 });

  it('has the tabs Summary, Corners, Charts and Map, with one thing at a time', async () => {
    renderAnalysis(mine, reference, { phone: true });
    expect(screen.getByTestId('lap-analysis')).toHaveAttribute('data-layout', 'tabs');
    expect(within(screen.getByTestId('analysis-tabs')).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Summary', 'Corners', 'Charts', 'Map']);
    // Summary: the numbers, where the time went and the sectors; nothing of the other tabs.
    expect(tabState('summary')).toBe('active');
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();
    await ready();
    expect(screen.getByTestId('sector-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('corner-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('lap-charts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('track-map')).not.toBeInTheDocument();

    press('corners');
    expect(tabState('corners')).toBe('active');
    expect(await screen.findByTestId('corner-rows')).toBeInTheDocument();
    expect(screen.queryByTestId('lap-numbers')).not.toBeInTheDocument();

    press('charts');
    expect(screen.getByTestId('lap-charts')).toBeInTheDocument();
    expect(screen.queryByTestId('corner-table')).not.toBeInTheDocument();

    press('map');
    expect(screen.getByTestId('track-map')).toBeInTheDocument();
    expect(screen.queryByTestId('lap-charts')).not.toBeInTheDocument();
  });

  it('goes to the charts when a corner is picked in the table, zoomed to it, and keeps the way back on the charts tab', async () => {
    renderAnalysis(mine, reference, { phone: true });
    press('corners');
    await screen.findByTestId('corner-rows');
    fireEvent.click(screen.getByTestId('corner-rows').querySelector('[data-corner="2"]') as HTMLElement);
    expect(tabState('charts')).toBe('active');
    expect(screen.getByTestId('lap-charts')).toHaveAttribute('data-range');
    fireEvent.click(screen.getByTestId('zoom-bar-reset'));
    expect(screen.getByTestId('lap-charts')).not.toHaveAttribute('data-range');
  });

  it('has no Corners tab for a lap on its own', () => {
    renderAnalysis(mine, null, { phone: true });
    expect(within(screen.getByTestId('analysis-tabs')).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Summary', 'Charts', 'Map']);
  });

  it('is the long page on a wide screen', async () => {
    renderAnalysis(mine, reference, { phone: false });
    expect(screen.getByTestId('lap-analysis')).not.toHaveAttribute('data-layout');
    expect(screen.queryByTestId('analysis-tabs')).not.toBeInTheDocument();
    await screen.findByTestId('corner-rows');
    expect(screen.getByTestId('lap-charts')).toBeInTheDocument();
    expect(screen.getByTestId('track-map')).toBeInTheDocument();
  });
});
