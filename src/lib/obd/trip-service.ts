// Android app only: the native foreground service (android/.../TripService.java)
// that keeps the connection and trip recording alive with the screen off.

import { registerPlugin } from '@capacitor/core';
import { isNativeApp } from './native-ble';

export interface TripNotification {
  vehicle: string;
  status: string;
  speed: string;
  speedUnit: string;
  distance: string;
  distanceUnit: string;
  startedAt: number;
  active: boolean;
  /** Optional so existing APK/web versions remain compatible during an update. */
  state?: 'recording' | 'reconnecting' | 'waiting' | 'live';
  timeLabel?: string;
  openLabel?: string;
  acceleration?: number | null;
  accelerationLabel?: string;
}

interface ServiceOptions {
  trip?: TripNotification;
  title: string;
  text: string;
  /**
   * Keep the CPU awake (a wake lock) so the web layer can poll the car. Only
   * while a trip is recorded or the car is on: waiting for a parked car, the
   * notification alone keeps the connection alive and the phone can sleep.
   */
  awake: boolean;
}

interface TripServicePlugin {
  start(options: ServiceOptions): Promise<void>;
  update(options: ServiceOptions): Promise<void>;
  stop(): Promise<void>;
}

const TripService = registerPlugin<TripServicePlugin>('TripService');

let started = false;

/** Show (or update) the persistent "Xpeed" notification; no-op on the web. */
export async function showBackgroundService(title: string, text: string, awake = true, trip?: TripNotification): Promise<void> {
  if (!isNativeApp()) return;
  try {
    if (started) await TripService.update({ title, text, awake, trip });
    else {
      await TripService.start({ title, text, awake, trip });
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
