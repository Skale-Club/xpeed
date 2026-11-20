import {
  Activity, AlertTriangle, Bluetooth, Car, CarFront, Flag, Fuel, Gauge, HeartPulse,
  History, LayoutDashboard, ScanSearch, Settings, Shield, Timer, Trophy, Users, Wrench, type LucideIcon,
} from 'lucide-react';
import { isActivePath, type Mode } from '@/lib/modes';

/** Where every screen lives: the sidebar and the phone tab bar both read this one map. */
export type NavEntry = {
  to: string;
  i18nKey: string;
  icon: LucideIcon;
  /** A shorter name for the phone tab bar, where each place has about 75 px (a long name would run into its neighbour). */
  tabI18nKey?: string;
  /**
   * The titled group of the sidebar the entry sits in (`nav.groups.<group>`); entries of one group are next to each other.
   * Dashboards 2027, phase 2 (owner approved 2026-11-20): the menu reads as a few short groups instead of one long list.
   */
  group?: NavGroup;
};

export type NavGroup = 'car' | 'health' | 'records' | 'garage' | 'driving' | 'community';

// Virtual has no "Compare laps" entry: a comparison always starts from a lap (a session, a track, a car, a leaderboard), and
// its screen counts as part of Sessions (see `isActivePath`).
// Real: everyday places first; the technical Scanner only shows with "Advanced tools" on.
// On phones Home, Trips and Problems live in the bottom tab bar, so the menu
// ("More") only lists the rest.
export const NAV: Record<Mode, NavEntry[]> = {
  // Fuel sits with Trips and Maintenance (the records of the car) since the groups came in (2026-11-20).
  real: [
    { to: '/', i18nKey: 'nav.dashboard', icon: Gauge, group: 'car' },
    { to: '/live', i18nKey: 'nav.live', icon: Activity, group: 'car' },
    { to: '/trends', i18nKey: 'trends.title', icon: HeartPulse, group: 'health' },
    { to: '/issues', i18nKey: 'nav.issues', icon: AlertTriangle, group: 'health' },
    { to: '/codes', i18nKey: 'codes.title', icon: ScanSearch, group: 'health' },
    { to: '/history', i18nKey: 'nav.history', icon: History, group: 'records' },
    { to: '/fuel', i18nKey: 'fuel.title', icon: Fuel, group: 'records' },
    { to: '/maintenance', i18nKey: 'nav.maintenance', icon: Wrench, group: 'records' },
    { to: '/cars', i18nKey: 'nav.cars', icon: Car, group: 'garage' },
  ],
  virtual: [
    { to: '/virtual', i18nKey: 'modes.nav.overview', icon: LayoutDashboard, group: 'driving' },
    { to: '/virtual/sessions', i18nKey: 'modes.nav.sessions', icon: Timer, group: 'driving' },
    { to: '/virtual/leaderboards', i18nKey: 'social.nav.leaderboards', tabI18nKey: 'social.nav.leaderboardsTab', icon: Trophy, group: 'community' },
    { to: '/virtual/friends', i18nKey: 'social.nav.friends', icon: Users, group: 'community' },
    { to: '/virtual/tracks', i18nKey: 'modes.nav.tracks', icon: Flag, group: 'garage' },
    { to: '/virtual/cars', i18nKey: 'modes.nav.cars', icon: CarFront, group: 'garage' },
  ],
};

export const ADVANCED_ITEMS: NavEntry[] = [{ to: '/scanner', i18nKey: 'nav.scanner', icon: Bluetooth }];
export const SETTINGS_ITEM: NavEntry = { to: '/settings', i18nKey: 'nav.settings', icon: Settings };

const entries = (mode: Mode, ...paths: string[]) => paths.flatMap((to) => NAV[mode].filter((item) => item.to === to));

/** The phone tab bar: three places always one tap away, then "More". */
export const TABS: Record<Mode, NavEntry[]> = {
  real: entries('real', '/', '/history', '/issues'),
  virtual: entries('virtual', '/virtual', '/virtual/sessions', '/virtual/leaderboards'),
};

/** The sidebar's sections: consecutive entries of one group under its title; entries without a group make an untitled section. */
export function groupNav(items: readonly NavEntry[]): Array<{ group: NavGroup | null; items: NavEntry[] }> {
  const sections: Array<{ group: NavGroup | null; items: NavEntry[] }> = [];
  for (const item of items) {
    const group = item.group ?? null;
    const last = sections[sections.length - 1];
    if (last && last.group === group) last.items.push(item);
    else sections.push({ group, items: [item] });
  }
  return sections;
}

/** The admin pages, for the top bar's trail and "Go to…" (the sidebar shows Admin in its footer). */
export const ADMIN_ITEM: NavEntry = { to: '/admin', i18nKey: 'nav.admin', icon: Shield };

/** The menu entry a page belongs to (a session's page belongs to Sessions), or null on a page with no entry. */
export function trailEntry(mode: Mode, pathname: string): NavEntry | null {
  if (pathname.startsWith('/admin')) return ADMIN_ITEM;
  return [...NAV[mode], ...ADVANCED_ITEMS, SETTINGS_ITEM].find((item) => isActivePath(item.to, pathname)) ?? null;
}

/** Lower case with the accents taken off, so "saude" finds "Saúde". */
const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The places whose name contains the query (all of them for an empty query), in menu order. */
export function matchPlaces<T extends { label: string }>(places: readonly T[], query: string): T[] {
  const q = fold(query.trim());
  return q ? places.filter((place) => fold(place.label).includes(q)) : [...places];
}
