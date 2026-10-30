// Friendly facts about a trip (a stored session): when, how long, how far,
// what to call it, and the problems seen in it — shared by Home, History and
// the trip page.

import type { TFunction } from 'i18next';
import type { Session, SessionFlag, SessionSummaryItem } from '@/types/session';
import type { IssueSeverity } from '@/lib/db-issues';
import { DTC_PREFIX, dtcSeverity } from '@/lib/problems';
import i18n from '@/lib/i18n';
import { isNativeApp } from '@/lib/obd/native-ble';
import { appHour, formatAppDate } from '@/lib/app-date';
import { savedFaultReadout } from './trip-inspection';
import { coveredTripDistance } from './fuel-ledger';

/** When the trip happened (recording start), falling back to the upload time. */
export function tripDate(session: Pick<Session, 'session_start' | 'uploaded_at'>): Date {
  return new Date(session.session_start ?? session.uploaded_at);
}

function speedSummary(session: Pick<Session, 'summary'>): SessionSummaryItem | undefined {
  return session.summary?.summaries?.find((s) => s.canonical_key === 'vehicle_speed');
}

/** Distance in km from average speed × duration; null when the trip has no speed data. */
export function tripDistanceKm(session: Pick<Session, 'summary' | 'duration_seconds'>): number | null {
  return coveredTripDistance(session);
}

export function tripAverageSpeed(session: Pick<Session, 'summary'>): number | null {
  return speedSummary(session)?.avg ?? null;
}

/** "4,5 km" in Portuguese, "4.5 km" in English: numbers follow the app language. */
export function formatDistance(km: number | null, unit: 'km' | 'mi', lang?: string): string | null {
  if (km == null) return null;
  const value = unit === 'mi' ? km * 0.621371 : km;
  const format = new Intl.NumberFormat(lang || i18n.resolvedLanguage || undefined, value < 10
    ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 });
  return `${format.format(value)} ${unit}`;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const min = i18n.t('trip.units.min', 'min');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} ${min}`;
  return `${Math.floor(minutes / 60)} ${i18n.t('trip.units.h', 'h')} ${String(minutes % 60).padStart(2, '0')} ${min}`;
}

export function formatTripDate(date: Date, lang: string | undefined): string {
  return formatAppDate(date, lang || i18n.resolvedLanguage || undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Names the app gives trips by itself: "Trip 28 Oct, 15:30" (trip.name in each
 * language, ending in the time), a CSV file name, or the old "Live scan <date>".
 * A name the owner typed — even one that starts with "Trip" — is not one of them.
 */
export function isAutoTripName(name: string): boolean {
  const n = name.trim();
  if (!n || /\.csv$/i.test(n)) return true;
  const time = String.raw`\d{1,2}[:.]\d{2}(?:[\s\u202f]*[ap]\.?m\.?)?`;
  return new RegExp(String.raw`^(?:trip|viagem|viaje|live scan) .*${time}$`, 'i').test(n);
}

/**
 * Display name: trips the user renamed keep their name; file names and
 * auto-generated names become "Morning trip", "Evening trip"… in the current
 * language. The date is shown next to the title, so it isn't repeated here.
 */
export function tripTitle(session: Pick<Session, 'source_filename' | 'session_start' | 'uploaded_at'>, t: TFunction): string {
  const name = session.source_filename?.trim() ?? '';
  if (!isAutoTripName(name)) return name;
  const hour = appHour(tripDate(session));
  if (hour >= 5 && hour < 12) return t('trip.partOfDay.morning', 'Morning trip');
  if (hour >= 12 && hour < 18) return t('trip.partOfDay.afternoon', 'Afternoon trip');
  if (hour >= 18 && hour < 23) return t('trip.partOfDay.evening', 'Evening trip');
  return t('trip.partOfDay.night', 'Night trip');
}

export interface TripProblem {
  canonical_key: string;
  title: string;
  severity: IssueSeverity;
}

/**
 * Problems seen in one trip: rule flags (one per kind, worst severity) plus
 * the fault codes the car reported, in the same shape as vehicle problems.
 */
export function tripProblems(flags: SessionFlag[], dtcs: string[] | null | undefined, summary?: Session['summary']): TripProblem[] {
  const byKey = new Map<string, TripProblem>();
  for (const f of flags) {
    if (f.severity === 'normal') continue;
    const severity: IssueSeverity = f.severity === 'critical' ? 'critical' : 'serious';
    const prev = byKey.get(f.canonical_key);
    if (!prev || (severity === 'critical' && prev.severity !== 'critical')) {
      byKey.set(f.canonical_key, { canonical_key: f.canonical_key, title: f.message, severity });
    }
  }
  for (const code of dtcs ?? []) {
    byKey.set(`${DTC_PREFIX}${code}`, { canonical_key: `${DTC_PREFIX}${code}`, title: code, severity: dtcSeverity(code) });
  }
  const read = savedFaultReadout(summary);
  for (const code of read?.stored ?? []) byKey.set(`${DTC_PREFIX}${code}`, {canonical_key:`${DTC_PREFIX}${code}`,title:code,severity:dtcSeverity(code)});
  for (const code of read?.pending ?? []) if (!byKey.has(`${DTC_PREFIX}${code}`)) byKey.set(`${DTC_PREFIX}${code}`, {canonical_key:`${DTC_PREFIX}${code}`,title:code+' (pending)',severity:'warning'});
  return Array.from(byKey.values());
}

const PRODUCTION_URL = 'https://xpeed.skale.club';

/** Base URL for links people open elsewhere (the Android app runs on https://localhost). */
export function publicAppUrl(): string {
  const configured = import.meta.env.VITE_APP_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return isNativeApp() ? PRODUCTION_URL : window.location.origin;
}
