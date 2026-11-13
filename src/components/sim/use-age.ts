import { useTranslation } from 'react-i18next';

/** "3 minutes ago" in the person's language, from how old (ms) something is. */
export function useAge() {
  const { i18n } = useTranslation();
  return (updatedAt: number, now = Date.now()) => {
    const minutes = Math.max(0, Math.round((now - updatedAt) / 60_000));
    try {
      const format = new Intl.RelativeTimeFormat(i18n.resolvedLanguage || 'en', { numeric: 'auto' });
      if (minutes < 60) return format.format(-minutes, 'minute');
      if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), 'hour');
      return format.format(-Math.round(minutes / (60 * 24)), 'day');
    } catch {
      return new Date(updatedAt).toISOString();
    }
  };
}
