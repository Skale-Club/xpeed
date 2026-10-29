import type { FuelComparison } from '@/lib/fuel-ledger';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useCarsContext } from './CarsContext';
import { useObd } from './ObdScannerContext';
import { useOpenProblems } from '@/hooks/use-open-problems';
import { loadVehicleNotifications, saveVehicleNotifications, mergeVehicleNotification, notificationScope, problemNotification, scanNotification, type VehicleNotification } from '@/lib/vehicle-notifications';
import { supabase } from '@/integrations/supabase/client';

interface NotificationState {
  items: VehicleNotification[]; unread: number; loading: boolean; error: boolean;
  observeFuel: (comparison: FuelComparison | null) => void;
  markRead: (source?: string) => void; reload: () => void;
}
const Context = createContext<NotificationState>({ items: [], unread: 0, loading: false, error: false, markRead: () => {}, reload: () => {}, observeFuel: () => {} });
export const useVehicleNotifications = () => useContext(Context);

function ScopedNotifications({ userId, carId, vin, children }: { userId: string; carId: string; vin?: string | null; children: ReactNode }) {
  const { faultInspection, lastTrip } = useObd();
  const problems = useOpenProblems(carId, lastTrip);
  const scope = notificationScope(userId, carId);
  const [items, setItems] = useState(() => loadVehicleNotifications(scope));
  // A car change never reattributes the previous connection's inspection.
  const baseline = useRef(faultInspection);
  useEffect(() => { saveVehicleNotifications(scope, items); }, [scope, items]);
  useEffect(() => {
    if (problems.loading || problems.error) return;
    setItems((previous) => problems.problems.reduce((all, problem) => mergeVehicleNotification(all, problemNotification(problem)), previous));
  }, [problems.loading, problems.error, problems.problems]);
  useEffect(() => {
    if (!faultInspection || baseline.current === faultInspection) return;
    baseline.current = faultInspection;
    if (vin && faultInspection.vin && vin !== faultInspection.vin) return;
    setItems((previous) => mergeVehicleNotification(previous, scanNotification(faultInspection.readout, faultInspection.at)));
  }, [faultInspection, vin]);
  const reload = problems.reload;
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') reload(); };
    const timer = window.setInterval(visible, 60_000);
    window.addEventListener('online', reload);
    document.addEventListener('visibilitychange', visible);
    const channel = supabase.channel(`notification-issues-${userId}-${carId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'vehicle_issues', filter: `car_profile_id=eq.${carId}` }, reload).subscribe();
    return () => { clearInterval(timer); window.removeEventListener('online', reload); document.removeEventListener('visibilitychange', visible); void supabase.removeChannel(channel); };
  }, [userId, carId, reload]);
  const observeFuel = useCallback((fuel: FuelComparison | null) => setItems(previous => {
    if (!fuel || fuel.deltaPct < 10) return previous.some(item => item.kind === 'fuel') ? previous.filter(item => item.kind !== 'fuel') : previous;
    return mergeVehicleNotification(previous, { source: 'fuel', fingerprint: `${fuel.period}:${fuel.bucket}:increased`, kind: 'fuel', severity: 'warning', at: new Date().toISOString(), read: false, fuel });
  }), []);
  const markRead = useCallback((source?: string) => setItems((previous) => previous.map((item) => !source || item.source === source ? { ...item, read: true } : item)), []);
  const active = useMemo(() => new Set(problems.problems.map((problem) => `problem:${problem.id}`)), [problems.problems]);
  const shown = items.filter((item) => item.kind === 'scan' || item.kind === 'fuel' || problems.loading || problems.error || active.has(item.source))
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || Number(a.read) - Number(b.read) || b.at.localeCompare(a.at));
  return <Context.Provider value={{ items: shown, unread: shown.filter((item) => !item.read).length, loading: problems.loading, error: problems.refreshError, markRead, reload, observeFuel }}>{children}</Context.Provider>;
}

export function VehicleNotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { selectedCar, selectedCarId } = useCarsContext();
  if (!user || !selectedCarId) return <Context.Provider value={{ items: [], unread: 0, loading: false, error: false, markRead: () => {}, reload: () => {}, observeFuel: () => {} }}>{children}</Context.Provider>;
  return <ScopedNotifications key={`${user.id}:${selectedCarId}`} userId={user.id} carId={selectedCarId} vin={selectedCar?.vin}>{children}</ScopedNotifications>;
}
