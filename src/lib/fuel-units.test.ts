import { expect, it } from 'vitest';
import { fuelEconomy, litresPerUnit } from './fuel-units';

it('converts one physical consumption independently to U.S. MPG and L/100km', () => {
  // 100 km on 5 L = 20 km/L = 5 L/100km = 47.0429 U.S. MPG.
  expect(fuelEconomy(20, 'MPG')).toBeCloseTo(47.0429, 4);
  expect(fuelEconomy(20, 'L/100km')).toBe(5);
  expect(fuelEconomy(20, 'km/L')).toBe(20);
  expect(10 * litresPerUnit('US gal')).toBeCloseTo(37.85411784, 8);
  expect(10 * litresPerUnit('L')).toBe(10);
});
it.each([null, undefined, 0, -1, NaN, Infinity])('does not invent economy for invalid input %s', value => {
  expect(fuelEconomy(value, 'MPG')).toBeNull();
  expect(fuelEconomy(value, 'L/100km')).toBeNull();
});
