// ObdLink over the phone's own Bluetooth stack, for the Android app (Capacitor).
// Same contract as the Web Bluetooth link in elm327.ts; unlike the browser,
// it keeps working with the screen off while the trip service runs.

import { Capacitor } from '@capacitor/core';
import type { ObdLink } from './elm327';
import { CLASSIC_PREFIX, chooseNativeAdapter, connectSerialLink, hasClassicBluetooth } from './native-serial';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

const BLE_CHUNK = 20;

// Set once BleClient.initialize() has succeeded: on Android 12+ that is when the
// "Nearby devices" permission is granted. The background service (type
// "connected device") may only start from then on, or Android 14+ throws.
let bluetoothReady = false;

export function isBluetoothReady(): boolean {
  return bluetoothReady;
}

function toUuid(service: number | string): string {
  if (typeof service === 'string') return service.toLowerCase();
  return `0000${service.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

export interface NativeConnectOptions {
  /** Reconnect to this adapter without showing the picker. */
  deviceId?: string;
  name?: string;
}

/**
 * Pick (or reopen) an adapter and open its serial characteristics. Throws a
 * plain Error; the caller maps link failures to BleConnectError.
 */
export async function connectNativeLink(
  onDisconnect: () => void,
  serviceUuids: (number | string)[],
  opts: NativeConnectOptions = {},
): Promise<ObdLink & { nativeId: string }> {
  const { BleClient } = await import('@capacitor-community/bluetooth-le');
  await BleClient.initialize({ androidNeverForLocation: true });
  bluetoothReady = true;
  if (Capacitor.getPlatform() === 'android' && !(await BleClient.isEnabled())) {
    // Ask to turn Bluetooth on only when the person tapped to connect; the
    // background reconnect just waits for it instead of prompting every few seconds.
    if (opts.deviceId) throw new Error('Bluetooth is off.');
    await BleClient.requestEnable();
  }

  let deviceId = opts.deviceId;
  let name = opts.name ?? '';
  if (deviceId?.startsWith(CLASSIC_PREFIX)) {
    if (!hasClassicBluetooth()) throw new Error('Install the latest Xpeed APK to use Classic Bluetooth.');
    return connectSerialLink(deviceId.slice(CLASSIC_PREFIX.length), name, onDisconnect);
  }
  if (!deviceId && hasClassicBluetooth()) {
    const selected = await chooseNativeAdapter();
    if (selected.deviceId) return connectSerialLink(selected.deviceId, selected.name ?? '', onDisconnect);
  }
  if (!deviceId) {
    const device = await BleClient.requestDevice({ optionalServices: serviceUuids.map(toUuid) });
    deviceId = device.deviceId;
    name = device.name ?? '';
  }
  const id = deviceId;

  // Our own close() also triggers the plugin's disconnect callback; only report real drops.
  let closed = false;
  let ready = false;
  let activeAttempt = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    activeAttempt = attempt;
    try {
      await BleClient.connect(id, () => {
        // Android also reports disconnects for failed connection attempts.
        // Those belong to this opening operation, not the scanner's reconnect loop.
        if (!closed && ready && activeAttempt === attempt) onDisconnect();
      }, { timeout: 20000 });
      break;
    } catch (err) {
      await BleClient.disconnect(id).catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 3 || /permission|denied|unauthori[sz]ed|not enabled|off/i.test(message)) {
        closed = true;
        throw new Error(`Bluetooth connection: ${message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  // Whatever fails once the GATT connection is open must close it again: an
  // adapter that takes a single client would refuse every later attempt until
  // it is unplugged.
  let target: { service: string; notify: string; write: string; withoutResponse: boolean } | null = null;
  const listeners: ((chunk: string) => void)[] = [];
  try {
    const known = serviceUuids.map(toUuid);
    const services = await BleClient.getServices(id);
    // Prefer the known OBD serial services, then anything with notify + write.
    const ordered = [
      ...services.filter((s) => known.includes(s.uuid.toLowerCase())),
      ...services.filter((s) => !known.includes(s.uuid.toLowerCase())),
    ];
    for (const s of ordered) {
      const n = s.characteristics.find((c) => c.properties.notify || c.properties.indicate);
      const w = s.characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
      if (n && w) {
        target = { service: s.uuid, notify: n.uuid, write: w.uuid, withoutResponse: !!w.properties.writeWithoutResponse };
        break;
      }
    }
    if (!target) {
      throw new Error('This device does not look like a BLE OBD2 adapter (no serial characteristics found).');
    }

    const decoder = new TextDecoder();
    await BleClient.startNotifications(id, target.service, target.notify, (value) => {
      const chunk = decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      listeners.forEach((cb) => cb(chunk));
    });
  } catch (err) {
    closed = true; // our own disconnect is not a drop to report
    await BleClient.disconnect(id).catch(() => undefined);
    throw err;
  }

  const encoder = new TextEncoder();
  const t = target;
  ready = true;
  return {
    name: name || 'OBD2 adapter',
    nativeId: id,
    async write(data: string) {
      if (closed) throw new Error('The Bluetooth link is closed.');
      const bytes = encoder.encode(data);
      for (let i = 0; i < bytes.length; i += BLE_CHUNK) {
        const part = bytes.slice(i, i + BLE_CHUNK);
        const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
        if (t.withoutResponse) await BleClient.writeWithoutResponse(id, t.service, t.write, view);
        else await BleClient.write(id, t.service, t.write, view);
      }
    },
    onData(cb) {
      listeners.push(cb);
    },
    close() {
      closed = true;
      listeners.length = 0;
      void BleClient.stopNotifications(id, t.service, t.notify).catch(() => undefined);
      void BleClient.disconnect(id).catch(() => undefined);
    },
  };
}
