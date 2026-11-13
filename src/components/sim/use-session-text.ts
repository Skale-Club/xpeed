import { useTranslation } from 'react-i18next';
import { useSettings } from '@/contexts/SettingsContext';
import { temperatureValue } from '@/lib/temperature';
import type { V1Session } from '@/lib/sim/v1-client';

const WEATHER_WORDS = ['dry', 'wet', 'rain', 'cloudy', 'overcast', 'mixed', 'night', 'snow', 'fog'];

/** "Dry · air 24 °C · track 31 °C", only with what the game said; null when it said nothing. */
export function useConditions() {
  const { t } = useTranslation();
  const { temperatureUnit } = useSettings();
  return (session: Pick<V1Session, 'weather' | 'airTempC' | 'trackTempC'>): string | null => {
    const unit = temperatureUnit === 'F' ? 'F' : 'C';
    const degrees = (celsius: number) => `${Math.round(temperatureValue(celsius, '°C', unit))} °${unit}`;
    const parts: string[] = [];
    if (session.weather) {
      const word = session.weather.toLowerCase();
      parts.push(WEATHER_WORDS.includes(word) ? t(`modes.weather.${word}`, session.weather) : session.weather);
    }
    if (session.airTempC !== null) parts.push(t('modes.sessions.airTemp', 'air {{value}}', { value: degrees(session.airTempC) }));
    if (session.trackTempC !== null) parts.push(t('modes.sessions.trackTemp', 'track {{value}}', { value: degrees(session.trackTempC) }));
    return parts.length > 0 ? parts.join(' · ') : null;
  };
}

/** Who made the session: Xpeed Companion told us its start and end, or Xpeed grouped the laps itself. */
export function useOrigin() {
  const { t } = useTranslation();
  return (origin: V1Session['origin']) =>
    origin === 'companion' ? t('modes.sessions.originCompanion', 'From Xpeed Companion') : t('modes.sessions.originInferred', 'Grouped by Xpeed');
}
