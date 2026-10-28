import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Elm327, BleConnectError, connectBleLink, isBluetoothAvailable, type AdapterRef, type ElmInfo, type ObdLink,
} from '@/lib/obd/elm327';
import {
  LIVE_PIDS, ADAPTER_VOLTAGE, pidHeader, pidHex, parseMode01, parseMultiMode01, parseSupportedPids,
  parseCustomReply, parseDtcReply, parseVin, parseAdapterVoltage, type PidDef,
} from '@/lib/obd/pids';
import { compileFormula } from '@/lib/obd/formula';
import { validateTerminalCommand, type CustomPid } from '@/lib/obd/custom-pids';
import type { ScannerSample } from '@/lib/obd/session-csv';
import { ECU_CANDIDATES, classifyReply, type EcuProbe, type ReplyKind } from '@/lib/obd/scan';
import { TripDetector, type TripEndReason, type TripEvent, type TripReading } from '@/lib/obd/trip-detector';

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
  /** Several PIDs per request (CAN only, verified at connect). */
  multiPid: boolean;
}

export interface DtcReadout {
  stored: string[];
  pending: string[];
  permanent: string[];
}

export interface RecordingState {
  active: boolean;
  startedAt: Date;
  samples: number;
  /** Started with the "Start trip" button rather than automatically. */
  manual: boolean;
}

export interface TripResult {
  startedAt: Date;
  endedAt: Date;
  reason: TripEndReason;
  columns: string[];
  samples: ScannerSample[];
  /** Stored + pending fault codes read when the car came on. */
  dtcs: string[];
}

export interface ObdScannerOptions {
  customPids?: CustomPid[];
  /** Start/stop trips by themselves and reconnect when the adapter drops. */
  alwaysOn?: boolean;
  /** Called with every finished trip worth keeping. */
  onTripEnd?: (trip: TripResult) => void;
}

const MULTI_PID_BATCH = 6;
/** Short timeout for discovery: absent ECUs just stay silent. */
const SCAN_TIMEOUT_MS = 1500;
/** How often a parked car is checked for being switched on. */
const STANDBY_PROBE_MS = 4000;
/** How often a dropped adapter is retried. */
const RECONNECT_MS = 5000;
/** Consecutive silent cycles before the car counts as off. */
const OFF_AFTER_CYCLES = 2;
/** How much rolling history live charts can draw from. */
export const HISTORY_MS = 120_000;

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

