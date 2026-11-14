import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import type { LapFile } from '@/lib/sim/lap-file';
import { makeLapFixtures } from '@/test/lap-fixture';
import { trackPath } from '@/lib/sim/analysis';
import { circle, makeLayout } from '@/test/track-fixture';
import { chooseOption, selectOptions } from '@/test/select';
import { LapAnalysis, type LoadedLap } from './LapAnalysis';

vi.mock('./SimCarIdentity', () => ({ SimCarIdentity: ({ name }: { name: string }) => <span data-testid="sim-car-identity">{name}</span> }));
// The real charts need a layout engine; what matters here is which charts are drawn and with how many points.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));

const [mine, best] = makeLapFixtures();
const loaded = (id: string, lap: LapFile): LoadedLap => ({ id, lap });

type Props = Partial<Parameters<typeof LapAnalysis>[0]>;
function renderAnalysis(lap: LapFile | null = mine, reference: LapFile | null = best, extra: Props = {}) {
  return render(
    <SettingsProvider>
      <LapAnalysis lap={loaded('a', lap ?? mine)} reference={reference ? loaded('b', reference) : null} {...extra} />
    </SettingsProvider>,
  );
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a lap and its reference', () => {
  it('compares them and finds where the time is lost', () => {
    renderAnalysis();
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^\+0\.3\d\d s$/);
    const numbers = within(screen.getByTestId('lap-numbers'));
    expect(numbers.getByText('0:41.390')).toBeInTheDocument();
    expect(numbers.getByText('0:41.076')).toBeInTheDocument();
    expect(numbers.getAllByText(/km\/h/).length).toBeGreaterThan(0);

    const charts = screen.getAllByTestId('chart');
    expect(charts).toHaveLength(4); // the gap, speed, throttle and brake
    expect(charts.every((chart) => chart.getAttribute('data-points') === '1200')).toBe(true);
    expect(screen.getByTestId('track-map')).toBeInTheDocument();

    const changes = within(screen.getByTestId('time-changes'));
    expect(changes.getByText('Where the lap loses time')).toBeInTheDocument();
    expect(changes.getByText(/1350–1500 m/)).toBeInTheDocument();
    expect(changes.getByText('No stretch of 150 m changes the gap by more than 0.01 s.')).toBeInTheDocument(); // nothing gained
  });

  it('turns the gap around when the lap and the reference are the other way round', () => {
    renderAnalysis(best, mine);
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^-0\.3\d\d s$/);
    expect(within(screen.getByTestId('time-changes')).getByText('Where the lap gains time')).toBeInTheDocument();
  });

  it('shows the lap alone when there is no reference', () => {
    renderAnalysis(mine, null);
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument();
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();
    expect(screen.getAllByTestId('chart')).toHaveLength(3);
  });

  it('shows speed and distance in miles when that is the unit chosen', () => {
    localStorage.setItem('settings_distanceUnit', 'mi');
    renderAnalysis();
    expect(within(screen.getByTestId('lap-numbers')).getAllByText(/mph/).length).toBeGreaterThan(0);
    expect(screen.getByText(/4429–4921 ft/)).toBeInTheDocument(); // 1350 to 1500 m
    expect(screen.queryByText(/km\/h/)).not.toBeInTheDocument();
  });

  it('has no way to open a file: no file input and no drop zone', () => {
    const { container } = renderAnalysis();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByTestId('lap-dropzone')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open lap files|sample laps/i })).not.toBeInTheDocument();
  });
});

