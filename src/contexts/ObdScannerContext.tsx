import {
  createContext, type Context, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useCarsContext } from '@/contexts/CarsContext';
import { useAuth } from '@/contexts/AuthContext';
import { useObdScanner, type TripResult } from '@/hooks/use-obd-scanner';
import { useScreenWakeLock } from '@/hooks/use-wake-lock';
import { useToast } from '@/hooks/use-toast';
import { ingestSessionCsv } from '@/hooks/use-csv-upload';
import { deleteSession, findSessionStartedAt } from '@/lib/db';
import { loadCustomPids, saveCustomPids, type CustomPid } from '@/lib/obd/custom-pids';
import { buildScannerCsv, scannerFilename } from '@/lib/obd/session-csv';
import { findRememberedAdapter, isBluetoothAvailable } from '@/lib/obd/elm327';
import { isBluetoothReady, isNativeApp } from '@/lib/obd/native-ble';
import { isMobileDevice } from '@/lib/device';
import { setTripRecording } from '@/lib/pwa-update';
import { beforeLogout } from '@/lib/logout';
import {
  appendTripSamples, deleteTripCopy, getTripCopy, listTripCopies, saveTripCopy, tripKey, type StoredTrip,
} from '@/lib/obd/trip-store';
import { hideBackgroundService, showBackgroundService } from '@/lib/obd/trip-service';
import { DEFAULT_TRIP_OPTIONS } from '@/lib/obd/trip-detector';
import type { LiveSnapshot } from '@/lib/obd/live-store';
import { identifyVin, isValidVin, vinFitsCar, type CarIdentity } from '@/lib/vin';

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
  /** Always on is in effect (chosen, and this is a phone or tablet). */
  alwaysOn: boolean;
  /** This device can run always on (phone/tablet); computers start trips by hand. */
  canStayOn: boolean;
  setAlwaysOn: (on: boolean) => void;
  savingTrip: boolean;
  lastTrip: SavedTrip | null;
  /** The adapter is in a car that isn't in "My cars" yet (from its VIN). */
  newCarFound: CarIdentity | null;
  /** Add the car found by VIN (with the brand/model the owner typed when the VIN didn't tell) and switch to it. */
  addFoundCar: (details?: { make?: string; model?: string }) => Promise<void>;
  dismissFoundCar: () => void;
};

// Same context object when the dev server reloads this file: otherwise screens
// reloaded with it look for a provider that is no longer the one on screen.
const ObdScannerContext: Context<ObdScannerContextType | undefined> =
  import.meta.hot?.data.ObdScannerContext ?? createContext<ObdScannerContextType | undefined>(undefined);
if (import.meta.hot) import.meta.hot.data.ObdScannerContext = ObdScannerContext;

