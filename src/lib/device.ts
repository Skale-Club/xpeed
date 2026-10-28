import { isNativeApp } from '@/lib/obd/native-ble';

/**
 * A phone or tablet: the Android app, or a mobile browser. "Always on" (the
 * app left open in the car, recording every trip by itself) only makes sense
 * there; on a computer trips are started by hand.
 */
export function isMobileDevice(): boolean {
  if (isNativeApp()) return true;
  if (typeof navigator === 'undefined') return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)) return true;
  // iPadOS reports a desktop user agent; it has touch and no fine pointer.
  return navigator.maxTouchPoints > 1 && typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}

/** iPhone or iPad (iPadOS reports a Mac user agent, but has touch). */
export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/**
 * Which way of installing Xpeed fits this device:
 * - native: already the Android app, nothing to install;
 * - android: an Android browser, offered the Android app (APK), which keeps
 *   recording with the screen off;
 * - ios: iPhone/iPad, only "Add to Home Screen" (and no Bluetooth to the car);
 * - other: a computer, nothing to offer.
 */
export type InstallKind = 'native' | 'android' | 'ios' | 'other';

export function installKind(): InstallKind {
  if (isNativeApp()) return 'native';
  if (typeof navigator === 'undefined') return 'other';
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (isIOSDevice()) return 'ios';
  return 'other';
}
