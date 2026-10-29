import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Elm327, BleConnectError, connectBleLink, isBluetoothAvailable, type AdapterRef, type ElmInfo, type ObdLink,
} from '@/lib/obd/elm327';
import {
  LIVE_PIDS, ADAPTER_VOLTAGE, pidHeader, pidHex, parseMode01, parseMultiMode01, parseSupportedPids,
  parseCustomReply, parseVin, parseAdapterVoltage, type PidDef,
} from '@/lib/obd/pids';
import { compileFormula } from '@/lib/obd/formula';
import { validateTerminalCommand, type CustomPid } from '@/lib/obd/custom-pids';
import type { ScannerSample } from '@/lib/obd/session-csv';
import { ECU_CANDIDATES, classifyReply, type EcuProbe, type ReplyKind } from '@/lib/obd/scan';
import { TripDetector, type TripEndReason, type TripEvent, type TripReading } from '@/lib/obd/trip-detector';
import { NO_READOUT, mergeReadouts, readFaultCodes, type FaultCodeReadout } from '@/lib/obd/fault-codes';
import { createLiveStore, NO_VALUES } from '@/lib/obd/live-store';
import { logObdDiagnostic } from '@/lib/obd/diagnostic-log';

/**
 * - idle: no adapter linked
 * - connecting: opening the Bluetooth link / resetting the adapter
 * - waiting: adapter linked, car off — standby, probing every few seconds
 * - live: car on, live data flowing
 * - reconnecting: adapter dropped (car off, out of range); trying again on its own
 */
export type ScannerStatus = 'unsupported' | 'idle' | 'connecting' | 'waiting' | 'live' | 'reconnecting';

export interface LiveChannel {
  header: string;
  name: string;
  unit: string;
  min: number;
  max: number;
  /** Standard Mode 01 PID; null for adapter voltage and custom PIDs. */
  def: PidDef | null;
  custom?: CustomPid & { decode: (bytes: number[]) => number | null };
}

export interface ScannerConnection extends ElmInfo {
  deviceName: string;
  transport?: 'ble' | 'classic';
  /** Several PIDs per request (CAN only, verified at connect). */
  multiPid: boolean;
}

export type DtcReadout = FaultCodeReadout;

export interface RecordingState {
  active: boolean;
  startedAt: Date;
  /** Started with the "Start trip" button rather than automatically. */
  manual: boolean;
}

export interface TripResult {
  startedAt: Date;
  endedAt: Date;
  reason: TripEndReason;
  columns: string[];
  samples: ScannerSample[];
  /** Confirmed fault codes seen during this drive (they go in the trip's CSV). */
  dtcs: string[];
  /** Everything read from the car during this drive: confirmed, pending, and whether the read worked. */
  faultCodes: FaultCodeReadout;
}

export interface ObdScannerOptions {
  customPids?: CustomPid[];
  /** Start/stop trips by themselves and reconnect when the adapter drops. */
  alwaysOn?: boolean;
  /** Called with every finished trip worth keeping. */
  onTripEnd?: (trip: TripResult) => void;
  /** Called when a trip ends too short to keep (its backup copy can go). */
  onTripDropped?: (startedAt: Date) => void;
}

const MULTI_PID_BATCH = 6;
/** Short timeout for discovery: absent ECUs just stay silent. */
const SCAN_TIMEOUT_MS = 1500;
const MINUTE = 60_000;

/**
 * How often a parked car is probed on the bus (a full OBD request), backing off
 * the longer it stays off: probing wakes the car's modules and every request
 * draws a little from the 12 V battery. A rise in the adapter's voltage (see
 * RUNNING_VOLTS) probes at once, so a car being started is still noticed quickly.
 */
export function standbyProbeDelay(waitingMs: number): number {
  if (waitingMs < 2 * MINUTE) return 4000;
  if (waitingMs < 10 * MINUTE) return 10_000;
  if (waitingMs < 60 * MINUTE) return 30_000;
  return 60_000;
}

/** How often the adapter's own voltage is read while waiting: it never touches the car's bus. */
export function standbyVoltageDelay(waitingMs: number): number {
  return waitingMs < 10 * MINUTE ? 4000 : 10_000;
}

/** A running engine (or a hybrid in READY) charges the 12 V battery: ~13.5–14.5 V, against ~12.6 V at rest. */
export const RUNNING_VOLTS = 13.0;

