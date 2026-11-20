import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AreaSparkline, ChartLegend } from './chart-kit';
import { ACCENT_TOKEN, CHART_BAR, CHART_GRID, CHART_LINE, accentColor, sparkPoints } from '@/lib/chart-theme';
import { TrendChip } from './trend-chip';
import { COLOR_TOKENS } from '@/lib/design-tokens';

afterEach(cleanup);

const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8');
const tailwind = readFileSync(resolve(__dirname, '../../../tailwind.config.ts'), 'utf8');

describe('Dashboards 2027 tokens (proposed 2026-11-20, pending the owner)', () => {
  it('declares the inset surface, the display face and the panel corner', () => {
    expect(css).toContain('--surface-inset: 225 9% 9%;');
    expect(css).toContain('family=Chakra+Petch');
    expect(tailwind).toContain("display: ['Chakra Petch'");
    expect(tailwind).toContain('panel: "1rem"');
  });

  it('keeps the brand and the page colour as they are', () => {
    expect(css).toContain('--primary: 54 88% 67%;');
    expect(css).toContain('--background: 225 8% 7%;');
  });
});

describe('chart-kit', () => {
  it('reads every accent from a chart token, yellow being the brand', () => {
    for (const token of Object.values(ACCENT_TOKEN)) expect(COLOR_TOKENS).toHaveProperty(token);
    expect(accentColor('yellow')).toBe(`hsl(${COLOR_TOKENS.brand})`);
    expect(accentColor('blue', 0.14)).toBe(`hsl(${COLOR_TOKENS['chart-2']} / 0.14)`);
  });

  it('pins the chart look: no dot on each value, 2 px lines, rounded bar tops, horizontal grid only', () => {
    expect(CHART_LINE).toMatchObject({ dot: false, strokeWidth: 2 });
    expect(CHART_BAR.radius).toEqual([4, 4, 0, 0]);
    expect(CHART_GRID.vertical).toBe(false);
  });

  it('draws a sparkline across the box, last point at the right edge', () => {
    const path = sparkPoints([0, 5, 10], 100, 50, 0);
    expect(path.line).toBe('M0.0 50.0 L50.0 25.0 L100.0 0.0');
    expect(path.last).toEqual({ x: 100, y: 0 });
    expect(sparkPoints([], 100, 50).line).toBe('');
    expect(sparkPoints([3], 100, 50).last).toEqual({ x: 100, y: 25 });
  });

  it('renders the sparkline with its area and the legend as chips', () => {
    render(<><AreaSparkline values={[1, 3, 2]} color="red" /><ChartLegend items={[{ label: 'Laps', color: 'blue' }, { label: 'Cut-off', color: 'red', dashed: true }]} testId="legend" /></>);
    expect(screen.getByTestId('area-sparkline').querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('legend').querySelectorAll('li')).toHaveLength(2);
    expect(screen.getByText('Cut-off')).toBeInTheDocument();
  });
});

describe('TrendChip', () => {
  it('shows the short text, says the sentence to screen readers and colours by meaning', () => {
    render(<TrendChip direction="down" text="0.61 s" label="0.61 s faster" meaning="good" testId="t" />);
    const chip = screen.getByTestId('t');
    expect(chip).toHaveTextContent('0.61 s');
    expect(chip).toHaveClass('text-success');
    expect(chip).toHaveAttribute('data-trend', 'down');
    expect(screen.getByText('0.61 s faster')).toHaveClass('sr-only');
  });
});
