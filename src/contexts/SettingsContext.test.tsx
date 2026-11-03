import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsProvider, useSettings } from './SettingsContext';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it('validates stored units and timezones before exposing them', () => {
  localStorage.setItem('settings_distanceUnit', 'yards');
  localStorage.setItem('settings_timezone', 'invalid/zone');
  const { result } = renderHook(useSettings, { wrapper: SettingsProvider });
  expect(result.current.distanceUnit).toBe('km');
  expect(() => new Intl.DateTimeFormat('en', { timeZone: result.current.timezone })).not.toThrow();
  act(() => result.current.setTimezone('invalid/zone'));
  expect(result.current.timezone).not.toBe('invalid/zone');
});

it('keeps preferences working when browser storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  const { result } = renderHook(useSettings, { wrapper: SettingsProvider });
  act(() => {
    result.current.setDistanceUnit('mi');
    result.current.setTimezone('UTC');
    result.current.setAdvancedTools(true);
  });
  expect(result.current).toMatchObject({ distanceUnit: 'mi', timezone: 'UTC', advancedTools: true });
});