/** How long to wait before retrying a dropped adapter, backing off the longer it stays away. */
export function reconnectDelay(awayMs: number): number {
  if (awayMs < 10 * MINUTE) return 5000;
  if (awayMs < 60 * MINUTE) return 30_000;
  return 2 * MINUTE;
}
/** Consecutive silent cycles before the car counts as off. */
const OFF_AFTER_CYCLES = 2;
/** Consecutive cycles in which the adapter didn't answer at all before the link is considered broken. */
const STALL_RECONNECT_CYCLES = 3;
/** How often fault codes are read again while the car is on. */
const FAULT_REREAD_MS = 5 * 60_000;
/** How much rolling history live charts can draw from. */
export const HISTORY_MS = 30 * 60_000;

const SPEED = pidHeader(LIVE_PIDS.find((d) => d.pid === 0x0d)!);
const RPM = pidHeader(LIVE_PIDS.find((d) => d.pid === 0x0c)!);

export interface HistoryPoint {
  /** Epoch ms. */
  at: number;
  values: Record<string, number | null>;
}

export type ScanProgress = (done: number, total: number) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function discoverChannels(elm: Elm327): Promise<LiveChannel[]> {
  const supported = parseSupportedPids(await elm.request('0100'), 0x00);
  for (const base of [0x20, 0x40]) {
    if (!supported.includes(base)) break;
    supported.push(...parseSupportedPids(await elm.request(`01${pidHex(base)}`), base));
  }
  const channels: LiveChannel[] = LIVE_PIDS
    .filter((d) => supported.includes(d.pid))
    .map((d) => ({ header: pidHeader(d), name: d.name, unit: d.unit, min: d.min, max: d.max, def: d }));
  if (!supported.includes(0x42)) {
    channels.push({ ...ADAPTER_VOLTAGE, header: pidHeader(ADAPTER_VOLTAGE), def: null });
  }
  return channels;
}

/** Check the adapter really handles multi-PID requests before relying on them. */
async function probeMultiPid(elm: Elm327, channels: LiveChannel[]): Promise<boolean> {
  const defs = channels.flatMap((c) => (c.def ? [c.def] : [])).slice(0, 2);
  if (defs.length < 2) return false;
  try {
    const reply = await elm.request(`01${defs.map((d) => pidHex(d.pid)).join('')}`);
    const got = parseMultiMode01(reply, defs);
    return defs.every((d) => got.has(d.pid));
  } catch {
    return false;
  }
}

function customChannels(pids: CustomPid[]): LiveChannel[] {
  return pids.map((p) => ({
    header: pidHeader(p),
    name: p.name,
    unit: p.unit,
    min: p.min,
    max: p.max,
    def: null,
    custom: { ...p, decode: compileFormula(p.formula) },
  }));
}


/** The VIN, asking the engine module directly on CAN (several modules may answer a broadcast). */
async function readCarVin(elm: Elm327, isCan: boolean, timeoutMs = 5000): Promise<string | null> {
  for (const header of isCan ? ['7E0', null] : [null]) {
    try {
      const vin = parseVin(await elm.request('0902', header, timeoutMs));
      if (vin) return vin;
    } catch {
      // not reported this way
    }
  }
  return null;
}

/** The adapter's own supply voltage (never touches the car's bus); null if it doesn't say. */
async function readAdapterVoltage(elm: Elm327): Promise<number | null> {
  try {
    return parseAdapterVoltage(await elm.send('ATRV', 2000));
  } catch {
    return null;
  }
}

function recordingColumns(samples: ScannerSample[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const s of samples) {
    for (const k of Object.keys(s.values)) {
      if (!seen.has(k)) { seen.add(k); columns.push(k); }
    }
  }
  return columns;
}

/** What one pass over the car's channels found. */
interface CycleResult {
  values: Record<string, number | null>;
  /**
   * The adapter never answered a standard request this cycle (timeouts / write
   * failures): the link is in trouble, which says nothing about the car. A car
   * that is off still answers, with NO DATA.
   */
  stalled: boolean;
}

/** The same empty list every render, so an omitted option never looks like a change. */
const NO_CUSTOM_PIDS: CustomPid[] = [];

