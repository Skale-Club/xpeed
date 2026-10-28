// Friendly facts about a trip (a stored session): when, how long, how far,
// what to call it, and the problems seen in it — shared by Home, History and
// the trip page.

import type { TFunction } from 'i18next';
import type { Session, SessionFlag, SessionSummaryItem } from '@/types/session';
import type { IssueSeverity } from '@/lib/db-issues';
import { DTC_PREFIX, dtcSeverity } from '@/lib/problems';
import { isNativeApp } from '@/lib/obd/native-ble';

/** When the trip happened (recording start), falling back to the upload time. */
export function tripDate(session: Pick<Session, 'session_start' | 'uploaded_at'>): Date {
  return new Date(session.session_start ?? session.uploaded_at);
}

function speedSummary(session: Pick<Session, 'summary'>): SessionSummaryItem | undefined {
  return session.summary?.summaries?.find((s) => s.canonical_key === 'vehicle_speed');
}

/** Distance in km from average speed × duration; null when the trip has no speed data. */
export function tripDistanceKm(session: Pick<Session, 'summary' | 'duration_seconds'>): number | null {
  const avg = speedSummary(session)?.avg;
  if (avg == null || !session.duration_seconds) return null;
  return (avg * session.duration_seconds) / 3600;
}

export function tripAverageSpeed(session: Pick<Session, 'summary'>): number | null {
  return speedSummary(session)?.avg ?? null;
}

export function formatDistance(km: number | null, unit: 'km' | 'mi'): string | null {
  if (km == null) return null;
  const value = unit === 'mi' ? km * 0.621371 : km;
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString()} ${unit}`;
}

export function formatDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

export function formatTripDate(date: Date, lang: string | undefined): string {
  return new Intl.DateTimeFormat(lang || undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * Display name: trips the user renamed keep their name; file names and
 * auto-generated names become "Trip 28 Oct, 15:30" in the current language.
 */
export function tripTitle(session: Pick<Session, 'source_filename' | 'session_start' | 'uploaded_at'>, t: TFunction, lang?: string): string {
  const name = session.source_filename?.trim() ?? '';
  const automatic = !name || /\.csv$/i.test(name) || /^(trip|viagem|viaje|live scan) /i.test(name);
  if (!automatic) return name;
  return t('trip.name', 'Trip {{when}}', { when: formatTripDate(tripDate(session), lang) });
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
export function tripProblems(flags: SessionFlag[], dtcs: string[] | null | undefined): TripProblem[] {
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
  return Array.from(byKey.values());
}

const PRODUCTION_URL = 'https://xpeed.skale.club';

/** Base URL for links people open elsewhere (the Android app runs on https://localhost). */
export function publicAppUrl(): string {
  const configured = import.meta.env.VITE_APP_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, '');
  return isNativeApp() ? PRODUCTION_URL : window.location.origin;
}
