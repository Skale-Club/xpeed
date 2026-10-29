import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ObdLink } from './elm327';
import i18n from '@/lib/i18n';

interface SerialEvent { connectionId: string; data?: string }
interface SerialPlugin {
  choose(options: { title: string; bleLabel: string; pairLabel: string }): Promise<{ ble?: boolean; deviceId?: string; name?: string }>;
  connect(options: { deviceId: string; connectionId: string }): Promise<void>;
  write(options: { connectionId: string; data: string }): Promise<void>;
  disconnect(options: { connectionId: string }): Promise<void>;
  addListener(event: 'data' | 'disconnected', callback: (event: SerialEvent) => void): Promise<PluginListenerHandle>;
}
const Serial = registerPlugin<SerialPlugin>('ObdSerial');
export const CLASSIC_PREFIX = 'classic:';

// Older installed APKs keep their BLE flow until the native update is installed.
export function hasClassicBluetooth(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('ObdSerial');
}

export async function chooseNativeAdapter() {
  return Serial.choose({
    title: i18n.t('scanner.adapterPicker', 'Choose OBD2 adapter'),
    bleLabel: i18n.t('scanner.findBle', 'Find Bluetooth LE adapter'),
    pairLabel: i18n.t('scanner.pairClassic', 'Pair a Classic adapter'),
  });
}

export async function connectSerialLink(
  deviceId: string, name: string, onDisconnect: () => void,
): Promise<ObdLink & { nativeId: string }> {
  const connectionId = crypto.randomUUID();
  const listeners: ((data: string) => void)[] = [];
  const subscriptions: PluginListenerHandle[] = [];
  let closed = false;
  let dropped = false;
  let ready = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    listeners.length = 0;
    await Serial.disconnect({ connectionId }).catch(() => undefined);
    await Promise.all(subscriptions.map((sub) => sub.remove()));
  };
  try {
    subscriptions.push(await Serial.addListener('data', (event) => {
      if (!closed && event.connectionId === connectionId && event.data) {
        listeners.forEach((callback) => callback(event.data!));
      }
    }));
    subscriptions.push(await Serial.addListener('disconnected', (event) => {
      if (!closed && !dropped && event.connectionId === connectionId) {
        dropped = true;
        if (ready) onDisconnect();
      }
    }));
    await Serial.connect({ deviceId, connectionId });
    if (dropped) throw new Error('Classic Bluetooth disconnected while opening.');
    ready = true;
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    nativeId: CLASSIC_PREFIX + deviceId,
    name: name || 'OBD2 adapter',
    async write(data) {
      if (closed || dropped) throw new Error('The Bluetooth link is closed.');
      await Serial.write({ connectionId, data });
    },
    onData(callback) { listeners.push(callback); },
    close() { void cleanup(); },
  };
}