describe('the track layout', () => {
  const sample = { game: mine.header.game, name: mine.header.track.name };
  const layoutOfSample = (over: Partial<Parameters<typeof makeLayout>[0]> = {}) =>
    makeLayout({ points: circle(300, 80), width: 8, closed: true, ideal: true, game: sample.game, name: sample.name, ...over });

  it('is drawn under the lap when one is kept for the track, and the hint says what the colours are', async () => {
    const findLayout = vi.fn(async () => layoutOfSample());
    renderAnalysis(mine, null, { findLayout });
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(findLayout).toHaveBeenCalledWith(sample.game, sample.name, null);
    expect(screen.getByTestId('map-hint')).toHaveTextContent(/Red: the game’s ideal line/);
  });

  it('is not there when Xpeed Companion has not sent one, and the hint says so without offering a file', async () => {
    const findLayout = vi.fn(async () => null);
    renderAnalysis(mine, null, { findLayout });
    await waitFor(() => expect(findLayout).toHaveBeenCalled());
    expect(screen.queryByTestId('track-layout')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-hint')).toHaveTextContent(/Solid: the lap/);
    expect(screen.getByTestId('map-hint')).not.toHaveTextContent(/\.xtrk/);
  });

  // A layout whose ideal line is the line the sample lap drove.
  const onSampleLine = () =>
    makeLayout({ points: trackPath(mine, 2000)!.points, width: 8, closed: true, ideal: true, idealShift: 0, game: sample.game, name: sample.name });

  it('measures how far the lap was from the ideal line, and says when it never left it', async () => {
    renderAnalysis(mine, best, { findLayout: async () => onSampleLine() });
    await waitFor(() => expect(screen.getByTestId('offset-chart')).toBeInTheDocument());
    expect(screen.getByTestId('off-line')).toHaveTextContent('The lap stayed within 1.5 m of the ideal line all the way round.');
    expect(screen.queryByTestId('layout-mismatch')).not.toBeInTheDocument();
  });

  it('lists where the lap kept off the ideal line, to which side and how far', async () => {
    // The same line, moved 4 m: the lap is 4 m to one side of it all the way round.
    const moved = makeLayout({ points: trackPath(mine, 2000)!.points, width: 12, closed: true, ideal: true, idealShift: 4, game: sample.game, name: sample.name });
    renderAnalysis(mine, null, { findLayout: async () => moved });
    await waitFor(() => expect(screen.getByTestId('off-line')).toBeInTheDocument());
    const items = within(screen.getByTestId('off-line')).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveTextContent(/up to \d\.\d m to the (left|right)/);
  });

  it('does not measure against a layout the lap is not on, and says so', async () => {
    renderAnalysis(mine, null, { findLayout: async () => layoutOfSample({ points: circle(3000, 80) }) });
    await waitFor(() => expect(screen.getByTestId('layout-mismatch')).toBeInTheDocument());
    expect(screen.queryByTestId('offset-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('off-line')).not.toBeInTheDocument();
  });

  it('zooms the map in on a stretch asked for', async () => {
    renderAnalysis();
    expect(screen.getByTestId('track-map').getAttribute('data-zoom')).toBe('1');
    fireEvent.click(within(screen.getByTestId('time-changes')).getAllByRole('button', { name: /Show on the map/ })[0]);
    await waitFor(() => expect(screen.getByTestId('track-map').getAttribute('data-zoom')).toBe('8'));
  });

  it('says when none is kept for the track, and lets a kept one of the same game be tied to it', async () => {
    const kept = [
      { id: 'u|sample|other ring|', fileName: 'other.xtrk', addedAt: 0, size: 1, summary: { game: sample.game, trackName: 'Other Ring', source: 'x', hasIdealLine: true, hasPitLane: false, hasEdges: true } },
      { id: 'u|ac|monza|', fileName: 'monza.xtrk', addedAt: 0, size: 1, summary: { game: 'ac', trackName: 'Monza', source: 'x', hasIdealLine: true, hasPitLane: false, hasEdges: true } },
    ];
    const linkLayout = vi.fn(async () => layoutOfSample());
    renderAnalysis(mine, null, { findLayout: async () => null, listKeptLayouts: async () => kept, linkLayout });
    await waitFor(() => expect(screen.getByTestId('no-layout')).toHaveTextContent(`The map of “${sample.name}” will appear after you drive this track`));
    const select = await screen.findByTestId('pick-layout');
    // Only the layouts of the lap's game are offered.
    expect(select).toHaveTextContent('Choose a layout');
    expect(selectOptions(select)).toEqual(['Other Ring']);
    chooseOption(select, 'Other Ring');
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(linkLayout).toHaveBeenCalledWith(sample.game, sample.name, null, 'u|sample|other ring|');
    expect(screen.queryByTestId('no-layout')).not.toBeInTheDocument();
  });
});

describe('laps that cannot be compared', () => {
  const withHeader = (over: Partial<LapFile['header']>): LapFile => ({ ...best, header: { ...best.header, ...over } });

  it('refuses a different track, says why, draws no gap and still shows the lap alone', () => {
    renderAnalysis(mine, withHeader({ track: { name: 'Another Ring', lengthM: best.header.track.lengthM } }));
    expect(screen.getByTestId('different-tracks')).toHaveTextContent(/different tracks/);
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('time-changes')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chart')).toHaveLength(3); // speed, throttle and brake of the lap alone
  });

  it('refuses a different game', () => {
    renderAnalysis(mine, withHeader({ game: 'lmu' }));
    expect(screen.getByTestId('different-tracks')).toHaveTextContent(/different games/);
  });

  it('refuses laps whose lengths are too far apart to be the same layout', () => {
    const short: LapFile = { ...best, data: { ...best.data, dist: best.data.dist.map((d) => d * 0.5) } };
    renderAnalysis(mine, short);
    expect(screen.getByTestId('different-tracks')).toHaveTextContent(/not on the same track layout/);
  });
});
