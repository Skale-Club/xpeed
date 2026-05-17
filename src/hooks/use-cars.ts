import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getUserCars, createCarProfile, updateCarProfile, deleteCarProfile, type CarProfile, type CarProfileInput } from '@/lib/db';

const STORAGE_KEY = 'selected_car_id';

export function useCars() {
  const [cars, setCars] = useState<CarProfile[]>([]);
  const [selectedCarId, setSelectedCarId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load cars on mount
  useEffect(() => {
    loadCars();
  }, []);

  // Load saved selection from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      setSelectedCarId(saved);
    }
  }, []);

  // Save selection to localStorage when it changes
  useEffect(() => {
    if (selectedCarId) {
      localStorage.setItem(STORAGE_KEY, selectedCarId);
    }
  }, [selectedCarId]);

  // Auto-select first car if none selected or if selected car is not in the list (e.g. filtered out)
  useEffect(() => {
    if (loading || cars.length === 0) return;

    const selectedCarExists = selectedCarId && cars.some(c => c.id === selectedCarId);
    
    if (!selectedCarId || !selectedCarExists) {
      setSelectedCarId(cars[0].id);
    }
  }, [cars, selectedCarId, loading]);

  const loadCars = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getUserCars();
      setCars(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load cars');
    } finally {
      setLoading(false);
    }
  }, []);

  const createCar = useCallback(async (
    nameOrInput: string | CarProfileInput,
    notes?: string,
  ) => {
    try {
      setError(null);
      const newCar = await createCarProfile(nameOrInput, notes);
      setCars(prev => [newCar, ...prev]);
      // Auto-select the new car
      setSelectedCarId(newCar.id);
      return newCar;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create car');
      throw err;
    }
  }, []);

  const updateCar = useCallback(async (id: string, updates: Partial<CarProfileInput>) => {
    try {
      setError(null);
      await updateCarProfile(id, updates);
      setCars(prev => prev.map(car =>
        car.id === id ? { ...car, ...updates } : car
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update car');
      throw err;
    }
  }, []);

  const deleteCar = useCallback(async (id: string) => {
    try {
      setError(null);
      await deleteCarProfile(id);
      setCars(prev => prev.filter(car => car.id !== id));
      // If deleted car was selected, clear selection
      if (selectedCarId === id) {
        const remaining = cars.filter(car => car.id !== id);
        setSelectedCarId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete car');
      throw err;
    }
  }, [selectedCarId, cars]);

  const selectCar = useCallback((id: string | null) => {
    setSelectedCarId(id);
  }, []);

  const selectedCar = cars.find(car => car.id === selectedCarId) || null;

  return {
    cars,
    selectedCar,
    selectedCarId,
    loading,
    error,
    createCar,
    updateCar,
    deleteCar,
    selectCar,
    refresh: loadCars,
  };
}
