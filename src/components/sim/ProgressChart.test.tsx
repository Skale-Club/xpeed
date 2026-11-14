import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import i18n from '@/lib/i18n';
import type { ProgressRow } from '@/lib/sim/progress';
import { ProgressChart } from './ProgressChart';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ComposedChart: ({ data, children }: { data: unknown[]; children: ReactNode }) => <figure data-testid="chart" data-rows={JSON.stringify(data)}>{children}</figure>,
  Bar: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  Line: ({ dataKey }: { dataKey: string }) => <i data-testid="series" data-key={dataKey} />,
  XAxis: () => null, YAxis: ({ yAxisId }: { yAxisId?: string }) => <i data-testid="axis" data-axis={yAxisId} />, CartesianGrid: () => null, Tooltip: () => null,
}));

const day = (iso: string) => Date.parse(`${iso}T00:00:00.000Z`);
const row = (iso: string, bestS: number | null, laps = 4): ProgressRow => ({ day: iso, at: day(iso), bestS, lapId: bestS === null ? null : `lap-${iso}`, car: null, laps, validLaps: bestS === null ? 0 : laps });

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

describe('the progress chart', () => {
  it('draws the line and the bars from two days, and says in words what it shows', () => {
    render(<ProgressChart rows={[row('2026-11-01', 101), row('2026-11-05', 100.2), row('2026-11-10', 99.5)]} />);
    const figure = screen.getByTestId('chart');
    expect(within(figure).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps', 'bestS']);
    expect(within(figure).getAllByTestId('axis').map((axis) => axis.getAttribute('data-axis'))).toEqual(['best', 'laps']);
    const chart = screen.getByTestId('progress-chart-chart');
    expect(chart).toHaveAttribute('role', 'img');
    expect(chart.getAttribute('aria-label')).toBe('Best valid lap per day, from 1:41.000 on Nov 1 to 1:39.500 on Nov 10; the fastest is 1:39.500. 12 laps on 3 days.');
    expect(screen.getByTestId('progress-chart-summary')).toHaveTextContent('Best 1:39.500');
    expect(screen.getByTestId('progress-chart-summary')).toHaveTextContent('1.500 s faster since Nov 1');
    expect(screen.getByTestId('progress-chart-summary')).toHaveTextContent('12 laps on 3 days');
    expect(screen.queryByTestId('progress-chart-no-valid')).not.toBeInTheDocument();
  });

  it('does not claim a gain when the best lap did not improve', () => {
    render(<ProgressChart rows={[row('2026-11-01', 99), row('2026-11-05', 100)]} />);
    expect(screen.getByTestId('progress-chart-summary')).not.toHaveTextContent('faster since');
  });

  it('is one number and a message, not a chart, from a single day (a line needs two points)', () => {
    render(<ProgressChart rows={[row('2026-11-10', 99.5)]} />);
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('progress-chart-single')).toHaveTextContent('Only one day of driving so far');
    expect(screen.getByTestId('progress-chart-single')).toHaveTextContent('Best valid lap: 1:39.500');
  });

  it('says the game counted none of the laps of a single day, instead of drawing an empty chart', () => {
    render(<ProgressChart rows={[row('2026-11-10', null, 1)]} />);
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('progress-chart-no-valid')).toHaveTextContent('No valid lap yet');
  });

  it('draws only the bars, with no lap-time axis, and says why when several days have no valid lap', () => {
    render(<ProgressChart rows={[row('2026-11-09', null, 2), row('2026-11-10', null, 3)]} />);
    const figure = screen.getByTestId('chart');
    expect(within(figure).getAllByTestId('series').map((series) => series.getAttribute('data-key'))).toEqual(['laps']);
    expect(within(figure).getAllByTestId('axis').map((axis) => axis.getAttribute('data-axis'))).toEqual(['laps']);
    expect(screen.getByTestId('progress-chart-chart')).toHaveAttribute('aria-label', 'Laps per day: 5 laps on 2 days.');
    expect(screen.getByTestId('progress-chart-no-valid')).toBeInTheDocument();
    expect(screen.getByText('Laps per day')).toBeInTheDocument();
  });

  it('puts the controls it is given next to the title, and the note under the chart', () => {
    render(<ProgressChart rows={[row('2026-11-01', 101), row('2026-11-05', 100)]} controls={<button type="button">Pick a car</button>} note={<p>From your latest 500 laps</p>} title="Progress on Monza" />);
    expect(screen.getByText('Progress on Monza')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick a car' })).toBeInTheDocument();
    expect(screen.getByText('From your latest 500 laps')).toBeInTheDocument();
  });

  it('never writes NaN or Infinity, whatever the rows', () => {
    render(<ProgressChart rows={[row('2026-11-01', 101), row('2026-11-05', null, 0), row('2026-11-09', 100)]} />);
    expect(screen.getByTestId('progress-chart').textContent).not.toMatch(/NaN|Infinity|undefined/);
    expect(screen.getByTestId('progress-chart-chart').getAttribute('aria-label')).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('is written in Portuguese', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<ProgressChart rows={[row('2026-11-01', 101), row('2026-11-10', 99.5)]} />);
    expect(screen.getByTestId('progress-chart-chart').getAttribute('aria-label')).toMatch(/^Melhor volta válida por dia, de 1:41\.000 em /);
    expect(screen.getByTestId('progress-chart-summary')).toHaveTextContent('Melhor 1:39.500');
  });
});
