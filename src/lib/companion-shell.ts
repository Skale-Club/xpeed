/**
 * Shell mode: the site runs inside the Xpeed Companion's WebView2, which draws
 * its own header and menu, so the site shows only the page content.
 * Contract: shared/design/companion-shell.md.
 */
export const SHELL_KEY = 'xpeed.shell';
const SHELL_UA = 'XpeedCompanion/';

// Kept in memory too, so a tab with blocked storage still remembers ?shell=companion.
let remembered = false;

/** Forget what this tab remembered (tests). */
export function resetCompanionShell() {
  remembered = false;
}

/** Whether the site is in shell mode: the app's user agent, or ?shell=companion (remembered for the tab). */
export function isCompanionShell(): boolean {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes(SHELL_UA)) return true;
  if (typeof window === 'undefined') return false;
  let flag: string | null = null;
  try { flag = new URLSearchParams(window.location.search).get('shell'); } catch { /* No address to read. */ }
  if (flag === 'companion') {
    remembered = true;
    try { window.sessionStorage.setItem(SHELL_KEY, 'companion'); } catch { /* Storage blocked: the memory copy stays. */ }
    return true;
  }
  if (flag === 'off') {
    remembered = false;
    try { window.sessionStorage.removeItem(SHELL_KEY); } catch { /* Storage blocked. */ }
    return false;
  }
  if (remembered) return true;
  try { return window.sessionStorage.getItem(SHELL_KEY) === 'companion'; } catch { return false; }
}
