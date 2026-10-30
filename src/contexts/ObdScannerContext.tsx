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
import { findSessionStartedAt } from '@/lib/db';
import { recordedSessionId, RecordingConflictError } from '@/lib/recorded-session';
import { formatAppDate } from '@/lib/app-date';
import { loadCustomPids, saveCustomPids, type CustomPid } from '@/lib/obd/custom-pids';
import { buildScannerCsv, scannerFilename } from '@/lib/obd/session-csv';
import { findRememberedAdapter, isBluetoothAvailable } from '@/lib/obd/elm327';
import { isBluetoothReady, isNativeApp } from '@/lib/obd/native-ble';
import { isMobileDevice } from '@/lib/device';
import { holdAppUpdates, setTripRecording } from '@/lib/pwa-update';
import { beforeLogout } from '@/lib/logout';
import {
  appendTripSamples, deleteTripCopy, getTripCopy, listTripCopies, saveTripCopy, tripKey, type StoredTrip,
} from '@/lib/obd/trip-store';
import { checkpointTrip, finalizeCloudTrip, recoverCloudTrips, removeCloudTrip } from '@/lib/obd/trip-cloud';
import { hideBackgroundService, showBackgroundService } from '@/lib/obd/trip-service';
import { PID_PRESETS, mergePreset } from '@/lib/obd/presets';
import { DEFAULT_TRIP_OPTIONS } from '@/lib/obd/trip-detector';
import type { LiveSnapshot } from '@/lib/obd/live-store';
import { identifyVin, isValidVin, vinFitsCar, type CarIdentity } from '@/lib/vin';
import { logObdDiagnostic } from '@/lib/obd/diagnostic-log';
import { TripMotion } from '@/lib/obd/trip-motion';

// The Bluetooth OBD connection belongs to the whole signed-in app, not to one
// page. In "always on" mode it also runs the car on its own: it reconnects
// to the remembered adapter, waits in standby while the car is off, records
// a trip whenever the car is driven and saves it when the car is turned off.
// Every trip is kept on the device until it is in the database, and trips
// that couldn't be saved are retried when the connection comes back.

const ALWAYS_ON_KEY = 'xpeed.obd.alwaysOn';
/** How often the trip in progress is backed up for crash recovery. */
const BACKUP_MS = 5_000;
const CLOUD_BACKUP_MS = 15_000;
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

interface TripSave {
  id: string;
  userId: string | null;
  carId: string | null;
  status: 'keeping' | 'pending' | 'memory' | 'saved';
  sessionId?: string;
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
  /** Latest trip ended here; background retries do not replace the recording card's state. */
  tripSave: TripSave | null;
  getTripSyncStatus: () => Promise<{ pending: number; latestError: string | null; cloud?: { samples: number; at: number } | null }>;
  retryPendingTrips: () => Promise<void>;
  lastTrip: SavedTrip | null;
  /** Car bound to the active recording, even if the owner browses another car. */
  recordingCarId: string | null;
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

  useEffect(() => {
    const car = cars.find(item => item.id === selectedCarId);
    if (car?.make?.toLowerCase() !== 'toyota' || !/^prius$/i.test(car.model || '') || !car.year || car.year < 2010 || car.year > 2015) return;
    const preset = PID_PRESETS.find(item => item.id === 'prius-gen3');
    if (!preset) return;
    setCustomPids(previous => {
      const next = mergePreset(previous, preset.pids());
      if (next.length === previous.length) return previous;
      saveCustomPids(selectedCarId, next); return next;
    });
  }, [cars, selectedCarId]);

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
  const [lastTrip, setLastTrip] = useState<(SavedTrip & { userId: string; carId: string }) | null>(null);
  const [tripSave, setTripSave] = useState<TripSave | null>(null);

