import { afterEach, expect, it } from 'vitest';
import { appHour, formatAppDate } from './app-date';

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
