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
