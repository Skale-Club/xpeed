import { readPreference, writePreference } from '@/lib/browser-storage';
import { publicAppUrl } from '@/lib/trips';
import { sharePagePath } from '@/lib/sim/social-client';

/** The handle as people write it: `@lap_fan`. */
export const atHandle = (handle: string) => `@${handle}`;

/** "12th" in English, "12º" in Portuguese, "12.º" in Spanish. */
export function ordinal(n: number, language: string): string {
  const lang = language.toLowerCase();
  if (lang.startsWith('pt')) return `${n}º`;
  if (lang.startsWith('es')) return `${n}.º`;
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** The address people open for a token. */
export const shareUrl = (token: string) => `${publicAppUrl()}${sharePagePath(token)}`;

/** Hands a Blob to the browser as a file the person saves. Only ever called from the person's own click. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked a moment later: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Where the dismissal is kept: this browser, one record per signed-in person. */
export const PROFILE_NOTICE_KEY = 'xpeed.virtual-profile-notice.v1';
const key = (userId: string) => `${PROFILE_NOTICE_KEY}:${userId}`;

/** Whether this person already dismissed the notice. Storage that is blocked reads as "not yet" (the banner shows, and that is all). */
export function noticeDismissed(userId: string): boolean {
  try {
    return readPreference(key(userId)) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(userId: string) {
  try {
    writePreference(key(userId), '1');
  } catch {
    /* blocked storage: the banner goes away for this visit only */
  }
}

const MAX_POINTS = 300;

/** The speed along the lap as `{ km, kmh }` points, thinned to about 300 so a phone draws it at once. Samples with no value are skipped. */
export function speedPoints(file: { data: Record<string, Float32Array> }): Array<{ km: number; kmh: number }> {
  const dist = file.data.dist;
  const speed = file.data.speed;
  if (!dist || !speed || dist.length === 0) return [];
  const step = Math.max(1, Math.ceil(dist.length / MAX_POINTS));
  const points: Array<{ km: number; kmh: number }> = [];
  for (let i = 0; i < dist.length; i += step) {
    if (!Number.isFinite(dist[i]) || !Number.isFinite(speed[i])) continue;
    points.push({ km: Math.round(dist[i]) / 1000, kmh: Math.round(speed[i] * 3.6) });
  }
  return points;
}
