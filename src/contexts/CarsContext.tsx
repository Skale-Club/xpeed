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

const CarsContext = createContext<CarsContextType | undefined>(undefined);

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
