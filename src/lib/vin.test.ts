import { describe, it, expect } from 'vitest';
import { isValidVin, vinFitsCar, vinMake, vinYear } from './vin';

describe('VIN', () => {
  const now = new Date(2026, 9, 28);

  it('checks the format (17 characters, no I, O or Q)', () => {
    expect(isValidVin('JTDKN3DU5A0123456')).toBe(true);
    expect(isValidVin('JTDKN3DU5A012345')).toBe(false);
    expect(isValidVin('JTDKN3DU5A012345O')).toBe(false);
  });

  it('tells the maker from the first characters, in any country', () => {
    expect(vinMake('JTDKN3DU5A0123456')).toBe('Toyota'); // Japan
    expect(vinMake('9BWZZZ377VT004251')).toBe('Volkswagen'); // Brazil
    expect(vinMake('1HGCM82633A004352')).toBe('Honda'); // US
    expect(vinMake('ZZZ00000000000000')).toBeNull();
  });

  it('reads the model year, picking the latest 30-year cycle that is not in the future', () => {
    expect(vinYear('JTDKN3DU5A0123456', now)).toBe(2010);
    expect(vinYear('1HGCM82633A004352', now)).toBe(2003);
    expect(vinYear('9BWAG45U0LT000001', now)).toBe(2020); // L, Brazil
    expect(vinYear('XXXXXXXXXSXXXXXXX', now)).toBe(2025);
  });

  it('matches a VIN to a saved car only when maker and year agree', () => {
    const id = { vin: 'JTDKN3DU5A0123456', make: 'Toyota', model: null, year: 2010, trim: null, engineType: null, bodyType: null };
    expect(vinFitsCar(id, { make: 'Toyota', year: 2010 })).toBe(true);
    expect(vinFitsCar(id, { make: 'toyota', year: 2011 })).toBe(true);
    expect(vinFitsCar(id, { make: 'Honda', year: 2010 })).toBe(false);
    expect(vinFitsCar(id, { make: null, year: null })).toBe(true);
  });
});
