import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { isCoachEnabled, setCoachEnabled } from './coach-preferences';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it('defaults off and tracks opt-in separately for each account', () => {
  expect(isCoachEnabled('ana')).toBe(false);
  setCoachEnabled('ana', true);
  expect(isCoachEnabled('ana')).toBe(true);
  expect(isCoachEnabled('bia')).toBe(false);
  setCoachEnabled('bia', true);
  setCoachEnabled('ana', false);
  expect(isCoachEnabled('ana')).toBe(false);
  expect(isCoachEnabled('bia')).toBe(true);
});

it('defaults off when browser storage is blocked', () => {
  const blocked = () => { throw new Error('Storage is blocked'); };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked);
  expect(isCoachEnabled('ana')).toBe(false);
  expect(() => setCoachEnabled('ana', true)).not.toThrow();
  expect(() => setCoachEnabled('ana', false)).not.toThrow();
});