export function useObdScanner({ customPids = NO_CUSTOM_PIDS, alwaysOn = false, onTripEnd, onTripDropped }: ObdScannerOptions = {}) {
  const [status, setStatus] = useState<ScannerStatus>(() => (isBluetoothAvailable() ? 'idle' : 'unsupported'));
  const [error, setError] = useState<string | null>(null);
  /** The Bluetooth link itself failed (adapter busy, asleep or out of range). */
  const [linkFailed, setLinkFailed] = useState(false);
  const [connection, setConnection] = useState<ScannerConnection | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  /** Readings that change every cycle live in their own store (see live-store.ts), not in state. */
  const [live] = useState(createLiveStore);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  useEffect(() => { logObdDiagnostic('state', { status, recording: !!recording?.active }); }, [status, recording?.active]);
  const [autoPaused, setAutoPaused] = useState(false);
  /** The car's VIN (chassis number), read on every new Bluetooth link; null if the car doesn't report it. */
  const [vin, setVin] = useState<string | null>(null);
  /** A Bluetooth link has been open in this session (so Bluetooth permission is granted); stays true while reconnecting. */
  const [linkOpen, setLinkOpen] = useState(false);
  const vinRef = useRef<string | null>(null);
  const vinTriedRef = useRef(false);

  const elmRef = useRef<Elm327 | null>(null);
  const linkRef = useRef<ObdLink | null>(null);
  const deviceRef = useRef<AdapterRef | null>(null);
  /** Bumped to cancel the running connection loop (disconnect, new connect, unmount). */
  const sessionRef = useRef(0);
  /**
   * Bumped for every Bluetooth link within a session: when a link drops and a
   * new one is opened, the old polling loop and late callbacks see they are stale.
   */
  const linkGenRef = useRef(0);
  /** A background reconnect loop is running. */
  const reconnectingRef = useRef(false);
  /** When the adapter was first lost; carried across attempts so the backoff isn't reset by an adapter that connects but won't initialize. */
  const awaySinceRef = useRef<number | null>(null);
  const liveRef = useRef(false);
  /** Live polling yields the bus while a scan runs. */
  const pausedRef = useRef(false);
  const multiRef = useRef(false);
  const standardRef = useRef<LiveChannel[]>([]);
  const channelsRef = useRef<LiveChannel[]>([]);
  const samplesRef = useRef<ScannerSample[]>([]);
  /** Columns of the trip in progress, kept as samples come in (never rescanned). */
  const columnsRef = useRef<string[]>([]);
  const columnSetRef = useRef(new Set<string>());
  const historyRef = useRef<HistoryPoint[]>([]);
  const lastGapLogAt = useRef(0);
  const detectorRef = useRef(new TripDetector());
  const tripStartRef = useRef<Date | null>(null);
  /** Fault codes read since the car came on (at start, then every few minutes). */
  const faultRef = useRef<FaultCodeReadout>(NO_READOUT);
  const manualPendingRef = useRef(false);
  const alwaysOnRef = useRef(alwaysOn);
  const onTripEndRef = useRef(onTripEnd);
  const onTripDroppedRef = useRef(onTripDropped);
  const customPidsRef = useRef(customPids);
  alwaysOnRef.current = alwaysOn;
  onTripEndRef.current = onTripEnd;
  onTripDroppedRef.current = onTripDropped;
  customPidsRef.current = customPids;

  const applyChannels = useCallback((standard: LiveChannel[], custom: CustomPid[]) => {
    const all = [...standard, ...customChannels(custom)];
    channelsRef.current = all;
    setChannels(all);
  }, []);

  // Custom PIDs can be edited while connected.
  useEffect(() => {
    if (standardRef.current.length) applyChannels(standardRef.current, customPids);
  }, [customPids, applyChannels]);

  // ---------- Trips ----------

  const handleTripEvents = useCallback((events: TripEvent[]) => {
    for (const e of events) {
      logObdDiagnostic(`trip-${e.type}`, e.type === 'start' ? { startedAt: e.at } : { endedAt: e.at, reason: e.reason, kept: e.keep });
      if (e.type === 'start') {
        samplesRef.current = [];
        columnsRef.current = [];
        columnSetRef.current = new Set();
        tripStartRef.current = new Date(e.at);
        live.set({ samples: 0 });
        setRecording({ active: true, startedAt: new Date(e.at), manual: manualPendingRef.current });
        manualPendingRef.current = false;
        continue;
      }
      const startedAt = tripStartRef.current;
      tripStartRef.current = null;
      setRecording(null);
      live.set({ samples: 0 });
      if (!startedAt) continue;
      const cutoff = (e.at - startedAt.getTime()) / 1000;
      const samples = e.keep ? samplesRef.current.filter((s) => s.t <= cutoff + 0.001) : [];
      samplesRef.current = [];
      columnsRef.current = [];
      columnSetRef.current = new Set();
      if (samples.length === 0) {
        onTripDroppedRef.current?.(startedAt);
        continue;
      }
      onTripEndRef.current?.({
        startedAt, endedAt: new Date(e.at), reason: e.reason, columns: recordingColumns(samples), samples,
        dtcs: faultRef.current.stored, faultCodes: faultRef.current,
      });
    }
  }, [live]);

  const feedTrip = useCallback((reading: TripReading) => {
    handleTripEvents(detectorRef.current.update(reading, alwaysOnRef.current));
    setAutoPaused(detectorRef.current.autoStartHeld);
  }, [handleTripEvents]);

  /** The adapter can't be reached (stall, reconnecting): says nothing about the car. */
  const feedLinkDown = useCallback(() => {
    feedTrip({ at: Date.now(), ecuAlive: false, speedKmh: null, rpm: null, linkDown: true });
  }, [feedTrip]);

  /** Close the trip in progress, if any, and keep what was recorded. */
  const endOpenTrip = useCallback(() => {
    handleTripEvents(detectorRef.current.stop(Date.now(), 'disconnected'));
  }, [handleTripEvents]);

  // ---------- Live data ----------

  const readCycle = useCallback(async (elm: Elm327, alive: () => boolean): Promise<CycleResult | null> => {
    const next: Record<string, number | null> = {};
    const chans = channelsRef.current;
    let answered = 0;
    let stalled = false;

    const standard = chans.filter((c) => c.def);
    for (let i = 0; i < standard.length;) {
      if (!alive()) return null;
      const batchSize = multiRef.current ? MULTI_PID_BATCH : 1;
      const batch = standard.slice(i, i + batchSize);
      i += batch.length;
      const defs = batch.map((c) => c.def as PidDef);
      try {
        const reply = await elm.request(`01${defs.map((d) => pidHex(d.pid)).join('')}`);
        answered += 1;
        const got = batch.length > 1 ? parseMultiMode01(reply, defs) : null;
        if (got && defs.some((d) => !got.has(d.pid))) {
          logObdDiagnostic('batch-fallback', { requested: defs.length, returned: got.size });
          // Some ELM clones pass the two-PID probe but drop readings in larger
          // batches. Retry missing PIDs individually rather than flashing blanks.
          multiRef.current = false;
          setConnection((previous) => previous && { ...previous, multiPid: false });
          for (const d of defs) {
            if (got.has(d.pid)) continue;
            try {
              const bytes = parseMode01(await elm.request(`01${pidHex(d.pid)}`), d.pid, d.bytes);
              if (bytes) got.set(d.pid, bytes);
            } catch { /* Keep the missing reading null; never invent a value. */ }
            if (!alive()) return null;
          }
        }
        for (const c of batch) {
          const d = c.def as PidDef;
          const bytes = got ? got.get(d.pid) ?? null : parseMode01(reply, d.pid, d.bytes);
          next[c.header] = bytes ? d.decode(bytes) : null;
        }
      } catch {
        if (batch.length > 1) {
          multiRef.current = false;
          setConnection((previous) => previous && { ...previous, multiPid: false });
          logObdDiagnostic('batch-fallback', { requested: defs.length, returned: 0 });
        }
        batch.forEach((c) => { next[c.header] = null; });
        // Nothing has answered yet and this didn't either: the link is in trouble, don't wait on every channel.
        if (answered === 0) {
          stalled = true;
          for (const c of chans) next[c.header] ??= null;
          return alive() ? { values: next, stalled } : null;
        }
      }
    }

    // Several custom PIDs usually decode the same block (e.g. 14 cell
    // voltages in one 2181 reply), so each header+request is sent once per cycle.
    const replies = new Map<string, Promise<string[]>>();
    const fetchOnce = (command: string, header: string | null) => {
      const key = `${header ?? ''}|${command}`;
      if (!replies.has(key)) replies.set(key, elm.request(command, header));
      return replies.get(key)!;
    };

    for (const c of chans) {
      if (c.def || !alive()) continue;
      try {
        if (c.custom) {
          const bytes = parseCustomReply(await fetchOnce(c.custom.command, c.custom.header), c.custom.command);
          next[c.header] = bytes ? c.custom.decode(bytes) : null;
        } else {
          next[c.header] = parseAdapterVoltage(await elm.send('ATRV'));
        }
      } catch {
        next[c.header] = null;
      }
    }
    return alive() ? { values: next, stalled } : null;
  }, []);

  /** Keep one more reading of the trip in progress, tracking its columns as they appear. */
  const recordSample = useCallback((start: Date, now: number, values: Record<string, number | null>) => {
    samplesRef.current.push({ t: (now - start.getTime()) / 1000, values });
    for (const k of Object.keys(values)) {
      if (!columnSetRef.current.has(k)) {
        columnSetRef.current.add(k);
        columnsRef.current.push(k);
      }
    }
  }, []);

  /**
   * One adapter connection: reset the adapter, wait in standby until the car
   * answers, then stream live data — dropping back to standby when it stops.
   */
  const runSession = useCallback(async (link: ObdLink, session: number, gen: number) => {
    const alive = () => sessionRef.current === session && linkGenRef.current === gen;
    const elm = new Elm327(link);
    const version = await elm.initAdapter();
    if (!alive()) return;
    // The adapter answers: if it drops again, the backoff starts afresh.
    awaySinceRef.current = null;
    elmRef.current = elm;
    let info: ElmInfo | null = null;
    let silent = 0;
    let stalls = 0;
    let waitingSince: number | null = null;
    let lastBusProbe = 0;
    let lastFaultRead = 0;
    // Which car is on this link? Asked once per Bluetooth link: the adapter may
    // have been moved to another car since the last one.
    let linkSetupDone = false;

    while (alive()) {
      if (pausedRef.current) {
        await sleep(100);
        continue;
      }

      if (!info) {
        if (waitingSince !== null && lastBusProbe > 0) {
          // Parked: don't poke the bus on every pass. The adapter's voltage costs the car nothing;
          // it rises when the engine (or a hybrid's READY mode) is running, and then we look at once.
          const waited = Date.now() - waitingSince;
          const volts = await readAdapterVoltage(elm);
          if (!alive()) return;
          const running = volts != null && volts >= RUNNING_VOLTS;
          if (!running && Date.now() - lastBusProbe < standbyProbeDelay(waited)) {
            feedTrip({ at: Date.now(), ecuAlive: false, speedKmh: null, rpm: null });
            await sleep(standbyVoltageDelay(waited));
            continue;
          }
        }
        lastBusProbe = Date.now();
        info = await elm.connectVehicle(version, 8000);
        if (!alive()) return;
        if (!info) {
          liveRef.current = false;
          setStatus('waiting');
          feedTrip({ at: Date.now(), ecuAlive: false, speedKmh: null, rpm: null });
          waitingSince ??= Date.now();
          await sleep(standbyVoltageDelay(Date.now() - waitingSince));
          continue;
        }
        waitingSince = null;
        stalls = 0;

        if (!linkSetupDone) {
          const read = await readCarVin(elm, info.isCan, vinTriedRef.current && !vinRef.current ? SCAN_TIMEOUT_MS : 5000);
          if (!alive()) return;
          vinTriedRef.current = true;
          const known = vinRef.current;
          // Only the same VIN proves it's the same car; anything else (another VIN,
          // or one that can't be read) means the PID list and multi-PID support are looked up again.
          if (standardRef.current.length === 0 || !(read && read === known)) {
            const standard = await discoverChannels(elm);
            multiRef.current = info.isCan && (await probeMultiPid(elm, standard));
            standardRef.current = standard;
            applyChannels(standard, customPidsRef.current);
          }
          if (!alive()) return;
          if (read && known && read !== known) {
            // Another car: the trip in progress was the first one's.
            endOpenTrip();
            historyRef.current = [];
          }
          if (read) {
            vinRef.current = read;
            setVin(read);
          }
          linkSetupDone = true;
        }
        silent = 0;
        liveRef.current = true;
        const transport = link.device && 'nativeId' in link.device && link.device.nativeId.startsWith('classic:') ? 'classic' : 'ble';
        setConnection({ ...info, deviceName: link.name, multiPid: multiRef.current, transport });
        setStatus('live');
        // Check the car's fault codes each time it comes on, so trips carry them.
        faultRef.current = await readFaultCodes(elm, info.isCan);
        lastFaultRead = Date.now();
        if (!alive()) return;
        if (manualPendingRef.current) handleTripEvents(detectorRef.current.startManual(Date.now()));
      }

      const t0 = performance.now();
      const cycle = await readCycle(elm, alive);
      if (!cycle) return;
      const { values: next, stalled } = cycle;
      const now = Date.now();

      if (stalled) {
        if (now - lastGapLogAt.current >= 10_000) {
          logObdDiagnostic('read-stall', { recording: detectorRef.current.recording });
          lastGapLogAt.current = now;
        }
        // The adapter isn't answering: not the same as a car that is off. The trip stays open
        // (with a long grace), and if it keeps up the link is replaced.
        stalls += 1;
        feedLinkDown();
        live.set({ values: next, cycleMs: null });
        if (stalls >= STALL_RECONNECT_CYCLES) throw new Error('The adapter stopped answering.');
        continue;
      }
      stalls = 0;

      const ecuAlive = channelsRef.current.some((c) => c.def && next[c.header] != null);

      if (!ecuAlive) {
        silent += 1;
        feedTrip({ at: now, ecuAlive: false, speedKmh: null, rpm: null });
        if (silent >= OFF_AFTER_CYCLES) {
          // Car switched off: stop polling everything, go back to standby probes.
          info = null;
          liveRef.current = false;
          waitingSince = Date.now();
          lastBusProbe = Date.now();
          live.set({ values: NO_VALUES, cycleMs: null });
          setStatus('waiting');
        }
        continue;
      }

      silent = 0;
      // One live chart point per second bounds memory without reducing raw trip recording.
      const latest = historyRef.current[historyRef.current.length - 1];
      if (latest && Math.floor(latest.at / 1000) === Math.floor(now / 1000)) {
        historyRef.current[historyRef.current.length - 1] = { at: now, values: next };
      } else historyRef.current.push({ at: now, values: next });
      while (historyRef.current.length && historyRef.current[0].at < now - HISTORY_MS) historyRef.current.shift();

      const speed = next[SPEED] ?? null;
      // Missing one speed reply is not the same as a car with no speed PID.
      // Do not start a parked trip from RPM while that supported PID is unavailable.
      const speedMissing = speed == null && channelsRef.current.some((channel) => channel.def?.pid === 0x0d);
      const rpmMissing = next[RPM] == null && channelsRef.current.some((channel) => channel.def?.pid === 0x0c);
      if ((speedMissing || rpmMissing) && now - lastGapLogAt.current >= 10_000) {
        logObdDiagnostic('read-gap', { speedMissing, rpmMissing, recording: detectorRef.current.recording });
        lastGapLogAt.current = now;
      }
      feedTrip({ at: now, ecuAlive: true, speedKmh: speed, rpm: speedMissing ? null : next[RPM] ?? null });
      const start = tripStartRef.current;
      if (start) recordSample(start, now, next);
      live.set({ values: next, cycleMs: performance.now() - t0, samples: samplesRef.current.length });
      // Stationary before an automatic trip: no samples/backups/uploads, and
      // fewer sensor requests while waiting for actual movement.
      if (alwaysOnRef.current && !start && next[SPEED] != null && next[SPEED]! < 3) await sleep(2000);

      // A warning light can come on mid-drive: look again every few minutes.
      if (info && now - lastFaultRead >= FAULT_REREAD_MS) {
        lastFaultRead = now;
        const again = await readFaultCodes(elm, info.isCan);
        if (!alive()) return;
        faultRef.current = mergeReadouts(faultRef.current, again);
      }
    }
  }, [applyChannels, endOpenTrip, feedLinkDown, feedTrip, handleTripEvents, live, readCycle, recordSample]);

  const resetConnectionState = useCallback(() => {
    elmRef.current = null;
    liveRef.current = false;
    setConnection(null);
    live.set({ values: NO_VALUES, cycleMs: null });
  }, [live]);

  /** End the current connection loop and close the link; a trip still open is closed and kept. */
  const teardown = useCallback(() => {
    endOpenTrip();
    sessionRef.current += 1;
    linkGenRef.current += 1;
    reconnectingRef.current = false;
    awaySinceRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    resetConnectionState();
    setLinkOpen(false);
    setStatus(isBluetoothAvailable() ? 'idle' : 'unsupported');
  }, [endOpenTrip, resetConnectionState]);

  // Declared below; referenced from the link-lost handler.
  const reconnectRef = useRef<(session: number, gen: number) => void>(() => undefined);

  /** Keep trying the remembered adapter when it dropped or is out of reach: always on, or a trip still open. */
  const shouldReconnect = useCallback(() => (alwaysOnRef.current || detectorRef.current.recording) && !!deviceRef.current, []);

  const startLink = useCallback((link: ObdLink, session: number, gen: number) => {
    linkRef.current = link;
    deviceRef.current = link.device ?? deviceRef.current;
    setLinkOpen(true);
    runSession(link, session, gen).catch((err) => {
      if (sessionRef.current !== session || linkGenRef.current !== gen) return;
      // Adapter stopped answering mid-session (e.g. it went to sleep).
      if (shouldReconnect()) reconnectRef.current(session, gen);
      else {
        setError(err instanceof Error ? err.message : String(err));
        teardown(); // also closes the trip, if one was open
      }
    });
  }, [runSession, shouldReconnect, teardown]);

  const onLinkLost = useCallback((session: number, gen: number) => {
    if (sessionRef.current !== session || linkGenRef.current !== gen) return;
    if (shouldReconnect()) {
      reconnectRef.current(session, gen);
    } else {
      setError('Adapter disconnected.');
      teardown();
    }
  }, [shouldReconnect, teardown]);

  /** Open a Bluetooth link for this session, tagged with a fresh link generation. */
  const openLink = useCallback(async (session: number, opts: { device?: AdapterRef; showAll?: boolean }) => {
    const gen = ++linkGenRef.current;
    const link = await connectBleLink(() => onLinkLost(session, gen), opts);
    return { link, gen };
  }, [onLinkLost]);

  reconnectRef.current = (session: number, gen: number) => {
    // Only the current link may trigger a reconnect, and only once: a drop can
    // be reported both by the link and by the polling loop that hit it.
    if (sessionRef.current !== session || linkGenRef.current !== gen || reconnectingRef.current) return;
    reconnectingRef.current = true;
    linkGenRef.current += 1; // the old polling loop stops at its next check
    linkRef.current?.close();
    linkRef.current = null;
    resetConnectionState();
    setStatus('reconnecting');
    // Back off from when the adapter was first lost, not from this attempt: one that
    // connects but won't initialize comes back through here again and again.
    const retrying = awaySinceRef.current !== null;
    awaySinceRef.current ??= Date.now();
    // Ends when a link is back, or when disconnect/connect/unmount changes the session
    // (those reset reconnectingRef themselves).
    void (async () => {
      let wait = retrying;
      while (sessionRef.current === session) {
        if (wait) {
          await sleep(reconnectDelay(Date.now() - (awaySinceRef.current ?? Date.now())));
          if (sessionRef.current !== session) return;
        }
        wait = true;
        // A computer only keeps looking for the adapter while a trip is open.
        if (!alwaysOnRef.current && !detectorRef.current.recording) {
          setError('Adapter disconnected.');
          teardown();
          return;
        }
        // Lets an open trip end once the adapter has been gone long enough.
        feedLinkDown();
        try {
          const { link, gen: next } = await openLink(session, { device: deviceRef.current ?? undefined });
          if (sessionRef.current !== session) {
            link.close();
            return;
          }
          setStatus('connecting');
          reconnectingRef.current = false;
          startLink(link, session, next);
          return;
        } catch {
          // try again after the backoff
        }
      }
    })();
  };

  /**
   * Link the adapter. Without `device` this opens the Bluetooth chooser and
   * must run inside a click. `device` reopens a remembered adapter silently.
   */
  const connect = useCallback(async (opts: { device?: AdapterRef; showAll?: boolean } = {}) => {
    setError(null);
    setLinkFailed(false);
    // A trip left open by an earlier link ends here, so this connection starts a clean one.
    endOpenTrip();
    const session = ++sessionRef.current;
    reconnectingRef.current = false;
    awaySinceRef.current = null;
    vinTriedRef.current = false;
    vinRef.current = null;
    setVin(null);
    setLinkOpen(false);
    linkRef.current?.close();
    resetConnectionState();
    standardRef.current = [];
    historyRef.current = [];
    setStatus('connecting');
    try {
      const { link, gen } = await openLink(session, opts);
      if (sessionRef.current !== session) {
        link.close();
        return;
      }
      startLink(link, session, gen);
    } catch (err) {
      if (sessionRef.current !== session) return;
      // Always on, reopening the remembered adapter: it is probably just out of
      // range (phone at home, car parked outside). Keep trying in the background.
      if (alwaysOnRef.current && opts.device) {
        deviceRef.current = opts.device;
        reconnectRef.current(session, linkGenRef.current);
        return;
      }
      // User closing the Bluetooth chooser is not an error worth showing.
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && err.name === 'NotFoundError')) setError(msg);
      setLinkFailed(err instanceof BleConnectError);
      teardown();
    }
  }, [endOpenTrip, openLink, resetConnectionState, startLink, teardown]);

  /** User asked to disconnect: close any trip (saving it) and stay off. */
  const disconnect = useCallback(() => {
    manualPendingRef.current = false;
    teardown(); // closes and keeps the trip in progress
    setError(null);
    setLinkFailed(false);
  }, [teardown]);

  // The screen is gone (sign-out, navigation away from the app): close the link
  // and the trip in progress, so what was recorded is handed over to be kept.
  useEffect(() => () => {
    sessionRef.current += 1;
    linkGenRef.current += 1;
    reconnectingRef.current = false;
    endOpenTrip();
    linkRef.current?.close();
    linkRef.current = null;
  }, [endOpenTrip]);

  /** "Start trip" button: record from now on (connect first if needed, inside the click). */
  const startTrip = useCallback(async (opts: { showAll?: boolean } = {}) => {
    manualPendingRef.current = true;
    if (liveRef.current) {
      handleTripEvents(detectorRef.current.startManual(Date.now()));
      // Already recording automatically: it now counts as a manual trip.
      manualPendingRef.current = false;
      setRecording((r) => r && { ...r, manual: true });
      return;
    }
    // Recording begins as soon as the car answers (see runSession). While the
    // remembered adapter is being looked for, don't open the chooser over it.
    if (!linkRef.current && !reconnectingRef.current) await connect(opts);
  }, [connect, handleTripEvents]);

  /** "Stop" button: close the trip now and save it. */
  const stopTrip = useCallback(() => {
    manualPendingRef.current = false;
    handleTripEvents(detectorRef.current.stop(Date.now(), 'manual'));
    setAutoPaused(detectorRef.current.autoStartHeld);
  }, [handleTripEvents]);

  // ---------- Diagnostics & tools (car must be on) ----------

  const requireElm = () => {
    const elm = elmRef.current;
    if (!elm || !liveRef.current) throw new Error('Not connected.');
    return elm;
  };

  const readDtcs = useCallback(async (): Promise<DtcReadout> => {
    const readout = await readFaultCodes(requireElm(), connection?.isCan ?? true, { permanent: true });
    // A fresh read replaces what the trip carries (e.g. right after clearing codes).
    if (readout.checked) faultRef.current = { ...readout, permanent: [] };
    return readout;
  }, [connection]);

  const clearDtcs = useCallback(async () => {
    const lines = await requireElm().request('04', null, 5000);
    if (!lines.some((l) => l.replace(/\s/g, '').startsWith('44'))) {
      throw new Error(`The ECU refused to clear codes (${lines.join(' ') || 'no reply'}).`);
    }
  }, []);

  const readVin = useCallback(async () => parseVin(await requireElm().request('0902', null, 5000)), []);

  /** Read-only terminal: one validated command, optionally to a specific ECU header. */
  const sendRaw = useCallback(async (command: string, header: string | null) => {
    const problem = validateTerminalCommand(command, header);
    if (problem) throw new Error(problem);
    const elm = requireElm();
    return command.startsWith('AT') ? elm.send(command) : elm.request(command, header, 5000);
  }, []);

  const withPollingPaused = async <T,>(job: () => Promise<T>): Promise<T> => {
    pausedRef.current = true;
    try {
      return await job();
    } finally {
      pausedRef.current = false;
    }
  };

  /** Probe common ECU addresses with read requests and report who answers. */
  const findEcus = useCallback(async (onProgress: ScanProgress, signal: AbortSignal): Promise<EcuProbe[]> => {
    const elm = requireElm();
    return withPollingPaused(async () => {
      const found: EcuProbe[] = [];
      for (const [i, header] of ECU_CANDIDATES.entries()) {
        if (signal.aborted || !liveRef.current) break;
        let reply: ReplyKind | null = null;
        for (const cmd of ['2101', '0100']) {
          try {
            const r = classifyReply(await elm.request(cmd, header, SCAN_TIMEOUT_MS), cmd);
            if (r.kind !== 'none') {
              reply = r;
              break;
            }
          } catch {
            // timeout = no ECU at this address
          }
        }
        found.push({ header, reply });
        onProgress(i + 1, ECU_CANDIDATES.length);
      }
      return found;
    });
  }, []);

  /** Try every mode 21 local identifier (2101–21FF) on one ECU; return the ones with data. */
  const sweepMode21 = useCallback(async (header: string, onProgress: ScanProgress, signal: AbortSignal) => {
    const elm = requireElm();
    return withPollingPaused(async () => {
      const hits: { command: string; data: number[] }[] = [];
      for (let pid = 0x01; pid <= 0xff; pid++) {
        if (signal.aborted || !liveRef.current) break;
        const cmd = `21${pidHex(pid)}`;
        try {
          const r = classifyReply(await elm.request(cmd, header, SCAN_TIMEOUT_MS), cmd);
          if (r.kind === 'positive' && r.data.length > 0) hits.push({ command: cmd, data: r.data });
        } catch {
          // no answer for this identifier
        }
        onProgress(pid, 0xff);
      }
      return hits;
    });
  }, []);

  /**
   * Snapshot of the trip being recorded (for crash recovery). `from` skips the
   * samples already backed up: only the new ones are copied, however long the trip.
   */
  const getRecording = useCallback((from = 0) => ({
    startedAt: tripStartRef.current,
    dtcs: faultRef.current.stored,
    faultCodes: faultRef.current,
    columns: [...columnsRef.current],
    /** Samples from index `from` on. */
    samples: from > 0 ? samplesRef.current.slice(from) : samplesRef.current.slice(),
    /** How many samples the trip holds in all. */
    total: samplesRef.current.length,
  }), []);

  const getHistory = useCallback(() => historyRef.current, []);

  // One stable object: its parts only change when something a screen shows changes.
  return useMemo(() => ({
    status, error, linkFailed, connection, channels, recording, autoPaused, vin, linkOpen, live, getHistory,
    connect, disconnect, startTrip, stopTrip, readDtcs, clearDtcs, readVin, sendRaw, findEcus, sweepMode21,
    getRecording,
  }), [
    status, error, linkFailed, connection, channels, recording, autoPaused, vin, linkOpen, live, getHistory,
    connect, disconnect, startTrip, stopTrip, readDtcs, clearDtcs, readVin, sendRaw, findEcus, sweepMode21,
    getRecording,
  ]);
}
