import { readPreference, writePreference } from '@/lib/browser-storage';
import { currentRoute } from '@/lib/legacy-paths';

/**
 * The two sides of Xpeed: Real (the person's own car, read over Bluetooth) and
 * Virtual (racing-game telemetry). Real is first and is the default for
 * everyone; Virtual is something a person chooses at onboarding or in Settings.
 * The switch between them only shows for someone who has both.
 */
export const MODES = ['real', 'virtual'] as const;
export type Mode = (typeof MODES)[number];

/**
 * Virtual is hidden everywhere until its product exists. This is one switch for
 * the whole build, not a per-account release: off in production, on with
 * `VITE_ENABLE_VIRTUAL=true` (development, the screen-test harness).
 */
export function virtualBuildEnabled(): boolean {
  return import.meta.env.VITE_ENABLE_VIRTUAL === 'true';
}

/**
 * The modes to use for a stored or requested list. Real first, then Virtual;
 * unknown or repeated entries drop out; Virtual drops out while it is not built;
 * the result is never empty (nobody is left with nothing to open).
 */
export function normalizeModes(input: unknown, virtualAvailable: boolean = virtualBuildEnabled()): Mode[] {
  const list: unknown[] = Array.isArray(input) ? input : [];
  const picked = MODES.filter((mode) => list.includes(mode) && (mode === 'real' || virtualAvailable));
  return picked.length > 0 ? picked : ['real'];
}

/** Where the choice is kept until it moves to the account: this browser, one record per signed-in user. */
export const MODES_KEY = 'xpeed.modes.v1';
const modesKey = (userId: string) => `${MODES_KEY}:${userId}`;

export function readModes(userId: string | null | undefined): Mode[] {
  if (!userId) return ['real'];
  try {
    return normalizeModes(JSON.parse(readPreference(modesKey(userId)) ?? 'null'));
  } catch {
    return ['real'];
  }
}

export function writeModes(userId: string | null | undefined, modes: readonly Mode[]): Mode[] {
  const next = normalizeModes(modes);
  if (userId) writePreference(modesKey(userId), JSON.stringify(next));
  return next;
}

/** The first screen of each mode. */
export const MODE_HOME: Record<Mode, string> = { real: '/', virtual: '/virtual' };

/** Pages every account shares: they belong to neither mode. */
const SHARED_PREFIXES = ['/settings', '/admin', '/onboarding'];

/** Which mode a path belongs to; null for the pages both modes share. */
export function modeOfPath(path: string): Mode | null {
  // The page that approves a connection from Xpeed Companion works for either mode: it turns Virtual on itself.
  if (path.startsWith('/companion/connect/')) return null;
  if (path === '/virtual' || path.startsWith('/virtual/')) return 'virtual';
  if (SHARED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return 'real';
}

/** Whether a menu entry is the page being shown ("/" and "/virtual" match only themselves). */
export function isActivePath(to: string, pathname: string): boolean {
  if (to === '/' || to === '/virtual') return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

const LAST_MODE_KEY = 'xpeed.mode';
const LAST_ROUTE_KEY: Record<Mode, string> = { real: 'xpeed.route.real', virtual: 'xpeed.route.virtual' };

export function rememberMode(mode: Mode) {
  writePreference(LAST_MODE_KEY, mode);
}

/** Remember the exact screen last open in a mode for this browser session. */
export function rememberModeRoute(mode: Mode, route: string) {
  if (modeOfPath(route.split(/[?#]/)[0]) !== mode) return;
  try { window.sessionStorage.setItem(LAST_ROUTE_KEY[mode], route); } catch { /* Storage blocked: the mode opens on its first screen. */ }
}

/** The last screen used in a mode, or its first screen. */
export function modeEntryPath(mode: Mode): string {
  try {
    const stored = window.sessionStorage.getItem(LAST_ROUTE_KEY[mode]);
    // A route kept by an older build may still start with /sim: use its new address.
    const route = stored ? currentRoute(stored) : null;
    if (route && modeOfPath(route.split(/[?#]/)[0]) === mode) return route;
  } catch { /* Storage blocked. */ }
  return MODE_HOME[mode];
}

/**
 * The mode a screen is in. A mode's own pages say so; Settings and the other
 * shared pages keep the last mode used, if the person still has it.
 */
export function currentMode(modes: readonly Mode[], pathname: string): Mode {
  const fromPath = modeOfPath(pathname);
  if (fromPath && modes.includes(fromPath)) return fromPath;
  const last = readPreference(LAST_MODE_KEY);
  return modes.find((mode) => mode === last) ?? modes[0] ?? 'real';
}
