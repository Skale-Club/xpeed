import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Flag } from 'lucide-react';
import { StatBento, StatGrid, StatTile } from './stat-tile';

afterEach(cleanup);

describe('StatTile', () => {
  it('shows the label, a monospaced tabular value and the hint', () => {
    render(<ul><StatTile label="Laps" value="128" hint="92% valid" testId="laps" /></ul>);
    expect(screen.getByText('Laps')).toBeInTheDocument();
    expect(screen.getByTestId('laps-value')).toHaveClass('font-mono', 'tabular-nums');
    expect(screen.getByText('92% valid')).toBeInTheDocument();
  });

  it('colours the value by tone', () => {
    render(<ul><StatTile label="Bests" value="3" tone="success" testId="b" /></ul>);
    expect(screen.getByTestId('b-value')).toHaveClass('text-success');
  });

  it('says the trend to screen readers and colours the arrow by meaning', () => {
    render(<ul><StatTile label="Time" value="4h" testId="t" trend={{ direction: 'up', label: '12% more than last week', meaning: 'good' }} /></ul>);
    expect(screen.getByText('12% more than last week')).toHaveClass('sr-only');
    const trend = screen.getByTestId('t-trend');
    expect(trend).toHaveAttribute('data-trend', 'up');
    expect(trend).toHaveClass('text-success');
  });

  it('defaults the trend to neutral and uses critical for bad', () => {
    render(<ul>
      <StatTile label="A" value="1" testId="a" trend={{ direction: 'flat', label: 'same' }} />
      <StatTile label="B" value="2" testId="b" trend={{ direction: 'down', label: 'less', meaning: 'bad' }} />
    </ul>);
    expect(screen.getByTestId('a-trend')).toHaveClass('text-muted-foreground');
    expect(screen.getByTestId('b-trend')).toHaveClass('text-critical');
  });
});

describe('StatGrid', () => {
  it('is a list that defaults to 2 / sm 3 / lg 6 columns', () => {
    render(<StatGrid testId="g"><StatTile label="A" value="1" /></StatGrid>);
    expect(screen.getByRole('list')).toHaveClass('grid-cols-2', 'sm:grid-cols-3', 'lg:grid-cols-6');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('takes other column counts', () => {
    render(<StatGrid columns={{ base: 1, sm: 2, lg: 4 }}><StatTile label="A" value="1" /></StatGrid>);
    expect(screen.getByRole('list')).toHaveClass('grid-cols-1', 'sm:grid-cols-2', 'lg:grid-cols-4');
  });
});

describe('StatTile, Dashboards 2027 sizes (proposed 2026-11-20)', () => {
  it('keeps the compact tile as the default', () => {
    render(<ul><StatTile label="Laps" value="6" testId="c" /></ul>);
    expect(screen.getByTestId('c')).not.toHaveAttribute('data-size');
    expect(screen.getByTestId('c-value')).toHaveClass('font-mono', 'text-xl');
  });

  it('draws the feature tile with the display face, the unit, an accent and the change as a chip', () => {
    render(<ul><StatTile size="feature" label="Time driven" value="11" unit="min" icon={Flag} accent="purple" testId="f"
      trend={{ direction: 'up', label: '327% more than the period before', text: '327%' }} /></ul>);
    const tile = screen.getByTestId('f');
    expect(tile).toHaveAttribute('data-size', 'feature');
    expect(tile).toHaveAttribute('data-accent', 'purple');
    expect(tile).toHaveClass('rounded-panel', 'p-5');
    const value = screen.getByTestId('f-value');
    expect(value).toHaveClass('font-display', 'tabular-nums', 'text-[30px]');
    expect(value).toHaveTextContent('11min');
    const chip = screen.getByTestId('f-trend');
    expect(chip).toHaveTextContent('327%');
    expect(chip).toHaveAttribute('data-meaning', 'neutral');
    expect(screen.getByText('327% more than the period before')).toHaveClass('sr-only');
  });

  it('makes the hero number 56 px and lets it span two rows of the bento', () => {
    render(<StatBento testId="b"><StatTile size="hero" label="Laps" value="6" testId="h" /></StatBento>);
    expect(screen.getByTestId('h-value')).toHaveClass('text-[56px]');
    expect(screen.getByRole('listitem')).toHaveClass('sm:row-span-2');
    expect(screen.getByTestId('b')).toHaveClass('lg:grid-cols-[1.35fr_1fr_1fr]');
  });

  it('shows a skeleton, never a zero, while loading', () => {
    render(<ul><StatTile size="feature" label="Laps" value="0" loading testId="l" /></ul>);
    expect(screen.getByTestId('l-value-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('l-value')).toBeNull();
  });
});