  const tripName = useCallback((startedAt: Date) => {
    const when = formatAppDate(startedAt, i18n.resolvedLanguage, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    return t('trip.name', 'Trip {{when}}', { when });
  }, [t, i18n.resolvedLanguage]);

  // The trip being recorded: its copy's key, the car it belongs to (the car
  // selected when it started, even if another one is picked meanwhile) and who recorded it.
  const currentTripRef = useRef<{ id: string; carId: string | null; userId: string | null } | null>(null);
  const backupRef = useRef<{ id: string; saved: number; pending: Promise<boolean> | null } | null>(null);
  /** Trips that just ended or were dropped: their copy is being written or removed, so a retry must leave it alone. */
  const finishingRef = useRef(new Set<string>());
  /** Copies the device couldn't store (no IndexedDB, disk full): kept here so they still get uploaded. */
  const memoryCopiesRef = useRef(new Map<string, StoredTrip>());
  const memoryUpdateHolds = useRef(new Map<string, () => void>());
  const reportedConflicts = useRef(new Set<string>());

  /** Does this copy belong to whoever is signed in now? */
  const isMine = useCallback((copy: StoredTrip): boolean => {
    const me = userIdRef.current;
    if (!me) return false;
    if (copy.userId) return copy.userId === me;
    // Older copies don't say who recorded them: they are this user's if their car is.
    return copy.carId != null && carsRef.current.some((c) => c.id === copy.carId);
  }, []);

  const syncErrorRef = useRef<{ userId: string | null; message: string } | null>(null);
  const cloudProgress = useRef(new Map<string, { saved: number; pending: Promise<void> | null; at: number }>());
  const syncCloud = useCallback(async (copy: StoredTrip, startOffset = 0) => {
    let progress = cloudProgress.current.get(copy.id);
    if (!progress) { progress = { saved: 0, pending: null, at: 0 }; cloudProgress.current.set(copy.id, progress); }
    const state = progress;
    const work = (state.pending ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (!copy.carId || !copy.userId || copy.userId !== userIdRef.current) return;
      const { samples, endedAt, ...meta } = copy;
      while (state.saved < startOffset + samples.length) {
        const chunk = samples.slice(state.saved - startOffset, state.saved - startOffset + 50);
        const accepted = await checkpointTrip(meta, chunk, state.saved);
        if (!Number.isSafeInteger(accepted) || accepted <= 0) throw Error('Cloud checkpoint did not confirm saved samples');
        state.saved += accepted;
        state.at = Date.now();
      }
      if (endedAt) await checkpointTrip({ ...meta, endedAt, totalSamples: startOffset + samples.length }, [], state.saved);
    });
    state.pending = work;
    try { await work; } finally { if (state.pending === work) state.pending = null; }
  }, []);
  const savingRef = useRef(0);
  const bumpSaving = useCallback((by: number) => {
    savingRef.current += by;
    setSavingTrip(savingRef.current > 0);
  }, []);

