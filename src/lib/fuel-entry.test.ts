import { expect, it } from 'vitest';
import { parseFuelNumber } from './fuel-entry';
it('accepts decimal keyboard values with a dot or comma without changing their magnitude', () => {
  expect(parseFuelNumber('35,90')).toBe(35.9);
  expect(parseFuelNumber('10.25')).toBe(10.25);
  expect(parseFuelNumber(',5')).toBe(0.5);
  expect(parseFuelNumber('35.')).toBe(35);
  expect(parseFuelNumber('1,234.56')).toBeNaN();
  expect(parseFuelNumber('')).toBeNaN();
  expect(parseFuelNumber('-1')).toBeNaN();
  expect(parseFuelNumber('one')).toBeNaN();
});
