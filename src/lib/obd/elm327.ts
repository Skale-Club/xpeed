// ELM327 driver over Web Bluetooth (BLE).
//
// The ELM327 speaks a line-based text protocol: we write "<cmd>\r" and the
// adapter answers with one or more lines terminated by a ">" prompt. Commands
// are serialized through a promise queue so callers (live polling, DTC reads,
// VIN reads) can interleave freely without corrupting each other's replies.
//
// Only BLE adapters work in the browser — Web Bluetooth cannot open classic
// Bluetooth SPP links, and there is no raw TCP for Wi-Fi adapters.

import { connectNativeLink, isNativeApp } from './native-ble';

// Minimal Web Bluetooth typings (lib.dom doesn't ship them).
interface BleCharacteristic extends EventTarget {
  uuid: string;
  properties: { notify: boolean; indicate: boolean; write: boolean; writeWithoutResponse: boolean };
  value?: DataView;
  startNotifications(): Promise<BleCharacteristic>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}
interface BleService {
  uuid: string;
  getCharacteristics(): Promise<BleCharacteristic[]>;
}
interface BleServer {
  connected: boolean;
  connect(): Promise<BleServer>;
  disconnect(): void;
  getPrimaryServices(): Promise<BleService[]>;
}
export interface BleDevice extends EventTarget {
  id: string;
  name?: string;
  gatt?: BleServer;
}
interface BluetoothApi {
  requestDevice(options: unknown): Promise<BleDevice>;
  /** Devices this site was already allowed to use (Chrome); lets us reconnect without the chooser. */
  getDevices?(): Promise<BleDevice[]>;
}

function bluetoothApi(): BluetoothApi | undefined {
  return (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
}

// GATT services used by common BLE OBD2 adapters (Vgate iCar Pro BLE, Veepeak
// BLE+, OBDLink CX, vLinker, generic HM-10 clones). Web Bluetooth only lets us
// see services listed here, so we discover the right characteristics at runtime.
const OBD_BLE_SERVICES: (number | string)[] = [
  0xfff0,
  0xffe0,
  0x18f0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

// Advertised name prefixes of common OBD2 adapters, so the browser's chooser
// lists the adapter instead of every TV and headset nearby.
const OBD_NAME_PREFIXES = [
  'OBD', 'Obd', 'obd', 'VEEPEAK', 'Veepeak', 'Vgate', 'vLinker', 'V-LINK', 'IOS-Vlink', 'Android-Vlink',
  'OBDLink', 'ELM', 'KONNWEI', 'Viecar', 'iCar', 'LELink', 'Carista', 'BlueDriver',
];

// BLE writes are safest in 20-byte chunks (default ATT MTU).
const BLE_CHUNK = 20;

export interface ObdLink {
  write(data: string): Promise<void>;
  onData(cb: (chunk: string) => void): void;
  close(): void;
  readonly name: string;
  /** The Bluetooth device, kept so a dropped link can be reopened without the chooser. */
  readonly device?: AdapterRef;
}

/** A Web Bluetooth device, or an adapter known to the Android app by its id. */
export type AdapterRef = BleDevice | { nativeId: string; name?: string };

const ADAPTER_KEY = 'xpeed.obd.adapter';

/** Remember the adapter the user picked, so next time connects in one tap. */
function rememberAdapter(id: string, name: string) {
  try {
    localStorage.setItem(ADAPTER_KEY, JSON.stringify({ id, name }));
  } catch {
    // Storage blocked: the chooser will just show again next time.
  }
}

export function rememberedAdapterName(): string | null {
  try {
    const raw = localStorage.getItem(ADAPTER_KEY);
    return raw ? (JSON.parse(raw) as { name?: string }).name || null : null;
  } catch {
    return null;
  }
}

export function forgetAdapter() {
  try {
    localStorage.removeItem(ADAPTER_KEY);
  } catch {
    // ignore
  }
}

/** The previously used adapter, if the browser still grants access to it. */
export async function findRememberedAdapter(): Promise<AdapterRef | null> {
  try {
    const raw = localStorage.getItem(ADAPTER_KEY);
    if (!raw) return null;
    const { id, name } = JSON.parse(raw) as { id: string; name?: string };
    // The app can reopen any adapter it paired with by id.
    if (isNativeApp()) return { nativeId: id, name };
    const api = bluetoothApi();
    if (!api?.getDevices) return null;
    const devices = await api.getDevices();
    return devices.find((d) => d.id === id) ?? null;
  } catch {
    return null;
  }
}

/** Bluetooth OBD is possible here: the Android app, or a browser with Web Bluetooth. */
export function isBluetoothAvailable(): boolean {
  return isNativeApp() || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
}

/** GATT connection to the adapter itself failed (busy, asleep or out of range). */
export class BleConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BleConnectError';
  }
}