/** Stored and pending fault codes; failures just mean "none read". */
async function readFaultCodes(elm: Elm327, isCan: boolean): Promise<string[]> {
  const codes = new Set<string>();
  for (const [mode, responseByte] of [['03', 0x43], ['07', 0x47]] as const) {
    try {
      parseDtcReply(await elm.request(mode, null, 5000), responseByte, isCan).forEach((c) => codes.add(c));
    } catch {
      // no answer
    }
  }
  return Array.from(codes);
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

export function useObdScanner({ customPids = [], alwaysOn = false, onTripEnd }: ObdScannerOptions = {}) {
  const [status, setStatus] = useState<ScannerStatus>(() => (isBluetoothAvailable() ? 'idle' : 'unsupported'));
  const [error, setError] = useState<string | null>(null);
  /** The Bluetooth link itself failed (adapter busy, asleep or out of range). */
  const [linkFailed, setLinkFailed] = useState(false);
  const [connection, setConnection] = useState<ScannerConnection | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [values, setValues] = useState<Record<string, number | null>>({});
  const [cycleMs, setCycleMs] = useState<number | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);

  const elmRef = useRef<Elm327 | null>(null);
  const linkRef = useRef<ObdLink | null>(null);
  const deviceRef = useRef<AdapterRef | null>(null);
  /** Bumped to cancel the running connection loop (disconnect, new connect, unmount). */
  const sessionRef = useRef(0);
  const liveRef = useRef(false);
  /** Live polling yields the bus while a scan runs. */
  const pausedRef = useRef(false);
  const multiRef = useRef(false);
  const standardRef = useRef<LiveChannel[]>([]);
  const channelsRef = useRef<LiveChannel[]>([]);
  const samplesRef = useRef<ScannerSample[]>([]);
  const historyRef = useRef<HistoryPoint[]>([]);
  const detectorRef = useRef(new TripDetector());
  const tripStartRef = useRef<Date | null>(null);
  const dtcsRef = useRef<string[]>([]);
  const manualPendingRef = useRef(false);
  const alwaysOnRef = useRef(alwaysOn);
  const onTripEndRef = useRef(onTripEnd);
  const customPidsRef = useRef(customPids);
  alwaysOnRef.current = alwaysOn;
  onTripEndRef.current = onTripEnd;
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
      if (e.type === 'start') {
        samplesRef.current = [];
        tripStartRef.current = new Date(e.at);
        setRecording({ active: true, startedAt: new Date(e.at), samples: 0, manual: manualPendingRef.current });
        manualPendingRef.current = false;
        continue;
      }
      const startedAt = tripStartRef.current;
      tripStartRef.current = null;
      setRecording(null);
      if (!startedAt || !e.keep) continue;
      const cutoff = (e.at - startedAt.getTime()) / 1000;
      const samples = samplesRef.current.filter((s) => s.t <= cutoff + 0.001);
      samplesRef.current = [];
      if (samples.length === 0) continue;
      onTripEndRef.current?.({
        startedAt, endedAt: new Date(e.at), reason: e.reason, columns: recordingColumns(samples), samples, dtcs: dtcsRef.current,
      });
    }
  }, []);

  const feedTrip = useCallback((reading: TripReading) => {
    handleTripEvents(detectorRef.current.update(reading, alwaysOnRef.current));
  }, [handleTripEvents]);

  // ---------- Live data ----------

  const readCycle = useCallback(async (elm: Elm327, alive: () => boolean) => {
    const next: Record<string, number | null> = {};
    const chans = channelsRef.current;

    const standard = chans.filter((c) => c.def);
    const batchSize = multiRef.current ? MULTI_PID_BATCH : 1;
    for (let i = 0; i < standard.length; i += batchSize) {
      if (!alive()) return null;
      const batch = standard.slice(i, i + batchSize);
      const defs = batch.map((c) => c.def as PidDef);
      try {
        const reply = await elm.request(`01${defs.map((d) => pidHex(d.pid)).join('')}`);
        const got = batch.length > 1 ? parseMultiMode01(reply, defs) : null;
        for (const c of batch) {
          const d = c.def as PidDef;
          const bytes = got ? got.get(d.pid) ?? null : parseMode01(reply, d.pid, d.bytes);
          next[c.header] = bytes ? d.decode(bytes) : null;
        }
      } catch {
        batch.forEach((c) => { next[c.header] = null; });
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
    return alive() ? next : null;
  }, []);

  /**
   * One adapter connection: reset the adapter, wait in standby until the car
   * answers, then stream live data — dropping back to standby when it stops.
   */
  const runSession = useCallback(async (link: ObdLink, session: number) => {
    const alive = () => sessionRef.current === session;
    const elm = new Elm327(link);
    elmRef.current = elm;
    const version = await elm.initAdapter();
    let info: ElmInfo | null = null;
    let silent = 0;

    while (alive()) {
      if (pausedRef.current) {
        await sleep(100);
        continue;
      }

      if (!info) {
        info = await elm.connectVehicle(version, 8000);
        if (!alive()) return;
        if (!info) {
          liveRef.current = false;
          setStatus('waiting');
          feedTrip({ at: Date.now(), ecuAlive: false, speedKmh: null, rpm: null });
          await sleep(STANDBY_PROBE_MS);
          continue;
        }
        // Same adapter session: the car's PID list is already known after a restart.
        if (standardRef.current.length === 0) {
          const standard = await discoverChannels(elm);
          multiRef.current = info.isCan && (await probeMultiPid(elm, standard));
          standardRef.current = standard;
          applyChannels(standard, customPidsRef.current);
        }
        if (!alive()) return;
        silent = 0;
        liveRef.current = true;
        setConnection({ ...info, deviceName: link.name, multiPid: multiRef.current });
        setStatus('live');
        // Check the car's fault codes each time it comes on, so trips carry them.
        dtcsRef.current = await readFaultCodes(elm, info.isCan);
        if (!alive()) return;
        if (manualPendingRef.current) handleTripEvents(detectorRef.current.startManual(Date.now()));
      }

      const t0 = performance.now();
      const next = await readCycle(elm, alive);
      if (!next) return;
      const now = Date.now();
      const ecuAlive = channelsRef.current.some((c) => c.def && next[c.header] != null);

      if (!ecuAlive) {
        silent += 1;
        feedTrip({ at: now, ecuAlive: false, speedKmh: null, rpm: null });
        if (silent >= OFF_AFTER_CYCLES) {
          // Car switched off: stop polling everything, go back to standby probes.
          info = null;
          liveRef.current = false;
          setValues({});
          setCycleMs(null);
          setStatus('waiting');
        }
        continue;
      }

      silent = 0;
      historyRef.current.push({ at: now, values: next });
      while (historyRef.current.length && historyRef.current[0].at < now - HISTORY_MS) historyRef.current.shift();
      setValues(next);
      setCycleMs(performance.now() - t0);

      feedTrip({ at: now, ecuAlive: true, speedKmh: next[SPEED] ?? null, rpm: next[RPM] ?? null });
      const start = tripStartRef.current;
      if (start) {
        samplesRef.current.push({ t: (now - start.getTime()) / 1000, values: next });
        setRecording((r) => r && { ...r, samples: samplesRef.current.length });
      }
    }
  }, [applyChannels, feedTrip, handleTripEvents, readCycle]);

  const resetConnectionState = () => {
    elmRef.current = null;
    liveRef.current = false;
    setConnection(null);
    setCycleMs(null);
    setValues({});
  };

  /** End the current connection loop and close the link. */
  const teardown = useCallback(() => {
    sessionRef.current += 1;
    linkRef.current?.close();
    linkRef.current = null;
    resetConnectionState();
    setStatus(isBluetoothAvailable() ? 'idle' : 'unsupported');
  }, []);

  // Declared below; referenced from the link-lost handler.
  const reconnectRef = useRef<(session: number) => void>(() => undefined);

  const startLink = useCallback((link: ObdLink, session: number) => {
    linkRef.current = link;
    deviceRef.current = link.device ?? deviceRef.current;
    runSession(link, session).catch((err) => {
      if (sessionRef.current !== session) return;
      // Adapter stopped answering mid-session (e.g. it went to sleep).
      if (alwaysOnRef.current && deviceRef.current) reconnectRef.current(session);
      else {
        setError(err instanceof Error ? err.message : String(err));
        teardown();
      }
    });
  }, [runSession, teardown]);

  const onLinkLost = useCallback((session: number) => {
    if (sessionRef.current !== session) return;
    if ((alwaysOnRef.current || tripStartRef.current) && deviceRef.current) {
      reconnectRef.current(session);
    } else {
      handleTripEvents(detectorRef.current.stop(Date.now(), 'disconnected'));
      setError('Adapter disconnected.');
      teardown();
    }
  }, [handleTripEvents, teardown]);

  reconnectRef.current = (session: number) => {
    // Keep the same "session" so the loop is cancelled by disconnect/unmount.
    linkRef.current?.close();
    linkRef.current = null;
    resetConnectionState();
    setStatus('reconnecting');
    void (async () => {
      while (sessionRef.current === session) {
        // Lets an open trip end once the car has been silent long enough.
        feedTrip({ at: Date.now(), ecuAlive: false, speedKmh: null, rpm: null });
        try {
          const link = await connectBleLink(() => onLinkLost(session), { device: deviceRef.current ?? undefined });
          if (sessionRef.current !== session) {
            link.close();
            return;
          }
          setStatus('connecting');
          startLink(link, session);
          return;
        } catch {
          await sleep(RECONNECT_MS);
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
    const session = ++sessionRef.current;
    linkRef.current?.close();
    resetConnectionState();
    standardRef.current = [];
    historyRef.current = [];
    setStatus('connecting');
    try {
      const link = await connectBleLink(() => onLinkLost(session), opts);
      if (sessionRef.current !== session) {
        link.close();
        return;
      }
      startLink(link, session);
    } catch (err) {
      if (sessionRef.current !== session) return;
      // User closing the Bluetooth chooser is not an error worth showing.
      const msg = err instanceof Error ? err.message : String(err);
      if (!(err instanceof Error && err.name === 'NotFoundError')) setError(msg);
      setLinkFailed(err instanceof BleConnectError);
      teardown();
    }
  }, [onLinkLost, startLink, teardown]);

  /** User asked to disconnect: close any trip (saving it) and stay off. */
  const disconnect = useCallback(() => {
    manualPendingRef.current = false;
    handleTripEvents(detectorRef.current.stop(Date.now(), 'disconnected'));
    setError(null);
    setLinkFailed(false);
    teardown();
  }, [handleTripEvents, teardown]);

  useEffect(() => () => {
    sessionRef.current += 1;
    linkRef.current?.close();
  }, []);

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
    // Recording begins as soon as the car answers (see runSession).
    if (!linkRef.current) await connect(opts);
  }, [connect, handleTripEvents]);

  /** "Stop" button: close the trip now and save it. */
  const stopTrip = useCallback(() => {
    manualPendingRef.current = false;
    handleTripEvents(detectorRef.current.stop(Date.now(), 'manual'));
  }, [handleTripEvents]);

  // ---------- Diagnostics & tools (car must be on) ----------

  const requireElm = () => {
    const elm = elmRef.current;
    if (!elm || !liveRef.current) throw new Error('Not connected.');
    return elm;
  };

  const readDtcs = useCallback(async (): Promise<DtcReadout> => {
    const elm = requireElm();
    const isCan = connection?.isCan ?? true;
    const read = async (mode: string, responseByte: number) => {
      try {
        return parseDtcReply(await elm.request(mode, null, 5000), responseByte, isCan);
      } catch {
        return [];
      }
    };
    return {
      stored: await read('03', 0x43),
      pending: await read('07', 0x47),
      permanent: await read('0A', 0x4a),
    };
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

  /** Snapshot of the trip being recorded (for crash recovery). */
  const getRecording = useCallback(() => ({
    startedAt: tripStartRef.current,
    dtcs: dtcsRef.current,
    columns: recordingColumns(samplesRef.current),
    samples: samplesRef.current,
  }), []);

  const getHistory = useCallback(() => historyRef.current, []);

  return {
    status, error, linkFailed, connection, channels, values, cycleMs, recording, getHistory,
    connect, disconnect, startTrip, stopTrip, readDtcs, clearDtcs, readVin, sendRaw, findEcus, sweepMode21,
    getRecording,
  };
}
