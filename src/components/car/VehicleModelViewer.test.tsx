import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VehicleModelViewer } from './VehicleModelViewer';
import type { VehicleVisual } from '@/lib/vehicle-visuals';

vi.mock('@google/model-viewer', () => ({}));
const visual: VehicleVisual = { key: 'prius', make: 'Toyota', model: 'Prius', modelAliases: [], yearFrom: 2009, yearTo: 2015, modelPath: '/vehicle-visuals/prius.glb', posterPath: '/vehicle-visuals/prius.png', credit: { author: 'Doz3', sourceUrl: 'https://sketchfab.com', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Optimized' } };

it('provides accessible interactive controls and hides the model after a load error', () => {
  render(<VehicleModelViewer visual={visual} alt="2010 Toyota Prius" />);
  const model = screen.getByTestId('vehicle-model');
  expect(model).toHaveAttribute('camera-controls', '');
  expect(model).toHaveAttribute('touch-action', 'pan-y');
  expect(model).toHaveAttribute('alt', '2010 Toyota Prius');
  fireEvent(model, new Event('error'));
  expect(screen.queryByTestId('vehicle-model')).toBeNull();
});
