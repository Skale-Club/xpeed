import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatGrid, StatTile } from './stat-tile';

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
