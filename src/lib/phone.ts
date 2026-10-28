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

/** "+15085550100" → "+1 (508) 555-0100"; "+5511987654321" → "+55 11 98765-4321". */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (us) return `+1 (${us[1]}) ${us[2]}-${us[3]}`;
  const br = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  if (br) return `+55 ${br[1]} ${br[2]}-${br[3]}`;
  return e164;
}

/** Format digits as they are typed: (508) 555-0100 for +1, (11) 98765-4321 for +55. */
export function maskPhoneInput(value: string, countryCode: string): string {
  const digits = value.replace(/\D/g, '').slice(0, countryCode === '55' ? 11 : countryCode === '1' ? 10 : 15);
  const group = (_m: string, a: string, b: string, c: string) => (b ? `(${a}) ${b}${c ? `-${c}` : ''}` : a);
  if (countryCode === '1') return digits.replace(/^(\d{0,3})(\d{0,3})(\d{0,4}).*/, group);
  if (countryCode === '55') return digits.replace(/^(\d{0,2})(\d{0,5})(\d{0,4}).*/, group);
  return digits;
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
