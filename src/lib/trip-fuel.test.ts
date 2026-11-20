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
it('falls back to the air flow on petrol and hybrid cars only', () => {
  const air = (t: number, gs: number) => ({ t_seconds: t, data: { 'Mass air flow (g/s)': gs } });
  const rows = [air(0, 10), air(10, 10), air(20, 10)];
  expect(tripFuel(rows, [], 20, 'hybrid')).toMatchObject({ method: 'air_flow', coverage: 1 });
  expect(tripFuel(rows, [], 20, 'hybrid')!.litres).toBeCloseTo(10 / (14.7 * 745) * 20);
  expect(tripFuel(rows, [], 20, 'diesel')).toBeNull();
  expect(tripFuel(rows, [], 20)).toBeNull();
  expect(tripFuel([row(0, 6), row(30, 6)], [], 30, 'hybrid')?.method).toBe('fuel_rate');
});
