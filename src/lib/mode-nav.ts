import {
  Activity, AlertTriangle, Bluetooth, Car, CarFront, Flag, Fuel, Gauge, HeartPulse,
  History, LayoutDashboard, ScanSearch, Settings, Shield, Timer, Trophy, Users, Wrench, type LucideIcon,
} from 'lucide-react';
import { isActivePath, type Mode } from '@/lib/modes';
import sharedNav from '../../shared/design/nav.json';

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

// The entries themselves live in shared/design/nav.json, which the Companion's sidebar reads too (its Virtual places, their
// icons and their names), so a change made there shows in both. Here each icon name becomes its Lucide component.
// Virtual has no "Compare laps" entry: a comparison always starts from a lap (a session, a track, a car, a leaderboard), and
// its screen counts as part of Sessions (see `isActivePath`).
// Real: everyday places first; the technical Scanner only shows with "Advanced tools" on. Fuel sits with Trips and Maintenance
// (the records of the car) since the groups came in (2026-11-20).
// On phones Home, Trips and Problems live in the bottom tab bar, so the menu ("More") only lists the rest.

/** Every icon a shared menu entry may name, by its name in shared/design/nav.json. */
export const NAV_ICONS: Record<string, LucideIcon> = {
  Activity, AlertTriangle, Bluetooth, Car, CarFront, Flag, Fuel, Gauge, HeartPulse, History, LayoutDashboard, ScanSearch,
  Settings, Timer, Trophy, Users, Wrench,
};

const NAV_GROUPS: readonly NavGroup[] = ['car', 'health', 'records', 'garage', 'driving', 'community'];

type SharedEntry = { to: string; i18nKey: string; icon: string; tabI18nKey?: string; group?: string };

/** One entry of the shared file as the site uses it; an unknown icon or group is a mistake in the file, so it throws. */
function navEntry(entry: SharedEntry): NavEntry {
  const icon = NAV_ICONS[entry.icon];
  if (!icon) throw new Error(`shared/design/nav.json: no icon ${entry.icon} in NAV_ICONS`);
  const group = entry.group as NavGroup | undefined;
  if (group !== undefined && !NAV_GROUPS.includes(group)) throw new Error(`shared/design/nav.json: unknown group ${entry.group}`);
  return {
    to: entry.to,
    i18nKey: entry.i18nKey,
    icon,
    ...(entry.tabI18nKey ? { tabI18nKey: entry.tabI18nKey } : {}),
    ...(group ? { group } : {}),
  };
}

export const NAV: Record<Mode, NavEntry[]> = {
  real: sharedNav.real.map(navEntry),
  virtual: sharedNav.virtual.map(navEntry),
};

export const ADVANCED_ITEMS: NavEntry[] = sharedNav.advanced.map(navEntry);
export const SETTINGS_ITEM: NavEntry = navEntry(sharedNav.settings);

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
