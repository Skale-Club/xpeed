import { expect, it } from 'vitest';
import { findVehicleVisual, normalizeVehicleName, type VehicleVisual } from './vehicle-visuals';

const prius: VehicleVisual = { key: 'toyota-prius', make: 'Toyota', model: 'Prius', modelAliases: [], yearFrom: 2009, yearTo: 2015, modelPath: '/vehicle-visuals/toyota-prius.glb', posterPath: '/vehicle-visuals/toyota-prius.png', credit: { author: 'Doz3', sourceUrl: 'https://sketchfab.com', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', changes: 'Optimized for web' } };

it('normalizes accents and punctuation without matching substrings', () => {
  expect(normalizeVehicleName('  Toyota-Prius ')).toBe('toyotaprius');
  expect(findVehicleVisual([prius], { make: 'Toyota', model: 'Prius Prime', year: 2012 })).toBeUndefined();
});
it('matches only an exact make/model and an in-range known year', () => {
  expect(findVehicleVisual([prius], { make: 'TOYOTA', model: 'prius', year: 2010 })).toBe(prius);
  expect(findVehicleVisual([prius], { make: 'Toyota', model: 'Prius', year: null })).toBeUndefined();
  expect(findVehicleVisual([prius], { make: 'Toyota', model: 'Prius', year: 2016 })).toBeUndefined();
  expect(findVehicleVisual([prius], { make: 'Honda', model: 'Prius', year: 2010 })).toBeUndefined();
});
