import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { circle, makeLayout } from '@/test/track-fixture';
import { NoResults, SearchField, StatTile, SummaryStrip, TileGrid, TileItem, TimeSparkline, ToggleChip, TrackShape } from './bits';

afterEach(cleanup);

describe('a tile', () => {
  it('shows the label, the value and the line under it', () => {
    render(<StatTile testId="x" label="Best valid lap" value="1:39.000" sub="Ferrari 499P" mono />);
    expect(screen.getByTestId('x-tile')).toHaveTextContent('Best valid lap');
    expect(screen.getByTestId('x')).toHaveTextContent('1:39.000');
    expect(screen.getByTestId('x').className).toMatch(/font-mono/);
    expect(screen.getByTestId('x-sub')).toHaveTextContent('Ferrari 499P');
  });
  it('shows a skeleton in place of the value while the number is being worked out, never a zero', () => {
    render(<StatTile testId="x" label="Time driven" value="0s" loading />);
    expect(screen.getByTestId('x-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('x')).not.toBeInTheDocument();
    expect(screen.getByTestId('x-tile')).not.toHaveTextContent('0s');
  });
  it('sits two across on a phone, three from small and six from extra large by default', () => {
    render(<TileGrid testId="grid"><TileItem><span>a</span></TileItem></TileGrid>);
    expect(screen.getByTestId('grid').className).toMatch(/grid-cols-2/);
    expect(screen.getByTestId('grid').className).toMatch(/sm:grid-cols-3/);
    expect(screen.getByTestId('grid').className).toMatch(/xl:grid-cols-6/);
  });
});

describe('the shape of a track', () => {
  it('draws the centre line and the start', () => {
    const { container } = render(<TrackShape layout={makeLayout({ points: circle(300, 80), width: 8 })} />);
    expect(screen.getByTestId('track-shape')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('polyline')?.getAttribute('points')?.split(' ')).toHaveLength(80);
    expect(container.querySelector('circle')).toBeInTheDocument();
  });
  it('thins a layout of many points, and never writes NaN or Infinity', () => {
    const layout = makeLayout({ points: circle(300, 1000), width: 8 });
    layout.centerline.x[10] = Number.NaN;
    layout.centerline.z[20] = Infinity;
    const { container } = render(<TrackShape layout={layout} />);
    const points = container.querySelector('polyline')!.getAttribute('points')!;
    expect(points).not.toMatch(/NaN|Infinity/);
    expect(points.split(' ').length).toBeLessThanOrEqual(400);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).not.toMatch(/NaN|Infinity/);
  });
  it('draws nothing for a layout with fewer than two usable points', () => {
    render(<TrackShape layout={makeLayout({ points: [[0, 0], [1, 1]] })} testId="two" />);
    expect(screen.getByTestId('two')).toBeInTheDocument();
    cleanup();
    const layout = makeLayout({ points: [[0, 0], [1, 1]] });
    layout.centerline.x[1] = Number.NaN;
    render(<TrackShape layout={layout} testId="one" />);
    expect(screen.queryByTestId('one')).not.toBeInTheDocument();
  });
});

describe('the lap-time sparkline', () => {
  it('draws a path of as many points as there are values', () => {
    const { container } = render(<TimeSparkline values={[102_000, 101_000, 100_000]} color="red" />);
    expect(screen.getByTestId('pb-spark')).toHaveAttribute('data-points', '3');
    expect(container.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(screen.getByTestId('pb-spark')).toHaveAttribute('aria-hidden', 'true');
  });
  it('is a dot for one value and nothing for none', () => {
    const { container } = render(<TimeSparkline values={[100_000]} color="red" />);
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelector('circle')).toBeInTheDocument();
    cleanup();
    const empty = render(<TimeSparkline values={[]} color="red" />);
    expect(empty.container.querySelector('path')).toBeNull();
    expect(empty.container.querySelector('circle')).toBeNull();
  });
});

describe('the controls of a list', () => {
  it('is a labelled search box that tells what was typed', () => {
    const onChange = vi.fn();
    render(<SearchField label="Search by name" value="" onChange={onChange} placeholder="Monza" testId="q" />);
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'spa' } });
    expect(onChange).toHaveBeenCalledWith('spa');
    expect(screen.getByTestId('q')).toHaveAttribute('type', 'search');
  });
  it('is a toggle that says whether it is on', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ToggleChip pressed={false} onChange={onChange} testId="t">Has a layout</ToggleChip>);
    expect(screen.getByRole('button', { name: 'Has a layout' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('t'));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<ToggleChip pressed onChange={onChange} testId="t">Has a layout</ToggleChip>);
    expect(screen.getByTestId('t')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('t'));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
  it('shows what the list adds up to and the way out of an empty result', () => {
    const onClear = vi.fn();
    render(<><SummaryStrip items={[{ id: 'a', label: 'Tracks', value: '5', sub: '2 with a layout' }]} /><NoResults testId="none" onClear={onClear} clearLabel="Clear the filters">Nothing</NoResults></>);
    expect(screen.getByTestId('summary-a-value')).toHaveTextContent('5');
    expect(screen.getByTestId('summary-a')).toHaveTextContent('2 with a layout');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the filters' }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe('the compact controls of a list toolbar', () => {
  it('has a search box that is small, has the magnifier inside it, takes a row on a phone and has no caption above', () => {
    const { container } = render(<SearchField label="Search by name" value="" onChange={() => {}} placeholder="Monza" testId="q" />);
    const input = screen.getByTestId('q');
    expect(input).toHaveClass('h-8', 'text-xs', 'focus-visible:ring-1');
    expect(input).not.toHaveClass('h-9');
    expect(input).toHaveAccessibleName('Search by name');
    expect(input.previousElementSibling?.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelector('label')).toBeNull();
    expect(container.firstElementChild).toHaveClass('basis-full', 'sm:flex-none', 'sm:w-52', 'min-w-0');
  });

  it('has a toggle that is the size of the drop-downs next to it (h-8, text-xs), with a thin focus ring, and sits two to a row on a phone', () => {
    render(<ToggleChip pressed={false} onChange={() => {}} testId="t">Has a layout</ToggleChip>);
    const toggle = screen.getByTestId('t');
    expect(toggle).toHaveClass('h-8', 'text-xs', 'focus-visible:ring-1', 'min-w-0', 'flex-1', 'sm:flex-none');
    expect(toggle).not.toHaveClass('h-9');
  });
});
