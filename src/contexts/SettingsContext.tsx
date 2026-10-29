import { createContext, type Context, useContext, useState, ReactNode } from 'react';

type DistanceUnit = 'km' | 'mi';

interface SettingsContextType {
  distanceUnit: DistanceUnit;
  timezone: string;
  setDistanceUnit: (unit: DistanceUnit) => void;
  setTimezone: (timezone: string) => void;
  /** Show technical tools (Scanner, terminal, custom PIDs, developer integrations). */
  advancedTools: boolean;
  setAdvancedTools: (on: boolean) => void;
}

// Same context object when the dev server reloads this file: otherwise screens
// reloaded with it look for a provider that is no longer the one on screen.
const SettingsContext: Context<SettingsContextType | undefined> =
  import.meta.hot?.data.SettingsContext ?? createContext<SettingsContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.SettingsContext = SettingsContext;

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [distanceUnit, setDistanceUnitState] = useState<DistanceUnit>(() => {
    try { return localStorage.getItem('settings_distanceUnit') === 'mi' ? 'mi' : 'km'; } catch { return 'km'; }
  });
  const [timezone, setTimezoneState] = useState<string>(() => {
    try { return localStorage.getItem('settings_timezone') || Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  });
  const [advancedTools, setAdvancedToolsState] = useState<boolean>(() => {
    try { return localStorage.getItem('settings_advancedTools') === 'true'; } catch { return false; }
  });

  const setDistanceUnit = (unit: DistanceUnit) => {
    localStorage.setItem('settings_distanceUnit', unit);
    setDistanceUnitState(unit);
  };

  const setTimezone = (tz: string) => {
    localStorage.setItem('settings_timezone', tz);
    setTimezoneState(tz);
  };

  const setAdvancedTools = (on: boolean) => {
    localStorage.setItem('settings_advancedTools', String(on));
    setAdvancedToolsState(on);
  };

  return (
    <SettingsContext.Provider value={{ distanceUnit, timezone, setDistanceUnit, setTimezone, advancedTools, setAdvancedTools }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
