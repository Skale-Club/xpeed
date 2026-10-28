// Android app only: the native foreground service (android/.../TripService.java)
// that keeps the connection and trip recording alive with the screen off.

import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './native-ble';

interface TripServicePlugin {
  start(options: { title: string; text: string }): Promise<void>;
  update(options: { title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
}

const TripService = registerPlugin<TripServicePlugin>('TripService');

let started = false;

/** Show (or update) the persistent "Xpeed" notification; no-op on the web. */
export async function showBackgroundService(title: string, text: string): Promise<void> {
  if (!isNativeApp()) return;
  try {
    if (started) await TripService.update({ title, text });
    else {
      await TripService.start({ title, text });
      started = true;
    }
  } catch (err) {
    console.warn('Background service unavailable:', err);
  }
}

export async function hideBackgroundService(): Promise<void> {
  if (!isNativeApp() || !started) return;
  started = false;
  try {
    await TripService.stop();
  } catch (err) {
    console.warn('Could not stop the background service:', err);
  }
}
