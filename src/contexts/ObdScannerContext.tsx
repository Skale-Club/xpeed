import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObdScanner, type TripResult } from '@/hooks/use-obd-scanner';
import { useScreenWakeLock } from '@/hooks/use-wake-lock';
import { useToast } from '@/hooks/use-toast';
import { ingestSessionCsv } from '@/hooks/use-csv-upload';
import { loadCustomPids, saveCustomPids, type CustomPid } from '@/lib/obd/custom-pids';
import { buildScannerCsv, scannerFilename } from '@/lib/obd/session-csv';
import { findRememberedAdapter, isBluetoothAvailable } from '@/lib/obd/elm327';
import { clearInProgressTrip, loadInProgressTrip, saveInProgressTrip } from '@/lib/obd/trip-store';
import { hideBackgroundService, showBackgroundService } from '@/lib/obd/trip-service';

// The Bluetooth OBD connection belongs to the whole signed-in app, not to one
// page. In "always on" mode it also runs the car on its own: it reconnects
// to the remembered adapter, waits in standby while the car is off, records
// a trip whenever the car is driven and saves it when the car is turned off.

const ALWAYS_ON_KEY = 'xpeed.obd.alwaysOn';
/** How often the trip in progress is backed up for crash recovery. */
const BACKUP_MS = 30_000;

function readAlwaysOn(): boolean {
  try {
    return localStorage.getItem(ALWAYS_ON_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface SavedTrip {
  sessionId: string;
  endedAt: Date;
}

type ObdScannerContextType = ReturnType<typeof useObdScanner> & {
  customPids: CustomPid[];
  updateCustomPids: (pids: CustomPid[]) => void;
  alwaysOn: boolean;
  setAlwaysOn: (on: boolean) => void;
  savingTrip: boolean;
  lastTrip: SavedTrip | null;
};

const ObdScannerContext = createContext<ObdScannerContextType | undefined>(undefined);

export function ObdScannerProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { selectedCarId } = useCarsContext();
  const carIdRef = useRef(selectedCarId);
  carIdRef.current = selectedCarId;

  const [customPids, setCustomPids] = useState<CustomPid[]>(() => loadCustomPids(selectedCarId));
  useEffect(() => setCustomPids(loadCustomPids(selectedCarId)), [selectedCarId]);
  const updateCustomPids = useCallback((pids: CustomPid[]) => {
    setCustomPids(pids);
    saveCustomPids(selectedCarId, pids);
  }, [selectedCarId]);

  const [alwaysOn, setAlwaysOnState] = useState(readAlwaysOn);
  const setAlwaysOn = useCallback((on: boolean) => {
    setAlwaysOnState(on);
    try {
      localStorage.setItem(ALWAYS_ON_KEY, String(on));
    } catch {
      // not persisted
    }
  }, []);

  const [savingTrip, setSavingTrip] = useState(false);
  const [lastTrip, setLastTrip] = useState<SavedTrip | null>(null);

  const tripName = useCallback((startedAt: Date) => {
    const when = new Intl.DateTimeFormat(i18n.resolvedLanguage || undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(startedAt);
    return t('trip.name', 'Trip {{when}}', { when });
  }, [t, i18n.resolvedLanguage]);

  const saveTrip = useCallback(async (trip: TripResult, recovered = false) => {
    const carId = carIdRef.current;
    // Keep a copy until the save succeeds; a later app start retries it.
    await saveInProgressTrip({
      carId, startedAt: trip.startedAt.getTime(), endedAt: trip.endedAt.getTime(), columns: trip.columns, samples: trip.samples,
    });
    if (!carId) {
      toast({ title: t('trip.noCar', 'Choose your car to save this trip'), variant: 'destructive' });
      return;
    }
    setSavingTrip(true);
    try {
      const csv = buildScannerCsv(trip.columns, trip.samples);
      const file = new File([csv], scannerFilename(trip.startedAt), { type: 'text/csv' });
      const result = await ingestSessionCsv(file, carId, tripName(trip.startedAt));
      await clearInProgressTrip();
      setLastTrip({ sessionId: result.sessionId, endedAt: trip.endedAt });
      toast({
        title: recovered ? t('trip.recovered', 'Saved a trip that was interrupted') : t('trip.saved', 'Trip saved'),
        description: t('trip.savedHint', 'You can see it in History.'),
      });
    } catch (err) {
      console.error('Trip save failed:', err);
      toast({
        title: t('trip.saveFailed', "Couldn't save the trip"),
        description: t('trip.saveFailedHint', "It's kept on this device and will be saved next time you open the app."),
        variant: 'destructive',
      });
    } finally {
      setSavingTrip(false);
    }
  }, [t, toast, tripName]);

  const obd = useObdScanner({ customPids, alwaysOn, onTripEnd: (trip) => void saveTrip(trip) });
  const { status, recording, getRecording, connect } = obd;

  // Back up the trip in progress.
  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => {
      const snap = getRecording();
      if (snap.startedAt && snap.samples.length) {
        void saveInProgressTrip({
          carId: carIdRef.current, startedAt: snap.startedAt.getTime(), columns: snap.columns, samples: snap.samples,
        });
      }
    }, BACKUP_MS);
    return () => clearInterval(id);
  }, [recording?.active, getRecording]);

  // On app start: save a trip a previous visit didn't finish saving.
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (recoveredRef.current || !selectedCarId) return;
    recoveredRef.current = true;
    void loadInProgressTrip().then((stored) => {
      if (!stored || stored.samples.length === 0) return;
      const last = stored.samples[stored.samples.length - 1].t;
      void saveTrip({
        startedAt: new Date(stored.startedAt),
        endedAt: new Date(stored.endedAt ?? stored.startedAt + last * 1000),
        reason: 'disconnected',
        columns: stored.columns,
        samples: stored.samples,
      }, true);
    });
  }, [selectedCarId, saveTrip]);

  // On app start in always-on mode: reconnect to the adapter used last time, no chooser.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !alwaysOn || !isBluetoothAvailable()) return;
    resumedRef.current = true;
    void findRememberedAdapter().then((device) => {
      if (device) void connect({ device });
    });
  }, [alwaysOn, connect]);

  const linked = status === 'live' || status === 'waiting' || status === 'reconnecting' || !!recording?.active;
  useScreenWakeLock(linked);

  // Android app: a persistent notification keeps everything running with the screen off.
  const serviceText = recording?.active
    ? t('notify.recording', 'Recording your trip')
    : status === 'live'
      ? t('notify.live', 'Car connected')
      : status === 'waiting'
        ? t('notify.waiting', 'Waiting for the car to start')
        : t('notify.reconnecting', 'Looking for the adapter');
  useEffect(() => {
    if (linked) void showBackgroundService('Xpeed', serviceText);
    else void hideBackgroundService();
  }, [linked, serviceText]);

  return (
    <ObdScannerContext.Provider value={{ ...obd, customPids, updateCustomPids, alwaysOn, setAlwaysOn, savingTrip, lastTrip }}>
      {children}
    </ObdScannerContext.Provider>
  );
}

export function useObd() {
  const context = useContext(ObdScannerContext);
  if (context === undefined) {
    throw new Error('useObd must be used within an ObdScannerProvider');
  }
  return context;
}