const GATT_ATTEMPTS = 3;

// Chromium's first GATT connect to a BLE peripheral fails intermittently
// (especially on Windows), so retry a couple of times before giving up.
async function connectGatt(gatt: BleServer): Promise<BleServer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GATT_ATTEMPTS; attempt++) {
    try {
      return await gatt.connect();
    } catch (err) {
      lastError = err;
      if (attempt < GATT_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw new BleConnectError(lastError instanceof Error ? lastError.message : String(lastError));
}

export interface ConnectOptions {
  /** Reopen this device (remembered or just dropped) instead of showing the chooser. */
  device?: AdapterRef;
  /** List every nearby Bluetooth device, for adapters with unusual names. */
  showAll?: boolean;
}

/**
 * Connect to an ELM327 BLE adapter. Without `device` this opens the browser's
 * Bluetooth chooser, which must happen inside a user gesture (click).
 */
export async function connectBleLink(onDisconnect: () => void, options: ConnectOptions = {}): Promise<ObdLink> {
  if (isNativeApp()) {
    const ref = options.device && 'nativeId' in options.device ? options.device : undefined;
    try {
      const link = await connectNativeLink(onDisconnect, OBD_BLE_SERVICES, { deviceId: ref?.nativeId, name: ref?.name });
      rememberAdapter(link.nativeId, link.name);
      return { ...link, device: { nativeId: link.nativeId, name: link.name } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Closing the picker is a cancel, like Web Bluetooth's NotFoundError.
      if (/cancel/i.test(msg)) {
        const cancel = new Error(msg);
        cancel.name = 'NotFoundError';
        throw cancel;
      }
      if (/serial characteristics/.test(msg)) throw err;
      throw new BleConnectError(msg);
    }
  }

  const bluetooth = bluetoothApi();
  if (!bluetooth) throw new Error('Web Bluetooth is not available in this browser.');

  const webDevice = options.device && !('nativeId' in options.device) ? options.device : undefined;
  const device = webDevice ?? await bluetooth.requestDevice(
    options.showAll
      ? { acceptAllDevices: true, optionalServices: OBD_BLE_SERVICES }
      : {
        filters: [
          ...OBD_BLE_SERVICES.map((s) => ({ services: [s] })),
          ...OBD_NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
        ],
        optionalServices: OBD_BLE_SERVICES,
      },
  );
  if (!device.gatt) throw new Error('Selected device has no GATT server.');

  const server = await connectGatt(device.gatt);
  device.addEventListener('gattserverdisconnected', onDisconnect);

  // Anything failing after the GATT connection opened must close it again: some
  // adapters take a single client and would refuse every later attempt until
  // they are unplugged.
  let closed = false;
  const abandon = () => {
    closed = true;
    listeners.length = 0;
    device.removeEventListener('gattserverdisconnected', onDisconnect);
    try {
      if (server.connected) server.disconnect();
    } catch {
      // already gone
    }
  };

  let notifyChar: BleCharacteristic | null = null;
  let writeChar: BleCharacteristic | null = null;
  const listeners: ((chunk: string) => void)[] = [];
  try {
    const services = await server.getPrimaryServices();
    for (const service of services) {
      const chars = await service.getCharacteristics();
      const n = chars.find((c) => c.properties.notify || c.properties.indicate);
      const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
      if (n && w) {
        notifyChar = n;
        writeChar = w;
        break;
      }
    }
    if (!notifyChar || !writeChar) {
      throw new Error('This device does not look like a BLE OBD2 adapter (no serial characteristics found).');
    }

    const decoder = new TextDecoder();
    notifyChar.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as BleCharacteristic).value;
      if (!value) return;
      const chunk = decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      listeners.forEach((cb) => cb(chunk));
    });
    await notifyChar.startNotifications();
  } catch (err) {
    abandon();
    throw err;
  }
  rememberAdapter(device.id, device.name ?? '');

  const encoder = new TextEncoder();
  const w = writeChar;
  return {
    name: device.name || 'OBD2 adapter',
    device,
    async write(data: string) {
      // A closed link never writes again, even from a loop that hasn't noticed yet:
      // after a reconnect those writes would reach the new connection.
      if (closed) throw new Error('The Bluetooth link is closed.');
      const bytes = encoder.encode(data);
      for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
        const part = bytes.slice(i, i + BLE_CHUNK);
        if (w.properties.writeWithoutResponse && w.writeValueWithoutResponse) {
          await w.writeValueWithoutResponse(part);
        } else {
          await w.writeValue(part);
        }
      }
    },
    onData(cb) {
      listeners.push(cb);
    },
    close: abandon,
  };
}

