import { createLiveAlertMonitor } from '@/lib/live-alerts';
import { matchCanonicalKey } from '@/lib/canonical-params';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import type { FuelComparison } from '@/lib/fuel-ledger';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useCarsContext } from './CarsContext';
import { useObd } from './ObdScannerContext';
import { useOpenProblems } from '@/hooks/use-open-problems';
import { loadVehicleNotifications, saveVehicleNotifications, mergeVehicleNotification, notificationScope, problemNotification, scanNotification, oilNotification, type VehicleNotification } from '@/lib/vehicle-notifications';
import { supabase } from '@/integrations/supabase/client';
import { useVehicleCare } from '@/hooks/use-vehicle-care';
import { useSettings } from './SettingsContext';
import { oilReminder } from '@/lib/vehicle-care';
import { tripDayKey } from '@/lib/trip-history';

interface NotificationState {
  items: VehicleNotification[]; unread: number; loading: boolean; error: boolean;
  observeFuel: (comparison: FuelComparison | null) => void;
  markRead: (source?: string) => void; reload: () => void;
}
const Context = createContext<NotificationState>({ items: [], unread: 0, loading: false, error: false, markRead: () => {}, reload: () => {}, observeFuel: () => {} });
export const useVehicleNotifications = () => useContext(Context);

function LiveAlertObserver({userId}: {userId:string}) {
  const {live,status,recording,recordingCarId,connectedCarId}=useObd();
  const {cars=[]}=useCarsContext();
  const connectedCar=cars.find(car=>car.id===connectedCarId);
  const active=recording?.active,startedAt=recording?.startedAt;
  useEffect(() => {
    if (!live || status !== 'live' || !active || recordingCarId !== connectedCarId || !connectedCar) return;
    const monitor = createLiveAlertMonitor(resolveRulesetForCar(connectedCar).rules);
    let previous: Record<string,number|null> | null = null;
    return live.subscribe(() => {
      const readings = live.get().values;
      if (readings === previous) return;
      previous = readings;
      const values: Record<string,number|null> = {};
      for (const [header,value] of Object.entries(readings)) {
        const mapping = matchCanonicalKey(header);
        if (mapping) values[mapping.canonical_key] = value;
      }
      for (const alert of monitor.observe(values,Date.now())) {
        const source = 'live:' + alert.key;
        const incoming: VehicleNotification = {source, fingerprint: source + ':' + alert.severity + ':' + startedAt!.toISOString(), kind:'live', severity:alert.severity, at:new Date(alert.at).toISOString(),read:false,live:alert};
        const scope = notificationScope(userId, connectedCarId!);
        saveVehicleNotifications(scope,mergeVehicleNotification(loadVehicleNotifications(scope),incoming));
        window.dispatchEvent(new CustomEvent('xpeed:vehicle-notification',{detail:{scope,incoming}}));
      }
    });
  },[live,status,active,startedAt,recordingCarId,connectedCarId,connectedCar,userId]);
  return null;
}

function ScopedNotifications({ userId, carId, vin, children }: { userId: string; carId: string; vin?: string | null; children: ReactNode }) {
  const { faultInspection, lastTrip, connectedCarId } = useObd();
  const problems = useOpenProblems(carId, lastTrip);
  const care = useVehicleCare(carId);
  const { timezone } = useSettings();
  const [now, setNow] = useState(Date.now());
  const today = tripDayKey(new Date(now), timezone);
  const scope = notificationScope(userId, carId);
  const [items, setItems] = useState(() => loadVehicleNotifications(scope));
  // A car change never reattributes the previous connection's inspection.
  const baseline = useRef(faultInspection);
  useEffect(() => { saveVehicleNotifications(scope, items); }, [scope, items]);
  useEffect(() => {
    const receive=(event:Event)=>{const detail=(event as CustomEvent<{scope:string;incoming:VehicleNotification}>).detail;if(detail.scope===scope)setItems(previous=>mergeVehicleNotification(previous,detail.incoming));};
    window.addEventListener('xpeed:vehicle-notification',receive);
    return ()=>window.removeEventListener('xpeed:vehicle-notification',receive);
  },[scope]);
  useEffect(() => {
    if (problems.loading || problems.error) return;
    setItems((previous) => problems.problems.reduce((all, problem) => mergeVehicleNotification(all, problemNotification(problem)), previous));
  }, [problems.loading, problems.error, problems.problems]);
  useEffect(() => {
    if (!faultInspection || baseline.current === faultInspection) return;
    if (faultInspection.vin ? (!vin || vin.toUpperCase() !== faultInspection.vin.toUpperCase()) : connectedCarId !== carId) return;
    baseline.current = faultInspection;
    setItems((previous) => mergeVehicleNotification(previous, scanNotification(faultInspection.readout, faultInspection.at)));
  }, [faultInspection, vin, connectedCarId, carId]);
  useEffect(() => {
    if (!care.isSuccess || !care.data) return;
    const oil = oilReminder(care.data, today, timezone);
    setItems(previous => oil ? mergeVehicleNotification(previous, oilNotification(oil, care.data.state.oilPlanAt)) : previous.some(item => item.kind === 'maintenance') ? previous.filter(item => item.kind !== 'maintenance') : previous);
  }, [care.data, care.isSuccess, today, timezone]);
  const { reload: reloadProblems } = problems;
  const { refetch: refetchCare } = care;
  const reload = useCallback(() => { reloadProblems(); void refetchCare(); }, [reloadProblems, refetchCare]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); reload(); } };
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
  const shown = items.filter((item) => item.kind === 'live' || item.kind === 'scan' || item.kind === 'fuel' || item.kind === 'maintenance' || problems.loading || problems.error || active.has(item.source))
    .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') || Number(a.read) - Number(b.read) || b.at.localeCompare(a.at));
  return <Context.Provider value={{ items: shown, unread: shown.filter((item) => !item.read).length, loading: problems.loading || care.isPending, error: problems.refreshError || care.isError, markRead, reload, observeFuel }}>{children}</Context.Provider>;
}

export function VehicleNotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { selectedCar, selectedCarId } = useCarsContext();
  if (!user || !selectedCarId) return <Context.Provider value={{ items: [], unread: 0, loading: false, error: false, markRead: () => {}, reload: () => {}, observeFuel: () => {} }}>{children}</Context.Provider>;
  return <><LiveAlertObserver userId={user.id} /><ScopedNotifications key={`${user.id}:${selectedCarId}`} userId={user.id} carId={selectedCarId} vin={selectedCar?.vin}>{children}</ScopedNotifications></>;
}
