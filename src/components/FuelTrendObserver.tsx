import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObd } from '@/contexts/ObdScannerContext';
import { useVehicleNotifications } from '@/contexts/VehicleNotificationsContext';
import { getSessions } from '@/lib/db';
import { calculateSavedFuel } from '@/lib/fuel-api';
import { PROCESSING_VERSION } from '@/lib/report-generator';
import { compareFuel } from '@/lib/fuel-ledger';
import type { Session } from '@/types/session';
export function FuelTrendObserver() {
  const { selectedCarId } = useCarsContext(); const { lastTrip } = useObd(); const { observeFuel } = useVehicleNotifications();
  const history = useQuery({ queryKey: ['fuel-sessions', selectedCarId], queryFn: async () => await getSessions(selectedCarId!) as Session[], enabled: !!selectedCarId, staleTime: 60000, refetchInterval: 300000 });
  const client = useQueryClient();
  const attempts = useRef(new Map<string, number>());
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
          if (!stopped) client.setQueryData<Session[]>(['fuel-sessions', carId], previous => previous?.map(item => item.id === trip.id ? { ...item, processing_version: PROCESSING_VERSION, summary: { ...item.summary, fuel } } : item));
        } catch { /* Keep the original trip intact; retry on a later refresh. */ }
      }
    })();
    return () => { stopped = true; };
  }, [selectedCarId, history.data, history.isSuccess, client]);
  const { refetch } = history;
  useEffect(() => { if (lastTrip) void refetch(); }, [lastTrip, refetch]);
  useEffect(() => { if (history.isSuccess) observeFuel(compareFuel(history.data)); }, [history.data, history.isSuccess, observeFuel]);
  return null;
}
