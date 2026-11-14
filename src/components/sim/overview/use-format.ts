import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

/** Formats what the dashboard shows in the person's language. Days are UTC dates and are written as such, whatever the time zone (a UTC midnight is the evening before in the Americas). */
export function useDashFormat() {
  const { i18n } = useTranslation();
  const lang = i18n.resolvedLanguage || 'en';
  const number = useCallback((value: number) => {
    try {
      return new Intl.NumberFormat(lang).format(value);
    } catch {
      return String(value);
    }
  }, [lang]);
  const day = useCallback((value: string, style: 'short' | 'long' = 'short') => {
    const at = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(at)) return value;
    try {
      return new Intl.DateTimeFormat(lang, style === 'long' ? { dateStyle: 'medium', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at);
    } catch {
      return value;
    }
  }, [lang]);
  const month = useCallback((index: number, year: number) => {
    try {
      return new Intl.DateTimeFormat(lang, { month: 'short', timeZone: 'UTC' }).format(Date.UTC(year, index, 1));
    } catch {
      return String(index + 1);
    }
  }, [lang]);
  return useMemo(() => ({ lang, number, day, month }), [lang, number, day, month]);
}
