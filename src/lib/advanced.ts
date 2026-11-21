import { readPreference } from '@/lib/preferences';

// The second level of the screens (owner rule, 2026-11-21: XPD-D-SIMPLE-FIRST): whether the advanced part starts open.
// One choice for every screen, kept in this browser; with none made, the "Advanced tools" switch of Settings decides (off: closed).

const KEY = 'xpeed.advanced';

function remembered(): boolean | null {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'open' ? true : saved === 'closed' ? false : null;
  } catch {
    return null;
  }
}

/** Open from the start: the person's last choice, else the "Advanced tools" switch of Settings. */
export const advancedOpenByDefault = (): boolean => remembered() ?? readPreference('advancedTools') === 'true';

/** Keeps the person's choice (opening or closing any advanced fold). */
export function rememberAdvanced(open: boolean) {
  try { localStorage.setItem(KEY, open ? 'open' : 'closed'); } catch { /* Storage blocked: the choice lasts for this visit. */ }
}
