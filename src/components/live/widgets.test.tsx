import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ValueWidget } from './widgets';
afterEach(cleanup);

it('uses a zero-centered scale for signed fuel corrections', () => {
  render(<ValueWidget label="Long term fuel trim" unit="%" value={-8} min={-25} max={25} />);
  expect(screen.getByRole('meter', { name: 'Long term fuel trim' })).toHaveAttribute('aria-valuenow', '-8');
  const scale = screen.getByTestId('centered-scale');
  const fill = scale.querySelector('.bg-primary') as HTMLElement;
  expect(parseFloat(fill.style.left)).toBeCloseTo(34);
  expect(parseFloat(fill.style.width)).toBeCloseTo(16);
});
it('uses a thermometer for temperature and preserves the measured unit', () => {
  render(<ValueWidget label="Intake air temperature" unit="°C" value={30} min={-40} max={100} />);
  const scale = screen.getByTestId('temperature-scale');
  expect(scale.querySelector('.bg-primary')).toHaveStyle({ height: '50%' });
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuemin', '-40');
});
it('shows voltage as a position within a range rather than a charge percentage', () => {
  render(<ValueWidget label="Battery voltage" unit="V" value={14} min={10} max={16} />);
  const scale = screen.getByTestId('voltage-scale');
  expect(scale.querySelector('.bg-primary')).toBeNull();
  expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '14');
});
it('does not invent a measurement when there is no reading', () => {
  render(<ValueWidget label="Engine load" unit="%" value={null} min={0} max={100} />);
  expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow');
  expect(screen.getByTestId('level-scale').querySelector('.bg-primary')).toBeNull();
});