export class ElmTimeoutError extends Error {
  constructor(cmd: string) {
    super(`Adapter did not answer "${cmd}" in time.`);
    this.name = 'ElmTimeoutError';
  }
}

export interface ElmInfo {
  version: string;
  protocol: string;
  isCan: boolean;
}

/**
 * CAN ID an ECU answers from when addressed at `header`. The adapter's
 * automatic filter already accepts the OBD range (7E8–7EF), so this is only
 * needed for other modules, e.g. 7C0 → 7C8 or 18DA10F1 → 18DAF110.
 */
export function receiveAddressFor(header: string): string | null {
  if (header.length === 3) {
    const id = parseInt(header, 16);
    if (id >= 0x7e0 && id <= 0x7e7) return null;
    return (id + 8).toString(16).toUpperCase();
  }
  if (header.length === 8 && header.startsWith('18DA')) {
    return `18DA${header.slice(6, 8)}${header.slice(4, 6)}`;
  }
  return null;
}

/** Functional (broadcast) request header per ATDPN protocol number, CAN only. */
function functionalHeader(protocol: string): string | null {
  if (protocol === '6' || protocol === '8') return '7DF';
  if (protocol === '7' || protocol === '9') return '18DB33F1';
  return null;
}

// Status lines the ELM327 prints that carry no data.
const NOISE_LINES = /^(SEARCHING\.\.\.|BUS INIT:?\s*(\.\.\.)?\s*(OK)?)$/i;

/** After a timeout, how long to wait for the late reply's prompt before nudging the adapter. */
const RESYNC_WAIT_MS = 1200;

const isOk = (lines: string[]) => lines.some((l) => /\bOK\b/i.test(l));

export interface Elm327Options {
  /** How long to wait for a late reply after a timeout (ms); tests shorten it. */
  resyncMs?: number;
}

export class Elm327 {
  private buffer = '';
  private pending: { resolve: (lines: string[]) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Header the adapter is currently addressing (null = unknown), and the broadcast one to return to. */
  private header: string | null = null;
  private defaultHeader: string | null = null;
  /** Explicit CAN receive filter (ATCRA), null when the adapter's automatic one is active, '?' when unknown. */
  private receive: string | null = null;
  /** A command timed out: its reply may still arrive and would be read as the next command's. */
  private desynced = false;
  private lastCmd = '';
  /** Called when a prompt arrives while no command is waiting (a late reply, or the answer to a nudge). */
  private promptWaiter: (() => void) | null = null;
  private resyncMs: number;

  constructor(private link: ObdLink, options: Elm327Options = {}) {
    this.resyncMs = options.resyncMs ?? RESYNC_WAIT_MS;
    link.onData((chunk) => this.handleData(chunk));
  }

  private handleData(chunk: string) {
    this.buffer += chunk;
    const idx = this.buffer.indexOf('>');
    if (idx === -1) return;
    const raw = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    const p = this.pending;
    if (!p) {
      // Late reply to a command that already timed out: it ends here, and
      // whoever is resyncing can move on.
      this.promptWaiter?.();
      return;
    }
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(
      raw
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l && !NOISE_LINES.test(l)),
    );
  }

