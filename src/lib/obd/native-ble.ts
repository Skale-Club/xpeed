// ObdLink over the phone's own Bluetooth stack, for the Android app (Capacitor).
// Same contract as the Web Bluetooth link in elm327.ts; unlike the browser,
// it keeps working with the screen off while the trip service runs.

import { Capacitor } from '@capacitor/core';
import type { ObdLink } from './elm327';

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

const BLE_CHUNK = 20;

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
  if (Capacitor.getPlatform() === 'android' && !(await BleClient.isEnabled())) {
    // Ask to turn Bluetooth on only when the person tapped to connect; the
    // background reconnect just waits for it instead of prompting every few seconds.
    if (opts.deviceId) throw new Error('Bluetooth is off.');
    await BleClient.requestEnable();
  }

  let deviceId = opts.deviceId;
  let name = opts.name ?? '';
  if (!deviceId) {
    const device = await BleClient.requestDevice({ optionalServices: serviceUuids.map(toUuid) });
    deviceId = device.deviceId;
    name = device.name ?? '';
  }
  const id = deviceId;

  // Our own close() also triggers the plugin's disconnect callback; only report real drops.
  let closed = false;
  await BleClient.connect(id, () => { if (!closed) onDisconnect(); }, { timeout: 15000 });

  const known = serviceUuids.map(toUuid);
  const services = await BleClient.getServices(id);
  // Prefer the known OBD serial services, then anything with notify + write.
  const ordered = [
    ...services.filter((s) => known.includes(s.uuid.toLowerCase())),
    ...services.filter((s) => !known.includes(s.uuid.toLowerCase())),
  ];
  let target: { service: string; notify: string; write: string; withoutResponse: boolean } | null = null;
  for (const s of ordered) {
    const n = s.characteristics.find((c) => c.properties.notify || c.properties.indicate);
    const w = s.characteristics.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    if (n && w) {
      target = { service: s.uuid, notify: n.uuid, write: w.uuid, withoutResponse: !!w.properties.writeWithoutResponse };
      break;
    }
  }
  if (!target) {
    await BleClient.disconnect(id).catch(() => undefined);
    throw new Error('This device does not look like a BLE OBD2 adapter (no serial characteristics found).');
  }

  const listeners: ((chunk: string) => void)[] = [];
  const decoder = new TextDecoder();
  await BleClient.startNotifications(id, target.service, target.notify, (value) => {
    const chunk = decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    listeners.forEach((cb) => cb(chunk));
  });

  const encoder = new TextEncoder();
  const t = target;
  return {
    name: name || 'OBD2 adapter',
    nativeId: id,
    async write(data: string) {
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
      void BleClient.stopNotifications(id, t.service, t.notify).catch(() => undefined);
      void BleClient.disconnect(id).catch(() => undefined);
    },
  };
}
