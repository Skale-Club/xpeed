import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import { SettingsProvider } from '@/contexts/SettingsContext';
import { gzipLap, type LapFile } from '@/lib/sim/lap-file';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { trackPath } from '@/lib/sim/analysis';
import { circle, gzipBytes, makeLayout, packLayout } from '@/test/track-fixture';
import { LapAnalysis, type LoadedLap } from './LapAnalysis';

// The real charts need a layout engine; what matters here is which charts are drawn and with how many points.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-points={data.length}>{children}</figure>,
  Line: () => null, XAxis: () => null, YAxis: () => null, CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null,
}));

const [mine, best] = makeSampleLaps();

function renderAnalysis(initialLaps?: LoadedLap[]) {
  return render(<SettingsProvider><LapAnalysis initialLaps={initialLaps} /></SettingsProvider>);
}
const loaded = (id: string, lap: LapFile): LoadedLap => ({ id, name: `${id}.xlap.gz`, lap });
const rows = () => within(screen.getByTestId('lap-list')).getAllByRole('listitem');
const pick = (row: HTMLElement, name: string) => fireEvent.click(within(row).getByRole('button', { name }));
const openFiles = (files: File[]) => fireEvent.change(screen.getByTestId('lap-input'), { target: { files } });

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('with no laps open', () => {
  it('says how to open some, and keeps files in the browser', () => {
    renderAnalysis();
    expect(screen.getByText(/Open one or two lap files/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is uploaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open lap files/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try with sample laps/ })).toBeEnabled();
    expect(screen.queryByTestId('lap-list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove all/ })).not.toBeInTheDocument();
  });
});

describe('with the sample laps', () => {
  it('lists both, compares them and finds where the time is lost', () => {
    renderAnalysis();
    fireEvent.click(screen.getByRole('button', { name: /Try with sample laps/ }));

    expect(rows()).toHaveLength(2);
    expect(within(rows()[0]).getByText(/Sample Ring · Sample Car · Lap 7 · 0:41\.390/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try with sample laps/ })).toBeDisabled();

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

  it('turns the gap around when the lap and the reference swap', () => {
    renderAnalysis();
    fireEvent.click(screen.getByRole('button', { name: /Try with sample laps/ }));
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^\+0\.3/);

    pick(rows()[0], 'Reference'); // my lap becomes the reference, the best lap becomes the lap
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^-0\.3\d\d s$/);
    expect(within(rows()[1]).getByRole('button', { name: 'Lap' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(rows()[0]).getByRole('button', { name: 'Reference' })).toHaveAttribute('aria-pressed', 'true');
    const changes = within(screen.getByTestId('time-changes'));
    expect(changes.getByText('Where the lap gains time')).toBeInTheDocument();
  });

  it('does not leave the lap with nothing to be when the only reference is picked as the lap', () => {
    renderAnalysis([loaded('one', mine)]);
    pick(rows()[0], 'Reference');
    expect(within(rows()[0]).getByRole('button', { name: 'Lap' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();
  });

  it('removes one lap, then all of them', () => {
    renderAnalysis();
    fireEvent.click(screen.getByRole('button', { name: /Try with sample laps/ }));
    fireEvent.click(within(rows()[0]).getByRole('button', { name: /^Remove/ }));
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument(); // one lap, nothing to compare against
    expect(screen.getByTestId('lap-numbers')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Remove all/ }));
    expect(screen.queryByTestId('lap-list')).not.toBeInTheDocument();
    expect(screen.getByText(/Open one or two lap files/)).toBeInTheDocument();
  });

  it('shows speed and distance in miles when that is the unit chosen', () => {
    localStorage.setItem('settings_distanceUnit', 'mi');
    renderAnalysis();
    fireEvent.click(screen.getByRole('button', { name: /Try with sample laps/ }));
    expect(within(screen.getByTestId('lap-numbers')).getAllByText(/mph/).length).toBeGreaterThan(0);
    expect(screen.getByText(/4429–4921 ft/)).toBeInTheDocument(); // 1350 to 1500 m
    expect(screen.queryByText(/km\/h/)).not.toBeInTheDocument();
  });
});

describe('opening files', () => {
  it('reads files a person picks and makes the second one the reference', async () => {
    renderAnalysis();
    openFiles([new File([await gzipLap(mine)], 'my-lap.xlap.gz')]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument();

    openFiles([new File([await gzipLap(best)], 'best-lap.xlap.gz')]);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(within(rows()[0]).getByText(/my-lap\.xlap\.gz · valid/)).toBeInTheDocument();
    expect(screen.getByTestId('final-gap')).toHaveTextContent(/^\+0\.3\d\d s$/);
  });

  it('says which file is not a lap, and still reads the others', async () => {
    renderAnalysis();
    openFiles([new File(['not a lap'], 'notes.txt'), new File([await gzipLap(best)], 'good.xlap.gz')]);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByRole('alert')).toHaveTextContent('notes.txt: it is neither a lap nor a track layout file');
  });

  it('refuses more laps than it can hold, and says so', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => loaded(`lap-${i}`, i % 2 ? best : mine));
    renderAnalysis(twelve);
    openFiles([new File([await gzipLap(best)], 'one-more.xlap.gz')]);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Only 12 laps can be open at once.'));
    expect(rows()).toHaveLength(12);
  });
});

describe('the track layout', () => {
  const sample = { game: mine.header.game, name: mine.header.track.name };
  const layoutOfSample = (over: Partial<Parameters<typeof makeLayout>[0]> = {}) =>
    makeLayout({ points: circle(300, 80), width: 8, closed: true, ideal: true, game: sample.game, name: sample.name, ...over });

  it('is drawn under the lap when one is kept for the track, and the hint says what the colours are', async () => {
    const findLayout = vi.fn(async () => layoutOfSample());
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={findLayout} /></SettingsProvider>);
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(findLayout).toHaveBeenCalledWith(sample.game, sample.name, null);
    expect(screen.getByTestId('map-hint')).toHaveTextContent(/Red: the game’s ideal line/);
  });

  it('is not there when none is kept, and the hint says how to open one', async () => {
    const findLayout = vi.fn(async () => null);
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={findLayout} /></SettingsProvider>);
    await waitFor(() => expect(findLayout).toHaveBeenCalled());
    expect(screen.queryByTestId('track-layout')).not.toBeInTheDocument();
    expect(screen.getByTestId('map-hint')).toHaveTextContent(/\.xtrk/);
  });

  it('is read from a file a person opens, drawn, and handed on to be kept', async () => {
    const onLayoutFile = vi.fn();
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} onLayoutFile={onLayoutFile} /></SettingsProvider>);
    expect(screen.queryByTestId('track-layout')).not.toBeInTheDocument();
    openFiles([new File([await gzipBytes(packLayout(layoutOfSample()))], 'ring.xtrk.gz')]);
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(screen.getByTestId('layout-notice')).toHaveTextContent('Track layout opened: Sample Ring.');
    expect(onLayoutFile).toHaveBeenCalledTimes(1);
    expect(onLayoutFile.mock.calls[0][0].name).toBe('ring.xtrk.gz');
    expect(rows()).toHaveLength(1); // a layout is not a lap
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is read together with laps picked in the same go', async () => {
    renderAnalysis();
    openFiles([new File([await gzipLap(mine)], 'mine.xlap.gz'), new File([packLayout(layoutOfSample())], 'ring.xtrk')]);
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(rows()).toHaveLength(1);
  });

  // A layout whose ideal line is the line the sample lap drove.
  const onSampleLine = () =>
    makeLayout({ points: trackPath(mine, 2000)!.points, width: 8, closed: true, ideal: true, idealShift: 0, game: sample.game, name: sample.name });

  it('measures how far the lap was from the ideal line, and says when it never left it', async () => {
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine), loaded('best', best)]} findLayout={async () => onSampleLine()} /></SettingsProvider>);
    await waitFor(() => expect(screen.getByTestId('offset-chart')).toBeInTheDocument());
    expect(screen.getByTestId('off-line')).toHaveTextContent('The lap stayed within 1.5 m of the ideal line all the way round.');
    expect(screen.queryByTestId('layout-mismatch')).not.toBeInTheDocument();
  });

  it('lists where the lap kept off the ideal line, to which side and how far', async () => {
    // The same line, moved 4 m: the lap is 4 m to one side of it all the way round.
    const moved = makeLayout({ points: trackPath(mine, 2000)!.points, width: 12, closed: true, ideal: true, idealShift: 4, game: sample.game, name: sample.name });
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={async () => moved} /></SettingsProvider>);
    await waitFor(() => expect(screen.getByTestId('off-line')).toBeInTheDocument());
    const items = within(screen.getByTestId('off-line')).getAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toHaveTextContent(/up to \d\.\d m to the (left|right)/);
  });

  it('does not measure against a layout the lap is not on, and says so', async () => {
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={async () => layoutOfSample({ points: circle(3000, 80) })} /></SettingsProvider>);
    await waitFor(() => expect(screen.getByTestId('layout-mismatch')).toBeInTheDocument());
    expect(screen.queryByTestId('offset-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('off-line')).not.toBeInTheDocument();
  });

  it('zooms the map in on a stretch asked for', async () => {
    renderAnalysis([loaded('mine', mine), loaded('best', best)]);
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
    render(
      <SettingsProvider>
        <LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={async () => null} listKeptLayouts={async () => kept} linkLayout={linkLayout} />
      </SettingsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('no-layout')).toHaveTextContent(`No track layout is kept on this device for “${sample.name}”`));
    const select = await screen.findByTestId('pick-layout');
    // Only the layouts of the lap's game are offered.
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a layout', 'Other Ring']);
    fireEvent.change(select, { target: { value: 'u|sample|other ring|' } });
    await waitFor(() => expect(screen.getByTestId('track-layout')).toBeInTheDocument());
    expect(linkLayout).toHaveBeenCalledWith(sample.game, sample.name, null, 'u|sample|other ring|');
    expect(screen.queryByTestId('no-layout')).not.toBeInTheDocument();
  });

  it('is not used for a lap of another track', async () => {
    const findLayout = vi.fn(async () => null);
    render(<SettingsProvider><LapAnalysis initialLaps={[loaded('mine', mine)]} findLayout={findLayout} /></SettingsProvider>);
    openFiles([new File([packLayout(layoutOfSample({ name: 'Somewhere Else' }))], 'else.xtrk')]);
    await waitFor(() => expect(screen.getByTestId('layout-notice')).toBeInTheDocument());
    expect(screen.queryByTestId('track-layout')).not.toBeInTheDocument();
  });
});

describe('laps that cannot be compared', () => {
  it('says so, and draws no gap', () => {
    const elsewhere: LapFile = { ...best, header: { ...best.header, track: { name: 'Another Ring', lengthM: best.header.track.lengthM } } };
    renderAnalysis([loaded('mine', mine), loaded('other', elsewhere)]);
    expect(screen.getByTestId('different-tracks')).toBeInTheDocument();
    expect(screen.queryByTestId('final-gap')).not.toBeInTheDocument();
    expect(screen.queryByTestId('time-changes')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('chart')).toHaveLength(3); // speed, throttle and brake of the lap alone
  });
});
