import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useCarsContext } from '@/contexts/CarsContext';
import { useObdScanner, type TripResult } from '@/hooks/use-obd-scanner';
import { useScreenWakeLock } from '@/hooks/use-wake-lock';
import { useToast } from '@/hooks/use-toast';
import { ingestSessionCsv } from '@/hooks/use-csv-upload';
import { deleteSession, findSessionStartedAt } from '@/lib/db';
import { loadCustomPids, saveCustomPids, type CustomPid } from '@/lib/obd/custom-pids';
import { buildScannerCsv, scannerFilename } from '@/lib/obd/session-csv';
import { findRememberedAdapter, isBluetoothAvailable } from '@/lib/obd/elm327';
import { isNativeApp } from '@/lib/obd/native-ble';
import { deleteTripCopy, listTripCopies, saveTripCopy, tripKey, type StoredTrip } from '@/lib/obd/trip-store';
import { hideBackgroundService, showBackgroundService } from '@/lib/obd/trip-service';
import { DEFAULT_TRIP_OPTIONS } from '@/lib/obd/trip-detector';

// The Bluetooth OBD connection belongs to the whole signed-in app, not to one
// page. In "always on" mode it also runs the car on its own: it reconnects
// to the remembered adapter, waits in standby while the car is off, records
// a trip whenever the car is driven and saves it when the car is turned off.
// Every trip is kept on the device until it is in the database, and trips
// that couldn't be saved are retried when the connection comes back.

