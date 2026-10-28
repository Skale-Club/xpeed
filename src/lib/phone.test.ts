import { describe, it, expect } from 'vitest';
import { formatPhone, maskPhoneInput, normalizePhone, phoneCountryCodeFromLocales } from './phone';

describe('phone numbers for sign-in', () => {
  it('turns what people type into E.164', () => {
    expect(normalizePhone('(11) 98765-4321', '55')).toBe('+5511987654321');
    expect(normalizePhone('(508) 555-0100', '1')).toBe('+15085550100');
    expect(normalizePhone('+351 912 345 678', '55')).toBe('+351912345678');
    expect(normalizePhone('1234', '55')).toBeNull();
    expect(normalizePhone('abc', '1')).toBeNull();
    expect(normalizePhone('508 555 010', '1')).toBeNull(); // US numbers have 10 digits
  });

  it('formats as it is typed and for display', () => {
    expect(maskPhoneInput('11987654321', '55')).toBe('(11) 98765-4321');
    expect(maskPhoneInput('1134567890', '55')).toBe('(11) 3456-7890');
    expect(maskPhoneInput('5085550100', '1')).toBe('(508) 555-0100');
    expect(maskPhoneInput('5085', '1')).toBe('(508) 5');
    expect(maskPhoneInput('5512345678', '52')).toBe('55 1234 5678');
    expect(maskPhoneInput('2221234567', '52')).toBe('222 123 4567');
    expect(maskPhoneInput('3001234567', '57')).toBe('300 123 4567');
    expect(maskPhoneInput('912345678999', '351')).toBe('912 345 678');
    expect(maskPhoneInput('612345678', '34')).toBe('612 34 56 78');
    expect(maskPhoneInput('44 20 7946', '44')).toBe('44207946');

    expect(formatPhone('+15085550100')).toBe('+1 (508) 555-0100');
    expect(formatPhone('+5511987654321')).toBe('+55 (11) 98765-4321');
    expect(formatPhone('+551134567890')).toBe('+55 (11) 3456-7890');
    expect(formatPhone('+525512345678')).toBe('+52 55 1234 5678');
    expect(formatPhone('+573001234567')).toBe('+57 300 123 4567');
    expect(formatPhone('+351912345678')).toBe('+351 912 345 678');
    expect(formatPhone('+34612345678')).toBe('+34 612 34 56 78');
    expect(formatPhone('+442079460000')).toBe('+442079460000'); // no pattern: as it is
  });

  it('picks the country from the language', () => {
    expect(phoneCountryCodeFromLocales(['pt-BR', 'en-US'])).toBe('55');
    expect(phoneCountryCodeFromLocales(['es'])).toBe('34');
    expect(phoneCountryCodeFromLocales([])).toBe('1');
  });
});
