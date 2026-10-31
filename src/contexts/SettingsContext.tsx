import { createContext, type Context, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { PREFERENCES_KEY, readPreferences, persistPreferences, type Preferences } from '@/lib/preferences';

type SettingsContextType = Preferences & {
  savePreferences: (next: Preferences) => void;
  setVolumeUnit: (unit: Preferences['volumeUnit']) => void;
  setConsumptionUnit: (unit: Preferences['consumptionUnit']) => void;
  setCurrency: (currency: Preferences['currency']) => void;
  setTemperatureUnit: (unit: Preferences['temperatureUnit']) => void;
  setDistanceUnit: (unit: Preferences['distanceUnit']) => void;
  setTimezone: (timezone: string) => void;
  setAdvancedTools: (on: boolean) => void;
};

// Keep the provider identity stable during development hot reloads.
const SettingsContext: Context<SettingsContextType | undefined> =
  import.meta.hot?.data.SettingsContext ?? createContext<SettingsContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.SettingsContext = SettingsContext;

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const current = useRef(preferences);
  useEffect(() => {
    // Freeze the legacy fuel display once, before a later distance change.
    try {
      if (!localStorage.getItem(PREFERENCES_KEY)) localStorage.setItem(PREFERENCES_KEY, JSON.stringify(current.current));
      if (!localStorage.getItem('settings_volumeUnit')) localStorage.setItem('settings_volumeUnit', current.current.volumeUnit);
      if (!localStorage.getItem('settings_consumptionUnit')) localStorage.setItem('settings_consumptionUnit', current.current.consumptionUnit);
    } catch { /* In-memory preferences still work when storage is unavailable. */ }
  }, []);
  const savePreferences = (next: Preferences) => {
    persistPreferences(next); // A failed write leaves every in-memory choice unchanged.
    current.current = next;
    setPreferences(next);
  };
  const patch = (next: Partial<Preferences>) => savePreferences({...current.current, ...next});
  return <SettingsContext.Provider value={{...preferences, savePreferences,
    setVolumeUnit: volumeUnit => patch({volumeUnit}), setConsumptionUnit: consumptionUnit => patch({consumptionUnit}),
    setCurrency: currency => patch({currency}), setTemperatureUnit: temperatureUnit => patch({temperatureUnit}),
    setDistanceUnit: distanceUnit => patch({distanceUnit}), setTimezone: timezone => patch({timezone}),
    setAdvancedTools: advancedTools => patch({advancedTools})}}>{children}</SettingsContext.Provider>;
}
export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) throw new Error('useSettings must be used within a SettingsProvider');
  return context;
}
