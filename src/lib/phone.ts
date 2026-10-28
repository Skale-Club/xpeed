// Phone numbers as the sign-in identity, in E.164 ("+5511987654321").
// Same rules as Xpot's sign-in (shared/phone.ts, shared/phoneCountry.ts there),
// so both apps read and show numbers the same way.

export const DEFAULT_COUNTRY_CODE = '1';

/** Country codes offered in the sign-in screen (others can be typed with +). `iso` picks the flag. */
export const PHONE_COUNTRIES = [
  { code: '1', label: 'US/CA', iso: 'US' },
  { code: '55', label: 'BR', iso: 'BR' },
  { code: '52', label: 'MX', iso: 'MX' },
  { code: '57', label: 'CO', iso: 'CO' },
  { code: '351', label: 'PT', iso: 'PT' },
  { code: '34', label: 'ES', iso: 'ES' },
] as const;

const COUNTRY_DIAL_CODES: Record<string, string> = { US: '1', CA: '1', BR: '55', MX: '52', CO: '57', PT: '351', ES: '34' };
const LANGUAGE_DEFAULT_COUNTRIES: Record<string, string> = { en: 'US', pt: 'BR', es: 'ES' };

/**
 * E.164 from what a person types, or null when it can't be a phone number.
 * `countryCode` is used when the input has no leading "+" (digits only).
 */
export function normalizePhone(input: string | null | undefined, countryCode: string = DEFAULT_COUNTRY_CODE): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  // Only digits, spaces and the usual separators; no letters.
  if (!/^\+?[\d\s().-]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  const cc = countryCode.replace(/\D/g, '');
  let e164: string;
  if (raw.startsWith('+')) e164 = `+${digits}`;
  else if (raw.startsWith('00')) e164 = `+${digits.slice(2)}`;
  else if (cc === '1' && digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  else e164 = `+${cc}${digits}`;
  // E.164: up to 15 digits; nothing real is shorter than 8.
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  // North American numbers are exactly +1 and 10 digits.
  if (e164.startsWith('+1') && e164.length !== 12) return null;
  return e164;
}

// How each offered country writes its numbers; X is a digit. Brazil has
// 10-digit landlines and 11-digit mobiles; Mexico City, Guadalajara and
// Monterrey use 2-digit area codes, the rest of Mexico 3.
const MX_SHORT_AREAS = /^(33|55|56|81)/;

function nationalPattern(countryCode: string, digits: string): string | null {
  switch (countryCode) {
    case '1': return '(XXX) XXX-XXXX';
    case '55': return digits.length > 10 ? '(XX) XXXXX-XXXX' : '(XX) XXXX-XXXX';
    case '52': return MX_SHORT_AREAS.test(digits) ? 'XX XXXX XXXX' : 'XXX XXX XXXX';
    case '57': return 'XXX XXX XXXX';
    case '351': return 'XXX XXX XXX';
    case '34': return 'XXX XX XX XX';
    default: return null;
  }
}

/** Longest digit count a country's numbers have (15 for countries without a pattern). */
function maxDigits(countryCode: string): number {
  return countryCode === '55' ? 11 : (nationalPattern(countryCode, '')?.split('X').length ?? 16) - 1;
}

/** Lay the digits typed so far onto the pattern; separators only appear once a digit follows. */
function fill(pattern: string, digits: string): string {
  let out = '';
  let i = 0;
  for (const ch of pattern) {
    if (i >= digits.length) break;
    out += ch === 'X' ? digits[i++] : ch;
  }
  return out;
}

const DIAL_CODES = [...new Set(Object.values(COUNTRY_DIAL_CODES))].sort((a, b) => b.length - a.length);

/**
 * For display, in each country's usual way: "+1 (508) 555-0100",
 * "+55 (11) 98765-4321", "+351 912 345 678", "+34 612 34 56 78".
 * Numbers from other countries, or that don't fit, stay as they are.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/\D/g, '');
  const cc = DIAL_CODES.find((code) => digits.startsWith(code));
  if (!cc) return e164;
  const national = digits.slice(cc.length);
  const pattern = nationalPattern(cc, national);
  if (!pattern || pattern.split('X').length - 1 !== national.length) return e164;
  return `+${cc} ${fill(pattern, national)}`;
}

const EXAMPLES: Record<string, string> = {
  '1': '5085550100', '55': '11987654321', '52': '5512345678', '57': '3001234567', '351': '912345678', '34': '612345678',
};

/** A sample number in the country's format, for the input's placeholder. */
export function phoneExample(countryCode: string): string {
  return EXAMPLES[countryCode] ? maskPhoneInput(EXAMPLES[countryCode], countryCode) : '';
}

/** Format digits as they are typed: (508) 555-0100 for +1, (11) 98765-4321 for +55, 912 345 678 for +351… */
export function maskPhoneInput(value: string, countryCode: string): string {
  const digits = value.replace(/\D/g, '').slice(0, maxDigits(countryCode));
  const pattern = nationalPattern(countryCode, digits);
  return pattern ? fill(pattern, digits) : digits;
}

function dialCodeFromIso(countryIso: string | null | undefined): string | null {
  if (!countryIso) return null;
  return COUNTRY_DIAL_CODES[countryIso.trim().toUpperCase()] ?? null;
}

/** Picks a dial code from the browser's language preferences ("pt-BR" → 55). */
export function phoneCountryCodeFromLocales(locales: readonly string[]): string {
  for (const locale of locales) {
    const normalized = locale?.trim().replace('_', '-');
    if (!normalized) continue;
    try {
      const code = dialCodeFromIso(new Intl.Locale(normalized).region);
      if (code) return code;
    } catch {
      // Malformed locale entry: try the next one.
    }
  }
  for (const locale of locales) {
    const language = locale?.trim().toLowerCase().split(/[-_]/)[0];
    const code = dialCodeFromIso(LANGUAGE_DEFAULT_COUNTRIES[language]);
    if (code) return code;
  }
  return DEFAULT_COUNTRY_CODE;
}
