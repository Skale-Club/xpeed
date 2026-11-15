import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { lazyChart } from './LazyChart';

it('shows a quiet block while the chart loads, then the chart with its props', async () => {
  const Chart = lazyChart(() => Promise.resolve({ default: ({ label }: { label: string }) => <p data-testid="the-chart">{label}</p> }));
  render(<Chart label="Lap times" />);
  expect(screen.getByTestId('chart-loading')).toBeInTheDocument();
  expect(await screen.findByTestId('the-chart')).toHaveTextContent('Lap times');
  expect(screen.queryByTestId('chart-loading')).not.toBeInTheDocument();
});
