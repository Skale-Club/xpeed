import {
  Activity, AlertTriangle, ArrowLeftRight, Bluetooth, Car, CarFront, Flag, Fuel, Gauge, HeartPulse,
  History, LayoutDashboard, Radio, ScanSearch, Settings, ShieldCheck, Timer, Trophy, UserRound, Users, Wrench, type LucideIcon,
} from 'lucide-react';
import type { Mode } from '@/lib/modes';

/** Where every screen lives: the sidebar and the phone tab bar both read this one map. */
export type NavEntry = {
  to: string;
  i18nKey: string;
  icon: LucideIcon;
  /** A shorter name for the phone tab bar, where each place has about 75 px (a long name would run into its neighbour). */
  tabI18nKey?: string;
};

// Real: everyday places first; the technical Scanner only shows with "Advanced tools" on.
// On phones Home, Trips and Problems live in the bottom tab bar, so the menu
// ("More") only lists the rest.
export const NAV: Record<Mode, NavEntry[]> = {
  real: [
    { to: '/', i18nKey: 'nav.dashboard', icon: Gauge },
    { to: '/live', i18nKey: 'nav.live', icon: Activity },
    { to: '/fuel', i18nKey: 'fuel.title', icon: Fuel },
    { to: '/trends', i18nKey: 'trends.title', icon: HeartPulse },
    { to: '/issues', i18nKey: 'nav.issues', icon: AlertTriangle },
    { to: '/codes', i18nKey: 'codes.title', icon: ScanSearch },
    { to: '/history', i18nKey: 'nav.history', icon: History },
    { to: '/maintenance', i18nKey: 'nav.maintenance', icon: Wrench },
    { to: '/cars', i18nKey: 'nav.cars', icon: Car },
  ],
  virtual: [
    { to: '/virtual', i18nKey: 'modes.nav.overview', icon: LayoutDashboard },
    { to: '/virtual/sessions', i18nKey: 'modes.nav.sessions', icon: Timer },
    { to: '/virtual/compare', i18nKey: 'modes.nav.compare', icon: ArrowLeftRight },
    { to: '/virtual/leaderboards', i18nKey: 'social.nav.leaderboards', tabI18nKey: 'social.nav.leaderboardsTab', icon: Trophy },
    { to: '/virtual/friends', i18nKey: 'social.nav.friends', icon: Users },
    { to: '/virtual/tracks', i18nKey: 'modes.nav.tracks', icon: Flag },
    { to: '/virtual/cars', i18nKey: 'modes.nav.cars', icon: CarFront },
    { to: '/virtual/companion', i18nKey: 'modes.nav.xpeedSim', icon: Radio },
    { to: '/virtual/profile', i18nKey: 'social.nav.profile', icon: UserRound },
    { to: '/virtual/privacy', i18nKey: 'social.nav.privacy', icon: ShieldCheck },
  ],
};

export const ADVANCED_ITEMS: NavEntry[] = [{ to: '/scanner', i18nKey: 'nav.scanner', icon: Bluetooth }];
export const SETTINGS_ITEM: NavEntry = { to: '/settings', i18nKey: 'nav.settings', icon: Settings };

const entries = (mode: Mode, ...paths: string[]) => paths.flatMap((to) => NAV[mode].filter((item) => item.to === to));

/** The phone tab bar: three places always one tap away, then "More". */
export const TABS: Record<Mode, NavEntry[]> = {
  real: entries('real', '/', '/history', '/issues'),
  virtual: entries('virtual', '/virtual', '/virtual/sessions', '/virtual/compare', '/virtual/leaderboards'),
};
