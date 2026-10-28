import React, { createContext, useContext, ReactNode } from 'react';
import { useCars } from '@/hooks/use-cars';
import type { CarProfile, CarProfileInput } from '@/lib/db';

interface CarsContextType {
  cars: CarProfile[];
  selectedCar: CarProfile | null;
  selectedCarId: string | null;
  loading: boolean;
  error: string | null;
  createCar: (nameOrInput: string | CarProfileInput, notes?: string) => Promise<CarProfile>;
  updateCar: (id: string, updates: Partial<CarProfileInput>) => Promise<void>;
  deleteCar: (id: string) => Promise<void>;
  selectCar: (id: string | null) => void;
  refresh: () => Promise<void>;
}

// Same context object when the dev server reloads this file: otherwise screens
// reloaded with it look for a provider that is no longer the one on screen.
const CarsContext: React.Context<CarsContextType | undefined> =
  import.meta.hot?.data.CarsContext ?? createContext<CarsContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.CarsContext = CarsContext;

export function CarsProvider({ children }: { children: ReactNode }) {
  const carsState = useCars();

  return (
    <CarsContext.Provider value={carsState}>
      {children}
    </CarsContext.Provider>
  );
}

export function useCarsContext() {
  const context = useContext(CarsContext);
  if (context === undefined) {
    throw new Error('useCarsContext must be used within a CarsProvider');
  }
  return context;
}
