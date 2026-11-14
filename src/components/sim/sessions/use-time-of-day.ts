import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '@/contexts/SettingsContext';

/** The time of day of a moment in the person's language and time zone (the day is the heading the row sits under). */
export function useTimeOfDay() {
  const { i18n } = useTranslation();
  const { timezone } = useSettings();
  return useCallback((ms: number) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { timeStyle: 'short', timeZone: timezone }).format(ms);
    } catch {
      return new Date(ms).toISOString().slice(11, 16);
    }
  }, [i18n.resolvedLanguage, timezone]);
}