export function ObdScannerProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const { cars = [], selectedCarId, selectCar, createCar, updateCar, loading: carsLoading } = useCarsContext();
  const carIdRef = useRef(selectedCarId);
  carIdRef.current = selectedCarId;
  const userId = user?.id ?? null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const carsRef = useRef(cars);
  carsRef.current = cars;

  // Set while the provider is going away (sign-out): what is recorded is kept on
  // the device for its owner, not uploaded. Declared before the scanner so its
  // cleanup runs first, ahead of the scanner closing the trip in progress.
  const leavingRef = useRef(false);
  useEffect(() => {
    leavingRef.current = false;
    return () => { leavingRef.current = true; };
  }, []);

  const [customPids, setCustomPids] = useState<CustomPid[]>(() => loadCustomPids(selectedCarId));
  useEffect(() => setCustomPids(loadCustomPids(selectedCarId)), [selectedCarId]);
  const updateCustomPids = useCallback((pids: CustomPid[]) => {
    setCustomPids(pids);
    saveCustomPids(selectedCarId, pids);
  }, [selectedCarId]);

  const [canStayOn] = useState(isMobileDevice);
  const [alwaysOnChosen, setAlwaysOnState] = useState(readAlwaysOn);
  const alwaysOn = alwaysOnChosen && canStayOn;
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

  // The trip being recorded: its copy's key, the car it belongs to (the car
  // selected when it started, even if another one is picked meanwhile) and who recorded it.
  const currentTripRef = useRef<{ id: string; carId: string | null; userId: string | null } | null>(null);
  /** Trips that just ended or were dropped: their copy is being written or removed, so a retry must leave it alone. */
  const finishingRef = useRef(new Set<string>());
  /** Copies the device couldn't store (no IndexedDB, disk full): kept here so they still get uploaded. */
  const memoryCopiesRef = useRef(new Map<string, StoredTrip>());

  /** Does this copy belong to whoever is signed in now? */
  const isMine = useCallback((copy: StoredTrip): boolean => {
    const me = userIdRef.current;
    if (!me) return false;
    if (copy.userId) return copy.userId === me;
    // Older copies don't say who recorded them: they are this user's if their car is.
    return copy.carId != null && carsRef.current.some((c) => c.id === copy.carId);
  }, []);

  const savingRef = useRef(0);
  const bumpSaving = useCallback((by: number) => {
    savingRef.current += by;
    setSavingTrip(savingRef.current > 0);
  }, []);

  /**
   * Put one trip copy in the database, then remove it from the device. If a
   * previous attempt got as far as creating the trip but was cut off, that
   * partial trip is replaced instead of duplicated.
   *
   * The copy is read again here, at its turn: a list made earlier can be stale
   * (the trip may have been uploaded meanwhile), and uploading it again would
   * delete the saved trip and run the AI analysis a second time.
   */
  const uploadOne = useCallback(async (id: string, announceFailure: () => boolean) => {
    const copy = (await getTripCopy(id)) ?? memoryCopiesRef.current.get(id) ?? null;
    if (!copy || copy.samples.length === 0) return;
    if (!isMine(copy)) return; // someone else's trip (shared phone): it waits for its owner
    if (copy.endedAt == null && currentTripRef.current?.id === id) return; // still being recorded
    const carId = copy.carId ?? carIdRef.current;
    if (!carId) {
      if (announceFailure()) toast({ title: t('trip.noCar', 'Choose your car to save this trip'), variant: 'warning' });
      return;
    }
    const forget = async () => {
      memoryCopiesRef.current.delete(id);
      await deleteTripCopy(id);
    };
    // A copy without an end time is a recording the app never got to finish.
    const recovered = copy.endedAt == null;
    if (recovered && copy.samples[copy.samples.length - 1].t < MIN_RECOVERED_TRIP_S) {
      // Cut off before it was even a trip; the detector would have dropped it.
      await forget();
      return;
    }
    bumpSaving(1);
    try {
      const startedAt = new Date(copy.startedAt);
      const endedAt = new Date(copy.endedAt ?? copy.startedAt + copy.samples[copy.samples.length - 1].t * 1000);
      const earlier = await findSessionStartedAt(carId, startedAt);
      if (earlier) {
        // Only replace the earlier upload while this copy is still waiting to be saved.
        const stillThere = (await getTripCopy(id)) ?? memoryCopiesRef.current.get(id);
        if (!stillThere) return;
        await deleteSession(earlier);
      }

      const csv = buildScannerCsv(copy.columns, copy.samples, copy.dtcs ?? []);
      const file = new File([csv], scannerFilename(startedAt), { type: 'text/csv' });
      const result = await ingestSessionCsv(file, carId, tripName(startedAt), undefined, forget, copy.faultCodes);
      setLastTrip({ sessionId: result.sessionId, endedAt });
      toast({
        title: recovered ? t('trip.recovered', 'Saved a trip that was interrupted') : t('trip.saved', 'Trip saved'),
        description: t('trip.savedHint', 'You can see it in History.'),
        variant: 'success',
      });
    } catch (err) {
      console.error('Trip save failed:', err);
      if (announceFailure()) {
        const kept = !memoryCopiesRef.current.has(id);
        toast({
          title: t('trip.saveFailed', "Couldn't save the trip"),
          description: kept
            ? t('trip.saveFailedHint', "It's kept on this device and will be saved by itself when there's internet.")
            : t('trip.saveFailedNoCopy', "It couldn't be kept on this device either, so leave the app open: it keeps trying while it's open."),
          variant: kept ? 'warning' : 'destructive',
        });
      }
    } finally {
      bumpSaving(-1);
    }
  }, [bumpSaving, isMine, t, toast, tripName]);

  // One upload at a time, each id at most once in the queue: a retry that reaches a
  // trip the save just uploaded finds it gone instead of uploading it again.
  const uploadQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const queuedRef = useRef(new Map<string, { announce: boolean; done: Promise<void> }>());
  const uploadCopy = useCallback((id: string, announceFailure: boolean): Promise<void> => {
    const queued = queuedRef.current.get(id);
    if (queued) {
      queued.announce ||= announceFailure;
      return queued.done;
    }
    const entry = { announce: announceFailure, done: Promise.resolve() };
    entry.done = uploadQueueRef.current
      .then(() => uploadOne(id, () => entry.announce))
      .catch((err) => console.error('Trip upload failed:', err))
      .finally(() => { queuedRef.current.delete(id); });
    queuedRef.current.set(id, entry);
    uploadQueueRef.current = entry.done;
    return entry.done;
  }, [uploadOne]);

  /**
   * Retry trips still on the device. Finished trips whose save failed and
   * recordings cut off by a crash are both retried, every time; only the trip
   * being recorded right now (and one being closed) is left alone.
   */
  const flushCopies = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (!userIdRef.current) return;
    const ids = new Set([...(await listTripCopies()).map((c) => c.id), ...memoryCopiesRef.current.keys()]);
    for (const id of ids) {
      if (id === currentTripRef.current?.id || finishingRef.current.has(id)) continue;
      await uploadCopy(id, false);
    }
  }, [uploadCopy]);

  const saveTrip = useCallback(async (trip: TripResult) => {
    const id = tripKey(trip.startedAt.getTime());
    const current = currentTripRef.current?.id === id ? currentTripRef.current : null;
    const carId = current ? current.carId : carIdRef.current;
    const owner = current ? current.userId : userIdRef.current;
    finishingRef.current.add(id);
    try {
      // Keep a copy until the save succeeds; it is retried when the connection is back.
      const copy: StoredTrip = {
        id, carId, userId: owner, startedAt: trip.startedAt.getTime(), endedAt: trip.endedAt.getTime(), columns: trip.columns, samples: trip.samples, dtcs: trip.dtcs,
        faultCodes: {
          stored: trip.faultCodes.stored, pending: trip.faultCodes.pending, checked: trip.faultCodes.checked,
          modules: trip.faultCodes.modules, codeModules: trip.faultCodes.codeModules,
        },
      };
      const kept = await saveTripCopy(copy);
      if (!kept) memoryCopiesRef.current.set(id, copy);
      if (currentTripRef.current?.id === id) currentTripRef.current = null;
      // Leaving (signed out): the copy stays on the device for its owner.
      if (leavingRef.current) return;
      await uploadCopy(id, true);
    } finally {
      finishingRef.current.delete(id);
    }
  }, [uploadCopy]);

  const dropTrip = useCallback((startedAt: Date) => {
    const id = tripKey(startedAt.getTime());
    if (currentTripRef.current?.id === id) currentTripRef.current = null;
    finishingRef.current.add(id);
    void deleteTripCopy(id).finally(() => finishingRef.current.delete(id));
  }, []);

  const obd = useObdScanner({ customPids, alwaysOn, onTripEnd: (trip) => void saveTrip(trip), onTripDropped: dropTrip });
  const { status, recording, getRecording, connect, linkOpen } = obd;

  // ---------- Which car is this? (by VIN) ----------
  // Switch to the car the adapter is plugged into, learn the VIN of the car in
  // use, or offer to add a car that isn't in "My cars" yet.
  const [newCarFound, setNewCarFound] = useState<CarIdentity | null>(null);
  const handledVinRef = useRef<string | null>(null);

  /** The trip being recorded (if it just started) belongs to this car. */
  const switchToCar = useCallback((id: string, name: string) => {
    if (id !== carIdRef.current) {
      selectCar(id);
      toast({ title: t('vin.recognized', 'Recognized your {{name}}', { name }), variant: 'success' });
    }
    if (currentTripRef.current) currentTripRef.current = { ...currentTripRef.current, carId: id };
  }, [selectCar, toast, t]);

  useEffect(() => {
    const vin = obd.vin?.toUpperCase();
    if (!isValidVin(vin) || carsLoading || handledVinRef.current === vin) return;
    handledVinRef.current = vin;
    void (async () => {
      const known = cars.find((c) => c.vin?.toUpperCase() === vin);
      if (known) return switchToCar(known.id, known.name);

      const identity = await identifyVin(vin);
      const selected = cars.find((c) => c.id === carIdRef.current);
      // The car in use has no VIN yet and could be this one; otherwise another
      // car without VIN whose maker and year match.
      const match = selected && !selected.vin && vinFitsCar(identity, selected)
        ? selected
        : cars.find((c) => !c.vin && !!identity.make && c.make?.toLowerCase() === identity.make.toLowerCase() && vinFitsCar(identity, c));
      if (match) {
        try {
          await updateCar(match.id, {
            vin,
            ...(!match.engine_type && identity.engineType ? { engine_type: identity.engineType } : {}),
            ...(!match.trim && identity.trim ? { trim: identity.trim } : {}),
          });
        } catch (err) {
          console.warn('Could not save the VIN:', err);
        }
        return switchToCar(match.id, match.name);
      }
      setNewCarFound(identity);
    })();
  }, [obd.vin, cars, carsLoading, updateCar, switchToCar]);

  const addFoundCar = useCallback(async (details: { make?: string; model?: string } = {}) => {
    const found = newCarFound;
    if (!found) return;
    const car = await createCar({
      make: (details.make?.trim() || found.make) ?? undefined,
      model: (details.model?.trim() || found.model) ?? undefined,
      year: found.year ?? undefined,
      trim: found.trim,
      vin: found.vin,
      engine_type: found.engineType,
    });
    setNewCarFound(null);
    switchToCar(car.id, car.name);
  }, [newCarFound, createCar, switchToCar]);

  const dismissFoundCar = useCallback(() => setNewCarFound(null), []);

  // A trip started: remember which car it belongs to, and who recorded it.
  const recordingStart = recording?.startedAt.getTime() ?? null;
  useEffect(() => {
    if (recordingStart != null) currentTripRef.current = { id: tripKey(recordingStart), carId: carIdRef.current, userId: userIdRef.current };
  }, [recordingStart]);

  // Back up the trip in progress: only what was recorded since the last backup is
  // written (a long drive is not copied whole every time).
  const backupRef = useRef<{ id: string; saved: number; busy: boolean } | null>(null);
  const backUpTrip = useCallback(async () => {
    const current = currentTripRef.current;
    if (!current) return;
    if (backupRef.current?.id !== current.id) backupRef.current = { id: current.id, saved: 0, busy: false };
    const progress = backupRef.current;
    if (progress.busy) return;
    const snap = getRecording(progress.saved);
    if (!snap.startedAt || tripKey(snap.startedAt.getTime()) !== current.id || snap.samples.length === 0) return;
    progress.busy = true;
    try {
      const ok = await appendTripSamples({
        id: current.id, carId: current.carId, userId: current.userId, startedAt: snap.startedAt.getTime(), columns: snap.columns, dtcs: snap.dtcs,
        faultCodes: {
          stored: snap.faultCodes.stored, pending: snap.faultCodes.pending, checked: snap.faultCodes.checked,
          modules: snap.faultCodes.modules, codeModules: snap.faultCodes.codeModules,
        },
      }, snap.samples, progress.saved);
      // If it failed, the same samples go in the next time.
      if (ok) progress.saved += snap.samples.length;
    } finally {
      progress.busy = false;
    }
  }, [getRecording]);
  useEffect(() => {
    if (!recording?.active) return;
    const id = setInterval(() => void backUpTrip(), BACKUP_MS);
    return () => clearInterval(id);
  }, [recording?.active, backUpTrip]);

  // Trips a previous visit didn't finish saving go up at start, whenever the
  // connection comes back, and every few minutes while the app is open.
  useEffect(() => {
    if (!selectedCarId || !userId) return;
    void flushCopies();
    const onOnline = () => void flushCopies();
    window.addEventListener('online', onOnline);
    const id = setInterval(() => void flushCopies(), RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      clearInterval(id);
    };
  }, [selectedCarId, userId, flushCopies]);

  // Before signing out (the session still works): send up the trips waiting on this
  // device. Copies that still can't go up stay, tied to this user, for next time.
  useEffect(() => beforeLogout(() => flushCopies()), [flushCopies]);

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
  // A new app version waits while the car is connected or a trip is open: reloading would drop both.
  useEffect(() => {
    setTripRecording(driving);
  }, [driving]);

  // Android app: a persistent notification keeps everything running with the screen off.
  // It starts only once Bluetooth permission is granted (a link has been open, or the
  // Bluetooth stack was initialized): Android 14+ crashes the service otherwise.
  const serviceText = recording?.active
    ? t('notify.recording', 'Recording your trip')
    : status === 'live'
      ? t('notify.live', 'Car connected')
      : status === 'waiting'
        ? t('notify.waiting', 'Waiting for the car to start')
        : t('notify.reconnecting', 'Looking for the adapter');
  const serviceWanted = (linked && (linkOpen || isBluetoothReady())) || !!recording?.active;
  // The CPU wake lock is only for polling the car; a parked car or a missing adapter lets the phone sleep.
  useEffect(() => {
    if (serviceWanted) void showBackgroundService('Xpeed', serviceText, driving);
    else void hideBackgroundService();
  }, [serviceWanted, serviceText, driving]);
  // Leaving (sign-out): no notification or wake lock left behind.
  useEffect(() => () => { void hideBackgroundService(); }, []);

  const value = useMemo(() => ({
    ...obd, customPids, updateCustomPids, alwaysOn, setAlwaysOn, savingTrip, lastTrip, newCarFound, addFoundCar, dismissFoundCar, canStayOn,
  }), [obd, customPids, updateCustomPids, alwaysOn, setAlwaysOn, savingTrip, lastTrip, newCarFound, addFoundCar, dismissFoundCar, canStayOn]);

  return (
    <ObdScannerContext.Provider value={value}>
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

/**
 * The readings that change every cycle (values, cycle time, samples recorded).
 * Only components that show live numbers should use this: they re-render with
 * every cycle, while useObd() consumers don't.
 */
export function useObdLive(): LiveSnapshot {
  const { live } = useObd();
  return useSyncExternalStore(live.subscribe, live.get, live.get);
}
