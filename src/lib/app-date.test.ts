import { afterEach, expect, it } from 'vitest';
import { appHour, formatAppDate, parseZonedDateTime, zonedDateTimeInput } from './app-date';

afterEach(() => localStorage.removeItem('settings_timezone'));
it('uses the selected zone for instants and the part of day', () => {
  const instant = new Date('2026-10-29T12:00:00Z');
  localStorage.setItem('settings_timezone', 'America/New_York');
  expect(appHour(instant)).toBe(8);
  localStorage.setItem('settings_timezone', 'Asia/Tokyo');
  expect(appHour(instant)).toBe(21);
  expect(formatAppDate(instant, 'en-GB', { hour: '2-digit', hourCycle: 'h23' })).toBe('21');
});
it('ignores an invalid saved zone rather than crashing a page', () => {
  localStorage.setItem('settings_timezone', 'invalid zone');
  expect(() => formatAppDate(new Date(), 'en', { dateStyle: 'short' })).not.toThrow();
});

it('round-trips fuel times using the selected zone rather than the device zone', () => {
  const at = new Date('2026-10-30T19:34:00Z');
  expect(zonedDateTimeInput(at,'America/New_York')).toBe('2026-10-30T15:34');
  expect(parseZonedDateTime('2026-10-30T15:34','America/New_York')?.toISOString()).toBe(at.toISOString());
  expect(parseZonedDateTime('2026-10-31T01:19','Asia/Kathmandu')?.toISOString()).toBe(at.toISOString());
});
it('rejects invalid dates and the spring DST gap, and selects the first repeated fall hour', () => {
  expect(parseZonedDateTime('2026-02-30T12:00','UTC')).toBeNull();
  expect(parseZonedDateTime('2026-03-08T02:30','America/New_York')).toBeNull();
  expect(parseZonedDateTime('2026-11-01T01:30','America/New_York')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
});