  /** Resolves true when a prompt arrives within `ms`, false otherwise. */
  private waitForPrompt(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.promptWaiter = null;
        resolve(false);
      }, ms);
      this.promptWaiter = () => {
        clearTimeout(timer);
        this.promptWaiter = null;
        resolve(true);
      };
    });
  }

  /**
   * After a timeout the adapter may still be working on the old command and
   * answer it later. Wait for that prompt (nudging a silent adapter once)
   * before sending anything, or the late reply would be read as the answer to
   * the next command and every reply after it would be off by one.
   */
  private async resync(): Promise<void> {
    const settled = await this.waitForPrompt(this.resyncMs);
    // A bare CR makes the adapter repeat its last command: never after a clear (mode 04).
    if (!settled && this.lastCmd !== '04') {
      try {
        await this.link.write('\r');
        await this.waitForPrompt(this.resyncMs);
      } catch {
        // the link is gone; the next command will fail on its own
      }
    }
    this.buffer = '';
    this.desynced = false;
  }

  private async exec(cmd: string, timeoutMs: number): Promise<string[]> {
    if (this.desynced) await this.resync();
    return new Promise<string[]>((resolve, reject) => {
      this.buffer = '';
      this.lastCmd = cmd;
      const timer = setTimeout(() => {
        this.pending = null;
        this.desynced = true;
        reject(new ElmTimeoutError(cmd));
      }, timeoutMs);
      this.pending = { resolve, timer };
      this.link.write(`${cmd}\r`).catch((err) => {
        clearTimeout(timer);
        this.pending = null;
        this.desynced = true;
        reject(err);
      });
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job, job);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Send one command and resolve with the reply lines (prompt and noise stripped). */
  send(cmd: string, timeoutMs = 3000): Promise<string[]> {
    return this.enqueue(() => this.exec(cmd, timeoutMs));
  }

  /**
   * Send an OBD request to a specific ECU (`header`, e.g. "7E3") or, by
   * default, to the broadcast address. The header switch and the request run
   * as one queued job so concurrent callers can't redirect each other.
   */
  request(cmd: string, header: string | null = null, timeoutMs = 3000): Promise<string[]> {
    return this.enqueue(async () => {
      if (header && !this.defaultHeader) {
        throw new Error('Addressing a specific ECU needs a CAN vehicle.');
      }
      const target = header ?? this.defaultHeader;
      if (target && target !== this.header) {
        await this.configure(`ATSH${target}`, timeoutMs, () => { this.header = target; }, () => { this.header = null; });
      }
      const receive = header ? receiveAddressFor(header) : null;
      if (receive !== this.receive) {
        await this.configure(receive ? `ATCRA${receive}` : 'ATAR', timeoutMs, () => { this.receive = receive; }, () => { this.receive = '?'; });
      }
      return this.exec(cmd, timeoutMs);
    });
  }

  /**
   * Change the adapter's addressing. The cached state only follows what the
   * adapter confirmed with OK; on a missing or refused reply it is marked
   * unknown, so the request is not sent to the wrong ECU and the change is tried again.
   */
  private async configure(cmd: string, timeoutMs: number, apply: () => void, forget: () => void): Promise<void> {
    let ok: boolean;
    try {
      ok = isOk(await this.exec(cmd, timeoutMs));
    } catch (err) {
      forget(); // it may or may not have taken the change
      throw err;
    }
    if (!ok) {
      forget();
      throw new Error(`The adapter did not accept ${cmd}.`);
    }
    apply();
  }

  /** Reset the adapter and configure it for parsing. Works with the car off. Returns the ELM version. */
  async initAdapter(): Promise<string> {
    // Some clones are slow to reboot; a missed ATZ reply is not fatal.
    await this.send('ATZ', 5000).catch(() => undefined);
    for (const cmd of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) {
      await this.send(cmd);
    }
    this.header = null;
    this.defaultHeader = null;
    this.receive = null;
    return (await this.send('ATI')).join(' ');
  }

  /**
   * Try to reach the vehicle's ECUs. Returns null while the car is off (no
   * answer), so callers can wait in standby and try again.
   */
  async connectVehicle(version: string, timeoutMs = 15000): Promise<ElmInfo | null> {
    // The last request may have gone to one ECU (e.g. a 7E2 custom PID): probe
    // the car on the broadcast address again, or a parked car is never seen.
    await this.resetAddressing().catch(() => undefined);
    // The first OBD request triggers the protocol search, which can take a while.
    let probe: string[];
    try {
      probe = await this.send('0100', timeoutMs);
    } catch {
      return null;
    }
    if (!probe.some((l) => l.replace(/\s/g, '').toUpperCase().startsWith('4100'))) {
      this.lastProbe = probe.join(' ') || 'no reply';
      return null;
    }

    const dpn = ((await this.send('ATDPN'))[0] || '').toUpperCase().replace(/^A/, '');
    // After ATSP0 the adapter already uses the functional header.
    this.defaultHeader = functionalHeader(dpn);
    this.header = this.defaultHeader;
    return { version, protocol: dpn, isCan: /^[6-9A-C]$/.test(dpn) };
  }

  /** Back to the broadcast header and the adapter's automatic receive filter. */
  private resetAddressing(): Promise<void> {
    return this.enqueue(async () => {
      if (this.defaultHeader && this.header !== this.defaultHeader) {
        const target = this.defaultHeader;
        await this.configure(`ATSH${target}`, 3000, () => { this.header = target; }, () => { this.header = null; });
      }
      if (this.receive) {
        await this.configure('ATAR', 3000, () => { this.receive = null; }, () => { this.receive = '?'; });
      }
    });
  }

  /** What the ECU answered to the last failed connectVehicle() (for error messages). */
  lastProbe = '';

  /** Reset the adapter, configure it for parsing, and connect to the ECU. */
  async initialize(): Promise<ElmInfo> {
    const version = await this.initAdapter();
    const info = await this.connectVehicle(version);
    if (!info) {
      throw new Error(`Could not talk to the vehicle ECU (${this.lastProbe || 'no reply'}). Is the ignition on?`);
    }
    return info;
  }

  close() {
    this.link.close();
  }
}
