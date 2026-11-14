import { readPreference, writePreference } from '@/lib/browser-storage';
import { publicAppUrl } from '@/lib/trips';
import type { TFunction } from 'i18next';
import { formatLapTime } from '@/lib/sim/analysis';
import { cleanName, sharePagePath, type Share, type Visibility } from '@/lib/sim/social-client';

/** The handle as people write it: `@lap_fan`. */
export const atHandle = (handle: string) => `@${handle}`;

/** Up to two capitals for an avatar: the first letters of the first two words of the name, else the first two letters or digits of the handle. */
export function initialsOf(displayName: string | null | undefined, handle: string): string {
  const words = (cleanName(displayName) ?? '').split(/\s+/).filter(Boolean);
  const letter = (text: string) => [...text].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? '';
  const fromName = words.slice(0, 2).map(letter).join('');
  if (fromName) return fromName.toUpperCase();
  const fromHandle = [...handle].filter((char) => /[a-z0-9]/i.test(char)).slice(0, 2).join('');
  return (fromHandle || '?').toUpperCase();
}

/** A steady colour (a hue from 0 to 359) for a handle, so the same driver always has the same avatar. */
export function avatarHue(handle: string): number {
  let hash = 0;
  for (const char of handle) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The handle a person typed, the way the server reads it: trimmed, a leading @ dropped, lower-cased. */
export const normalizeHandle = (typed: string) => typed.trim().replace(/^@/, '').toLowerCase();

export type HandleProblem = 'empty' | 'short' | 'long' | 'characters';
/** What is wrong with a handle before the server is asked: 3 to 24 characters of a to z, 0 to 9 and _. Null when it can be sent. */
export function handleProblem(handle: string): HandleProblem | null {
  if (!handle) return 'empty';
  if (!/^[a-z0-9_]*$/.test(handle)) return 'characters';
  if (handle.length < 3) return 'short';
  if (handle.length > 24) return 'long';
  return null;
}

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

/** Puts text on the clipboard; falls back to selecting a field for browsers without the async API. Resolves to whether it worked. */
export async function copyText(text: string, field: HTMLTextAreaElement | HTMLInputElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    field?.select();
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

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

/** The most options drawn at once: a long catalog is narrowed by typing. */
export const COMBO_LIMIT = 200;

/** Lower case, without accents, so "sao paulo" finds "São Paulo". */
export const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The options whose label has every word of the query (accents and case ignored). An empty query keeps them all. */
export function filterOptions<T extends { label: string }>(options: readonly T[], query: string): T[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...options];
  return options.filter((option) => {
    const label = fold(option.label);
    return words.every((word) => label.includes(word));
  });
}

/** What a link is about, in one line: the track and car with the lap time, or with the kind and the laps of the session; null when the server did not say. */
export function aboutShare(share: Share, t: TFunction): string | null {
  if (!share.trackName || !share.carName) return null;
  const values = { track: share.trackName, car: share.carName };
  if (share.kind === 'lap') return typeof share.lapMs === 'number' ? t('social.share.aboutLap', '{{track}} · {{car}} · {{time}}', { ...values, time: formatLapTime(share.lapMs) }) : null;
  if (typeof share.lapCount !== 'number') return null;
  const kind = share.sessionKind && share.sessionKind !== 'unknown' ? t(`modes.sessions.kind.${share.sessionKind}`, share.sessionKind) : null;
  return kind
    ? t('social.share.aboutSession', '{{track}} · {{car}} · {{kind}} · {{count}} laps', { ...values, kind, count: share.lapCount })
    : t('social.share.aboutSessionPlain', '{{track}} · {{car}} · {{count}} laps', { ...values, count: share.lapCount });
}

/** How much of a link's life is gone, 0 to 1; null for a link that never ends. A link that ended is all gone. */
export function lifeSpent(share: Pick<Share, 'createdAt' | 'expiresAt' | 'active'>, now = Date.now()): number | null {
  if (!share.expiresAt) return null;
  const from = Date.parse(share.createdAt);
  const to = Date.parse(share.expiresAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return share.active ? null : 1;
  return Math.min(1, Math.max(0, (now - from) / (to - from)));
}

/** What each level shows to other people (docs/platform/API-V1.md, "Visibility rules"): the rows of the preview under each choice. */
export const VISIBILITY_SHOWS: Record<Visibility, { publicBoard: boolean; friendsBoard: boolean; page: boolean; findable: boolean }> = {
  public: { publicBoard: true, friendsBoard: true, page: true, findable: true },
  friends: { publicBoard: false, friendsBoard: true, page: true, findable: true },
  private: { publicBoard: false, friendsBoard: false, page: false, findable: false },
};
