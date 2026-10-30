import type { ConsumptionUnit, Currency, VolumeUnit } from './fuel-units';
import type { TemperatureUnit } from './temperature';

export const PREFERENCES_KEY = 'xpeed.preferences.v1';
export interface Preferences {
  distanceUnit: 'km' | 'mi'; volumeUnit: VolumeUnit; consumptionUnit: ConsumptionUnit;
  currency: Currency; temperatureUnit: TemperatureUnit; timezone: string; advancedTools: boolean;
}
/** The canonical record is committed in one write. Legacy keys are read on migration only. */
export function readPreference(key: keyof Preferences): string | null {
  try {
    let saved: Record<string, unknown> | null = null;
    try { saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || 'null'); } catch { /* Recover legacy keys if the record is damaged. */ }
    if (saved && (typeof saved[key] === 'string' || typeof saved[key] === 'boolean')) return String(saved[key]);
    return localStorage.getItem(`settings_${key}`);
  } catch { return null; }
}
export function readPreferences(): Preferences {
  const distanceUnit = readPreference('distanceUnit') === 'mi' ? 'mi' : 'km';
  const volume = readPreference('volumeUnit'), consumption = readPreference('consumptionUnit'), currency = readPreference('currency');
  let timezone = readPreference('timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try { new Intl.DateTimeFormat('en', {timeZone:timezone}).format(); } catch { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
  return {distanceUnit, volumeUnit: volume === 'L' || volume === 'US gal' ? volume : distanceUnit === 'mi' ? 'US gal' : 'L',
    consumptionUnit: consumption === 'MPG' || consumption === 'km/L' || consumption === 'L/100km' ? consumption : distanceUnit === 'mi' ? 'MPG' : 'km/L',
    currency: currency === 'EUR' || currency === 'BRL' ? currency : 'USD',
    temperatureUnit: readPreference('temperatureUnit') === 'F' ? 'F' : 'C', timezone, advancedTools: readPreference('advancedTools') === 'true'};
}
export function persistPreferences(next: Preferences) {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
  // Compatibility for older clients. Failure here cannot undo the canonical commit.
  for (const [key, value] of Object.entries(next)) {
    try { localStorage.setItem(`settings_${key}`, String(value)); } catch { /* canonical record is durable */ }
  }
}
