import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCarsContext } from '@/contexts/CarsContext';
import { useVehicleNotifications } from '@/contexts/VehicleNotificationsContext';
import { getSessions } from '@/lib/db';
import { calculateSavedFuel, recalculateTripFuel } from '@/lib/fuel-api';
import { airFlowFuelApplies, type FuelMetrics } from '@/lib/fuel-metrics';
import { PROCESSING_VERSION } from '@/lib/report-generator';
import { compareFuel } from '@/lib/fuel-ledger';
import type { Session } from '@/types/session';
export function FuelTrendObserver() {
  const { selectedCarId, selectedCar } = useCarsContext(); const { observeFuel } = useVehicleNotifications();
  const engineType = selectedCar?.engine_type ?? null;
  const history = useQuery({ queryKey: ['sessions', selectedCarId], queryFn: async () => await getSessions(selectedCarId!) as Session[], enabled: !!selectedCarId, staleTime: 60000, refetchInterval: 300000 });
  const client = useQueryClient();
  const attempts = useRef(new Map<string, number>());
  const fuelTried = useRef(new Set<string>());
  useEffect(() => {
    if (!selectedCarId || !history.isSuccess) return;
    let stopped = false;
    const carId = selectedCarId;
    void (async () => {
      for (const trip of history.data.filter(item => item.processing_version !== PROCESSING_VERSION).slice(0, 20)) {
        if (stopped) break;
        const last = attempts.current.get(trip.id) ?? 0;
        if (Date.now() - last < 300000) continue;
        attempts.current.set(trip.id, Date.now());
        try {
          const fuel = await calculateSavedFuel(carId, trip.id);
          if (!stopped) client.setQueryData<Session[]>(['sessions', carId], previous => previous?.map(item => item.id === trip.id ? { ...item, processing_version: PROCESSING_VERSION, summary: { ...item.summary, fuel } } : item));
        } catch { /* Keep the original trip intact; retry on a later refresh. */ }
      }
    })();
    return () => { stopped = true; };
  }, [selectedCarId, history.data, history.isSuccess, client]);
  // Trips saved before fuel was worked out from the air flow have no fuel on petrol and hybrid cars that
  // don't report it. Work it out once per trip (only summary.fuel changes), so the Fuel page totals include them.
  useEffect(() => {
    if (!selectedCarId || !history.isSuccess || !airFlowFuelApplies(engineType)) return;
    let stopped = false;
    const carId = selectedCarId;
    const pending = history.data.filter(item => {
      const fuel = item.summary?.fuel as FuelMetrics | undefined;
      return item.processing_version === PROCESSING_VERSION && fuel?.version === 1 && fuel.litres == null && !('method' in fuel) && !fuelTried.current.has(item.id);
    }).slice(0, 20);
    void (async () => {
      for (const trip of pending) {
        if (stopped) break;
        fuelTried.current.add(trip.id);
        try {
          const fuel = await recalculateTripFuel(carId, trip.id);
          if (!stopped) client.setQueryData<Session[]>(['sessions', carId], previous => previous?.map(item => item.id === trip.id ? { ...item, summary: { ...item.summary, fuel } } : item));
        } catch { /* Left as it was; tried again next time the app opens. */ }
      }
    })();
    return () => { stopped = true; };
  }, [selectedCarId, engineType, history.data, history.isSuccess, client]);
  useEffect(() => { if (history.isSuccess) observeFuel(compareFuel(history.data)); }, [history.data, history.isSuccess, observeFuel]);
  return null;
}