const ALWAYS_ON_KEY = 'xpeed.obd.alwaysOn';
/** How often the trip in progress is backed up for crash recovery. */
const BACKUP_MS = 30_000;
/** How often trips still on the device are retried while the app is open. */
const RETRY_MS = 5 * 60_000;
/** Interrupted recordings shorter than an automatic trip's minimum are not kept. */
const MIN_RECOVERED_TRIP_S = DEFAULT_TRIP_OPTIONS.minTripMs / 1000;

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

  // The trip being recorded: its copy's key and the car it belongs to (the car
  // selected when it started, even if another one is picked meanwhile).
  const currentTripRef = useRef<{ id: string; carId: string | null } | null>(null);
  const uploadingRef = useRef(new Set<string>());

  /**
   * Put one trip copy in the database, then remove it from the device. If a
   * previous attempt got as far as creating the trip but was cut off, that
   * partial trip is replaced instead of duplicated.
   */
  const uploadCopy = useCallback(async (copy: StoredTrip, announceFailure: boolean) => {
    if (uploadingRef.current.has(copy.id)) return;
    const carId = copy.carId ?? carIdRef.current;
    if (!carId) {
      if (announceFailure) toast({ title: t('trip.noCar', 'Choose your car to save this trip'), variant: 'destructive' });
      return;
    }
    uploadingRef.current.add(copy.id);
    setSavingTrip(true);
    // A copy without an end time is a recording the app never got to finish.
    const recovered = copy.endedAt == null;
    if (recovered && copy.samples[copy.samples.length - 1].t < MIN_RECOVERED_TRIP_S) {
      // Cut off before it was even a trip; the detector would have dropped it.
      uploadingRef.current.delete(copy.id);
      setSavingTrip(uploadingRef.current.size > 0);
      await deleteTripCopy(copy.id);
      return;
    }
    try {
      const startedAt = new Date(copy.startedAt);
      const endedAt = new Date(copy.endedAt ?? copy.startedAt + copy.samples[copy.samples.length - 1].t * 1000);
      const earlier = await findSessionStartedAt(carId, startedAt);
      if (earlier) await deleteSession(earlier);

      const csv = buildScannerCsv(copy.columns, copy.samples, copy.dtcs ?? []);
      const file = new File([csv], scannerFilename(startedAt), { type: 'text/csv' });
      const result = await ingestSessionCsv(file, carId, tripName(startedAt), undefined, () => deleteTripCopy(copy.id));
      setLastTrip({ sessionId: result.sessionId, endedAt });
      toast({
        title: recovered ? t('trip.recovered', 'Saved a trip that was interrupted') : t('trip.saved', 'Trip saved'),
        description: t('trip.savedHint', 'You can see it in History.'),
      });
    } catch (err) {
      console.error('Trip save failed:', err);
      if (announceFailure) {
        toast({
          title: t('trip.saveFailed', "Couldn't save the trip"),
          description: t('trip.saveFailedHint', "It's kept on this device and will be saved by itself when there's internet."),
          variant: 'destructive',
        });
      }
    } finally {
      uploadingRef.current.delete(copy.id);
      setSavingTrip(uploadingRef.current.size > 0);
    }
  }, [t, toast, tripName]);

  /**
   * Retry trips still on the device. Finished trips whose save failed are
   * always retried; unfinished copies (a recording cut off by a crash) only at
   * app start, since while the app runs those belong to the trip in progress.
   */
  const flushCopies = useCallback(async (includeUnfinished: boolean) => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    for (const copy of await listTripCopies()) {
      if (copy.id === currentTripRef.current?.id) continue; // still being recorded
      if (copy.endedAt == null && !includeUnfinished) continue;
      await uploadCopy(copy, false);
    }
  }, [uploadCopy]);

  const saveTrip = useCallback(async (trip: TripResult) => {
    const id = tripKey(trip.startedAt.getTime());
    const carId = currentTripRef.current?.id === id ? currentTripRef.current.carId : carIdRef.current;
    if (currentTripRef.current?.id === id) currentTripRef.current = null;
    // Keep a copy until the save succeeds; it is retried when the connection is back.
    const copy: StoredTrip = {
      id, carId, startedAt: trip.startedAt.getTime(), endedAt: trip.endedAt.getTime(), columns: trip.columns, samples: trip.samples, dtcs: trip.dtcs,
    };
    await saveTripCopy(copy);
    await uploadCopy(copy, true);
  }, [uploadCopy]);

  const dropTrip = useCallback((startedAt: Date) => {
    const id = tripKey(startedAt.getTime());
    if (currentTripRef.current?.id === id) currentTripRef.current = null;
    void deleteTripCopy(id);
  }, []);

  const obd = useObdScanner({ customPids, alwaysOn, onTripEnd: (trip) => void saveTrip(trip), onTripDropped: dropTrip });
  const { status, recording, getRecording, connect } = obd;

  // A trip started: remember which car it belongs to.
  const recordingStart = recording?.startedAt.getTime() ?? null;
  useEffect(() => {
    if (recordingStart != null) currentTripRef.current = { id: tripKey(recordingStart), carId: carIdRef.current };
  }, [recordingStart]);

  // Back up the trip in progress.
  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => {
      const snap = getRecording();
      const current = currentTripRef.current;
      if (snap.startedAt && snap.samples.length && current?.id === tripKey(snap.startedAt.getTime())) {
        void saveTripCopy({
          id: current.id, carId: current.carId, startedAt: snap.startedAt.getTime(), columns: snap.columns, samples: snap.samples, dtcs: snap.dtcs,
        });
      }
    }, BACKUP_MS);
    return () => clearInterval(id);
  }, [recording?.active, getRecording]);

  // Trips a previous visit didn't finish saving go up at start, whenever the
  // connection comes back, and every few minutes while the app is open.
  const flushStartedRef = useRef(false);
  useEffect(() => {
    if (!selectedCarId) return;
    if (!flushStartedRef.current) {
      flushStartedRef.current = true;
      void flushCopies(true);
    }
    const onOnline = () => void flushCopies(false);
    window.addEventListener('online', onOnline);
    const id = setInterval(() => void flushCopies(false), RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(id);
    };
  }, [selectedCarId, flushCopies]);

  // On app start in always-on mode: reconnect to the adapter used last time, no chooser.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !alwaysOn || !isBluetoothAvailable()) return;
    resumedRef.current = true;
    void findRememberedAdapter().then((device) => {
      if (device) void connect({ device });
    });
  }, [alwaysOn, connect]);

  // Linked = anything but idle: "connecting" included, since a reconnect passes
  // through it and Android won't let the service start again from the background.
  const linked = (status !== 'idle' && status !== 'unsupported') || !!recording?.active;
  const driving = status === 'live' || !!recording?.active;
  // The browser only keeps running with the screen on; the Android app has its
  // own service, so there the screen stays on only while the car is on.
  useScreenWakeLock(isNativeApp() ? driving : linked);

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
