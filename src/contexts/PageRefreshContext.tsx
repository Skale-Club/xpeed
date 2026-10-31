import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCarsContext } from './CarsContext';

const PageRefreshContext = createContext({ revision: 0, refresh: async () => {} });

// Only the page remounts. The car selection and Bluetooth/recording providers stay alive.
export function PageRefreshProvider({ children }: { children: ReactNode }) {
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const { refresh: refreshCars } = useCarsContext();
  const queries = useQueryClient();
  const refresh = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      await Promise.all([refreshCars(), queries.invalidateQueries()]);
      setRevision((value) => value + 1);
    } finally { pending.current = false; }
  }, [refreshCars, queries]);
  return <PageRefreshContext.Provider value={{ revision, refresh }}>{children}</PageRefreshContext.Provider>;
}

export const usePageRefresh = () => useContext(PageRefreshContext);
