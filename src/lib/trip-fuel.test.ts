import { expect, it } from 'vitest';
import { tripFuel } from './trip-fuel';
import { tripDayKey } from './trip-history';
const row = (t: number, rate: unknown) => ({ t_seconds: t, data: { 'Engine fuel rate (L/h)': rate } });
it('integrates recorded fuel flow including zero while driving electrically', () => {
  const result = tripFuel([row(0, 6), row(30, 6), row(60, 0)], [], 60);
  expect(result?.litres).toBeCloseTo(0.075);
  expect(result?.coverage).toBe(1);
});
it('does not extrapolate through missing data or long gaps', () => {
  const result = tripFuel([row(0, 6), row(30, 6), row(60, null), row(90, 6), row(300, 6)], [], 300);
  expect(result?.litres).toBeCloseTo(0.05);
  expect(result?.coverage).toBe(0.1);
  expect(tripFuel([row(0, null), row(30, null)], [], 30)).toBeNull();
});
it('uses civil days in the selected timezone, including midnight crossings', () => {
  expect(tripDayKey(new Date('2026-11-01T01:00:00Z'), 'America/New_York')).toBe('2026-10-31');
  expect(tripDayKey(new Date('2026-11-01T01:00:00Z'), 'UTC')).toBe('2026-11-01');
});
