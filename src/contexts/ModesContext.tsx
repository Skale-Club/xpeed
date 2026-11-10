import { createContext, useContext, useEffect, useMemo, useState, type Context, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import {
  currentMode, modeOfPath, readModes, rememberMode, rememberModeRoute, virtualBuildEnabled, writeModes, type Mode,
} from '@/lib/modes';

type ModesContextType = {
  /** The modes this person has: Real first, never empty. */
  modes: Mode[];
  /** The mode of the screen being shown. */
  mode: Mode;
  /** The switch between modes exists only for someone who has both. */
  hasBoth: boolean;
  /** Whether Virtual can be chosen at all in this build. */
  virtualAvailable: boolean;
  setModes: (next: readonly Mode[]) => void;
};

// Without the provider the app is plain Real, which is what it always was.
const REAL_ONLY: ModesContextType = { modes: ['real'], mode: 'real', hasBoth: false, virtualAvailable: false, setModes: () => undefined };

// Keep the provider identity stable during development hot reloads.
const ModesContext: Context<ModesContextType> =
  import.meta.hot?.data.ModesContext ?? createContext<ModesContextType>(REAL_ONLY);
if (import.meta.hot) import.meta.hot.data.ModesContext = ModesContext;

export function ModesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { pathname, search } = useLocation();
  const stored = useMemo(() => readModes(userId), [userId]);
  const [chosen, setChosen] = useState<{ userId: string | null; modes: Mode[] } | null>(null);
  const modes = chosen && chosen.userId === userId ? chosen.modes : stored;
  const mode = currentMode(modes, pathname);

  // The last mode and the last screen of each mode, so the switch brings you back where you were.
  // With one mode there is nothing to come back to, so nothing is written: the app stays as it was.
  useEffect(() => {
    if (modes.length < 2) return;
    const own = modeOfPath(pathname);
    if (!own || !modes.includes(own)) return;
    rememberMode(own);
    rememberModeRoute(own, `${pathname}${search}`);
  }, [pathname, search, modes]);

  const value = useMemo<ModesContextType>(() => ({
    modes,
    mode,
    hasBoth: modes.length > 1,
    virtualAvailable: virtualBuildEnabled(),
    setModes: (next) => setChosen({ userId, modes: writeModes(userId, next) }),
  }), [modes, mode, userId]);

  return <ModesContext.Provider value={value}>{children}</ModesContext.Provider>;
}

export function useModes(): ModesContextType {
  return useContext(ModesContext);
}
