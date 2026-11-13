import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettings } from '@/contexts/SettingsContext';

/** Formats a moment (epoch ms) in the person's language and time zone. */
export function useWhen(style: 'short' | 'date' = 'short') {
  const { i18n } = useTranslation();
  const { timezone } = useSettings();
  return useCallback(
    (ms: number) => {
      try {
        return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', {
          dateStyle: 'medium',
          ...(style === 'short' ? { timeStyle: 'short' as const } : {}),
          timeZone: timezone,
        }).format(ms);
      } catch {
        return new Date(ms).toISOString();
      }
    },
    [i18n.resolvedLanguage, timezone, style],
  );
}
