import { expect, it } from 'vitest';
import { temperatureLabel, temperatureValue } from './temperature';
it('converts readings and limits in both directions without changing other units', () => {
  expect(temperatureValue(0, '°C', 'F')).toBe(32);
  expect(temperatureValue(100, '°C', 'F')).toBe(212);
  expect(temperatureValue(-40, '°C', 'F')).toBe(-40);
  expect(temperatureValue(212, '°F', 'C')).toBe(100);
  expect(temperatureValue(12.4, 'V', 'F')).toBe(12.4);
  expect(temperatureValue(83, '°C', 'C')).toBe(83);
  expect(temperatureLabel('°C', 'F')).toBe('°F');
  expect(temperatureLabel('%', 'F')).toBe('%');
});