  /**
   * Put one trip copy in the database, then remove it from the device. If a
   * previous attempt committed but its response/backup cleanup was lost, the
   * stable identity is recognized without replacing the saved trip.
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
      memoryUpdateHolds.current.get(id)?.();
      memoryUpdateHolds.current.delete(id);
      // A checkpoint already in flight must finish before removing its files,
      // or its late response could recreate an already committed recording.
      await cloudProgress.current.get(id)?.pending?.catch(() => {});
      void removeCloudTrip(copy).catch(error => console.warn('Cloud checkpoint cleanup deferred:', error));
      cloudProgress.current.delete(id);
      if (!(await deleteTripCopy(id))) console.warn('The saved trip copy could not be removed; it will be checked on retry.');
    };
    // A copy without an end time is a recording the app never got to finish.
    const recovered = copy.endedAt == null;
    if (recovered && copy.samples[copy.samples.length - 1].t < MIN_RECOVERED_TRIP_S) {
      // Cut off before it was even a trip; the detector would have dropped it.
      await forget();
      return;
    }
    bumpSaving(1);
    let saving = true;
    const finishSaving = () => { if (saving) { saving = false; bumpSaving(-1); } };
    try {
      const startedAt = new Date(copy.startedAt);
      const endedAt = new Date(copy.endedAt ?? copy.startedAt + copy.samples[copy.samples.length - 1].t * 1000);
      const owner = userIdRef.current;
      if (!owner || !isMine(copy)) return;
      const sessionId = await recordedSessionId(owner, carId, tripKey(copy.startedAt));
      logObdDiagnostic('trip-upload-start', { recovered, samples: copy.samples.length });
      const earlier = await findSessionStartedAt(carId, startedAt);
      if (earlier && earlier !== sessionId) {
        // Legacy uploads have no reliable completion receipt. Keep both for review.
        throw new RecordingConflictError('A legacy trip already exists at this start time. The saved trip and device copy have been preserved.');
      }

      const csv = buildScannerCsv(copy.columns, copy.samples, copy.dtcs ?? []);
      const file = new File([csv], scannerFilename(startedAt), { type: 'text/csv' });
      let result: { sessionId: string };
      let committed: string | null = null;
      let confirmStored!: (result: { sessionId: string }) => void;
      const storedReceipt = new Promise<{ sessionId: string }>(resolve => { confirmStored = resolve; });
      const onStored = async (savedId: string) => {
        if (committed) return;
        committed = savedId;
        // The receipt, not AI analysis/cleanup, is the end of saving.
        finishSaving();
        if (userIdRef.current === owner) {
          syncErrorRef.current = null;
          setLastTrip({ sessionId: savedId, endedAt, userId: owner, carId });
          setTripSave(previous => previous?.id === id && previous.userId === owner
            ? { ...previous, status: 'saved', sessionId: savedId } : previous);
        }
        logObdDiagnostic('trip-upload-committed', { samples: copy.samples.length });
        await forget();
        confirmStored({ sessionId: savedId });
      };
      try {
        // Once committed and cleaned up, release the upload queue as well.
        // Optional analysis keeps running without delaying the next trip's save.
        result = await Promise.race([
          ingestSessionCsv(file, carId, tripName(startedAt), undefined, onStored, copy.faultCodes, { sessionId, userId: owner, startedAt: startedAt.toISOString() }),
          storedReceipt,
        ]);
      } catch (error) {
        if (committed) result = { sessionId: committed };
        else {
          if (error instanceof RecordingConflictError) throw error;
          try {
            await syncCloud({ ...copy, carId, userId: owner, endedAt: endedAt.getTime() });
            const restoredId = await finalizeCloudTrip({ ...copy, carId, userId: owner });
            if (restoredId !== sessionId) throw Error('Cloud receipt does not match this trip');
            result = { sessionId: restoredId };
            await onStored(restoredId);
          } catch (cloudError) {
            throw Error(`${error instanceof Error ? error.message : 'Trip save failed'}. Cloud recovery: ${cloudError instanceof Error ? cloudError.message : 'pending'}`);
          }
        }
      }
      await onStored(result.sessionId);
      if (userIdRef.current === owner) toast({
        title: recovered ? t('trip.recovered', 'Saved a trip that was interrupted') : t('trip.saved', 'Trip saved'),
        description: t('trip.savedHint', 'You can see it in History.'),
        variant: 'success',
      });
    } catch (err) {
      console.error('Trip save failed:', err);
      logObdDiagnostic('trip-upload-pending', { conflict: err instanceof RecordingConflictError, keptOnDevice: !memoryCopiesRef.current.has(id) });
      syncErrorRef.current = { userId: copy.userId ?? userIdRef.current, message: err instanceof Error ? err.message.slice(0, 500) : 'Trip save failed' };
      const conflict = err instanceof RecordingConflictError;
      if (announceFailure() || (conflict && !reportedConflicts.current.has(id))) {
        if (conflict) reportedConflicts.current.add(id);
        const kept = !memoryCopiesRef.current.has(id);
        toast({
          title: kept && !conflict ? t('trip.keptPending', 'Trip kept on this device; upload pending') : t('trip.saveFailed', "Couldn't save the trip"),
          description: conflict ? t('trip.saveConflict', 'A saved trip overlaps this recording. Both copies were kept for review; the saved trip was not replaced.') : kept
            ? t('trip.saveFailedHint', "It's kept on this device and will be saved by itself when there's internet.")
            : t('trip.saveFailedNoCopy', "It couldn't be kept on this device either, so leave the app open: it keeps trying while it's open."),
          variant: kept ? 'warning' : 'destructive',
        });
      }
    } finally {
      finishSaving();
    }
  }, [bumpSaving, isMine, t, toast, tripName, syncCloud]);

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
    for (const car of carsRef.current) {
      try {
        for (const copy of await recoverCloudTrips(car.id)) {
          if (!isMine(copy) || copy.id === currentTripRef.current?.id || ids.has(copy.id) || finishingRef.current.has(copy.id)) continue;
          if (!(await getTripCopy(copy.id)) && !memoryCopiesRef.current.has(copy.id)) {
            if (await saveTripCopy(copy)) await uploadCopy(copy.id, false);
          }
        }
      } catch (error) { console.warn('Cloud recovery deferred:', error); }
    }
  }, [uploadCopy, isMine]);

  const getTripSyncStatus = useCallback(async () => {
    const copies = new Map((await listTripCopies()).map(copy => [copy.id, copy]));
    for (const [id, copy] of memoryCopiesRef.current) copies.set(id, copy);
    const progress = currentTripRef.current ? cloudProgress.current.get(currentTripRef.current.id) : null;
    return { cloud: progress?.at ? { samples: progress.saved, at: progress.at } : null, pending: [...copies.values()].filter(copy => isMine(copy) && copy.id !== currentTripRef.current?.id && !finishingRef.current.has(copy.id)).length,
      latestError: syncErrorRef.current?.userId === userIdRef.current ? syncErrorRef.current?.message ?? null : null };
  }, [isMine]);
  const retryPendingTrips = useCallback(async () => { await flushCopies(); }, [flushCopies]);

  const saveTrip = useCallback(async (trip: TripResult) => {
    const releaseUpdate = holdAppUpdates();
    const id = tripKey(trip.startedAt.getTime());
    const current = currentTripRef.current?.id === id ? currentTripRef.current : null;
    const carId = current ? current.carId : carIdRef.current;
    const owner = current ? current.userId : userIdRef.current;
    setTripSave({ id, userId: owner, carId, status: 'keeping' });
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
      // Do not let a delayed append recreate a partial copy after the finished
      // copy was committed and deleted. No new append starts while finishing.
      if (backupRef.current?.id === id) await backupRef.current.pending;
      const kept = await saveTripCopy(copy);
      setTripSave(previous => previous?.id === id ? { ...previous, status: kept ? 'pending' : 'memory' } : previous);
      logObdDiagnostic('trip-copy-kept', { onDevice: kept, samples: copy.samples.length });
      if (!kept) {
        memoryCopiesRef.current.set(id, copy);
        memoryUpdateHolds.current.set(id, releaseUpdate);
      } else releaseUpdate();
      if (currentTripRef.current?.id === id) currentTripRef.current = null;
      // Leaving (signed out): the copy stays on the device for its owner.
      if (leavingRef.current) return;
      // The direct atomic save need not wait for a second full cloud upload.
      // Cloud finalization is the fallback if that save fails.
      if (navigator.onLine !== false) await uploadCopy(id, true);
    } finally {
      if (!memoryCopiesRef.current.has(id)) releaseUpdate();
      finishingRef.current.delete(id);
    }
  }, [uploadCopy]);

  const dropTrip = useCallback((startedAt: Date) => {
    const id = tripKey(startedAt.getTime());
    const bound = currentTripRef.current?.id === id ? currentTripRef.current : null;
    if (bound) currentTripRef.current = null;
    finishingRef.current.add(id);
    const owner = bound?.userId ?? userIdRef.current, car = bound?.carId ?? carIdRef.current;
    const pending = backupRef.current?.id === id ? backupRef.current.pending : null;
    const cloudPending = cloudProgress.current.get(id)?.pending;
    void Promise.all([pending, cloudPending?.catch(() => {})]).then(async () => {
      if (owner && car) void removeCloudTrip({ id, userId: owner, carId: car }).catch(() => {});
      cloudProgress.current.delete(id);
      await deleteTripCopy(id);
    }).finally(() => finishingRef.current.delete(id));
  }, []);

  const obd = useObdScanner({ customPids, alwaysOn, onTripEnd: (trip) => void saveTrip(trip), onTripDropped: dropTrip });
  const { status, recording, getRecording, connect, linkOpen } = obd;
  const [recordingCarId, setRecordingCarId] = useState<string | null>(null);

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
    if (currentTripRef.current) {
      currentTripRef.current = { ...currentTripRef.current, carId: id };
      setRecordingCarId(id);
    }
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
            ...(!match.body_type && identity.bodyType ? { body_type: identity.bodyType } : {}),
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
      body_type: found.bodyType,
    });
    setNewCarFound(null);
    switchToCar(car.id, car.name);
  }, [newCarFound, createCar, switchToCar]);

  const dismissFoundCar = useCallback(() => setNewCarFound(null), []);

  // A trip started: remember which car it belongs to, and who recorded it.
  const recordingStart = recording?.startedAt.getTime() ?? null;
  useEffect(() => {
    if (recordingStart != null) {
      currentTripRef.current = { id: tripKey(recordingStart), carId: carIdRef.current, userId: userIdRef.current };
      setRecordingCarId(carIdRef.current);
    }
  }, [recordingStart]);

  // Back up the trip in progress: only what was recorded since the last backup is
  // written (a long drive is not copied whole every time).
  const backUpTrip = useCallback(async () => {
    const current = currentTripRef.current;
    if (!current || finishingRef.current.has(current.id)) return;
    if (backupRef.current?.id !== current.id) backupRef.current = { id: current.id, saved: 0, pending: null };
    const progress = backupRef.current;
    if (progress.pending) return;
    const snap = getRecording(progress.saved);
    if (!snap.startedAt || tripKey(snap.startedAt.getTime()) !== current.id || snap.samples.length === 0) return;
    try {
      progress.pending = appendTripSamples({
        id: current.id, carId: current.carId, userId: current.userId, startedAt: snap.startedAt.getTime(), columns: snap.columns, dtcs: snap.dtcs,
        faultCodes: {
          stored: snap.faultCodes.stored, pending: snap.faultCodes.pending, checked: snap.faultCodes.checked,
          modules: snap.faultCodes.modules, codeModules: snap.faultCodes.codeModules,
        },
      }, snap.samples, progress.saved);
      const ok = await progress.pending;
      // If it failed, the same samples go in the next time.
      if (ok) progress.saved += snap.samples.length;
    } finally {
      progress.pending = null;
    }
  }, [getRecording]);
  useEffect(() => {
    if (!recording?.active) return;
    void backUpTrip();
    const id = setInterval(() => void backUpTrip(), BACKUP_MS);
    return () => clearInterval(id);
  }, [recording?.active, backUpTrip]);

  useEffect(() => {
    if (!recording?.active) return;
    const upload = async () => {
      const current = currentTripRef.current;
      if (!current || !current.carId || !current.userId || navigator.onLine === false || cloudProgress.current.get(current.id)?.pending) return;
      const offset = cloudProgress.current.get(current.id)?.saved ?? 0;
      const snap = getRecording(offset);
      if (!snap.startedAt || tripKey(snap.startedAt.getTime()) !== current.id || !snap.samples.length) return;
      try {
        await syncCloud({ ...current, startedAt: snap.startedAt.getTime(), columns: snap.columns, samples: snap.samples, dtcs: snap.dtcs, faultCodes: snap.faultCodes }, offset);
      } catch (error) {
        syncErrorRef.current = { userId: current.userId, message: error instanceof Error ? error.message.slice(0,500) : 'Cloud checkpoint pending' };
      }
    };
    void upload();
    const id = setInterval(() => void upload(), CLOUD_BACKUP_MS);
    return () => clearInterval(id);
  }, [recording?.active, getRecording, syncCloud]);

  // Trips a previous visit didn't finish saving go up at start, whenever the
  // connection comes back, and every few minutes while the app is open.
  useEffect(() => {
    if (!selectedCarId || !userId) return;
    void flushCopies();
    const onOnline = () => void flushCopies();
    window.addEventListener('online', onOnline);
    const visible = () => { if (document.visibilityState === 'visible') void flushCopies(); };
    document.addEventListener('visibilitychange', visible);
    const id = setInterval(() => void flushCopies(), RETRY_MS);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', visible);
      clearInterval(id);
    };
  }, [selectedCarId, userId, flushCopies]);

  // Before signing out (the session still works): send up the trips waiting on this
  // device. Copies that still can't go up stay, tied to this user, for next time.
  useEffect(() => beforeLogout(() => flushCopies()), [flushCopies]);

  // On app start in always-on mode: reconnect to the adapter used last time, no chooser.
  const resumedRef = useRef(false);
  const resumeState = useRef({ status, alwaysOn });
  resumeState.current = { status, alwaysOn };
  useEffect(() => {
    if (resumedRef.current || !alwaysOn || status !== 'idle' || !isBluetoothAvailable()) return;
    resumedRef.current = true;
    let cancelled = false;
    void findRememberedAdapter().then((device) => {
      if (!cancelled && device && resumeState.current.alwaysOn && resumeState.current.status === 'idle') {
        void connect({ device, onlyIfIdle: true });
      }
    }).catch(error => console.warn('Remembered adapter unavailable:', error));
    return () => { cancelled = true; };
  }, [alwaysOn, connect, status]);

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
  const serviceText = recording?.active && status === 'live'
    ? t('notify.recordingShort', 'Recording')
    : status === 'live'
      ? t('notify.live', 'Car connected')
      : status === 'waiting'
        ? t('notify.waiting', 'Waiting for the car to start')
        : t('notify.reconnectingShort', 'Reconnecting');
  const notificationTimeLabel = t('notify.time', 'Time');
  const notificationOpenLabel = t('notify.open', 'Open Xpeed');
  const serviceWanted = (linked && (linkOpen || isBluetoothReady())) || !!recording?.active;
  // The CPU wake lock is only for polling the car; a parked car or a missing adapter lets the phone sleep.
  useEffect(() => {
    if (!serviceWanted) { void hideBackgroundService(); return; }
    // Sample independently of React renders. Integrate only real consecutive
    // speed samples; a disconnected gap never becomes distance travelled.
    let offset = 0;
    let previous: { t: number; speed: number | null } | null = null;
    let distanceKm = 0;
    const motion = new TripMotion();
    const update = () => {
      const snapshot = getRecording(offset);
      for (const sample of snapshot.samples) {
        const raw = sample.values['Vehicle speed (km/h)'];
        const speed = raw != null && Number.isFinite(raw) && raw >= 0 ? raw : null;
        motion.update(sample.t, speed);
        if (previous && speed != null && previous.speed != null) {
          const seconds = sample.t - previous.t;
          if (seconds > 0 && seconds <= 30) distanceKm += (speed + previous.speed) / 2 * seconds / 3600;
        }
        previous = { t: sample.t, speed };
      }
      offset = snapshot.total;
      let miles = false;
      try { miles = localStorage.getItem('settings_distanceUnit') === 'mi'; } catch { /* defaults */ }
      const rawSpeed = status === 'live' ? obd.live.get().values['Vehicle speed (km/h)'] : null;
      const speed = rawSpeed != null && Number.isFinite(rawSpeed) ? Math.max(0, rawSpeed) : null;
      const recent = snapshot.startedAt && previous && Date.now() - snapshot.startedAt.getTime() - previous.t * 1000 <= 15_000;
      const acceleration = speed != null && recent ? motion.acceleration : null;
      const accelerationLabel = acceleration == null ? t('notify.noMotion', 'Waiting for readings')
        : acceleration > 0.15 ? t('notify.accelerating', 'Accelerating')
        : acceleration < -0.15 ? t('notify.slowing', 'Slowing down')
        : t('notify.steady', 'Steady speed');
      const car = carsRef.current.find((c) => c.id === (recording?.active ? recordingCarId || carIdRef.current : carIdRef.current));
      void showBackgroundService('Xpeed', serviceText, driving, {
        vehicle: car?.name || 'Xpeed', status: serviceText,
        state: status === 'live' ? (recording?.active ? 'recording' : 'live') : status === 'waiting' ? 'waiting' : 'reconnecting',
        timeLabel: notificationTimeLabel, openLabel: notificationOpenLabel,
        acceleration, accelerationLabel,
        active: !!recording?.active, startedAt: recording?.startedAt?.getTime() || 0,
        speed: speed == null ? '—' : Math.round(speed * (miles ? 0.621371 : 1)).toString(),
        speedUnit: miles ? 'mph' : 'km/h',
        distance: snapshot.samples.length || offset ? (distanceKm * (miles ? 0.621371 : 1)).toFixed(1) : '—',
        distanceUnit: miles ? 'mi' : 'km',
      });
    };
    update();
    const timer = setInterval(update, 5000);
    return () => clearInterval(timer);
  }, [serviceWanted, serviceText, notificationTimeLabel, notificationOpenLabel, t, driving, recording?.active, recording?.startedAt, recordingCarId, getRecording, obd.live, status]);
  // Leaving (sign-out): no notification or wake lock left behind.
  useEffect(() => () => { void hideBackgroundService(); }, []);

  const value = useMemo(() => ({
    ...obd, customPids, updateCustomPids, alwaysOn, setAlwaysOn, savingTrip, getTripSyncStatus, retryPendingTrips,
    tripSave: tripSave?.userId === userId && tripSave.carId === selectedCarId ? tripSave : null,
    lastTrip: lastTrip?.userId === userId && lastTrip.carId === selectedCarId ? lastTrip : null,
    recordingCarId, newCarFound, addFoundCar, dismissFoundCar, canStayOn,
  }), [obd, customPids, updateCustomPids, alwaysOn, setAlwaysOn, savingTrip, getTripSyncStatus, retryPendingTrips, lastTrip, tripSave, userId, selectedCarId, recordingCarId, newCarFound, addFoundCar, dismissFoundCar, canStayOn]);

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
