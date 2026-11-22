/**
 * Inside the Companion's window the site is signed in as the account the Companion is connected to, with no second sign-in
 * (shared/design/companion-shell.md, "Sign-in", stage 2):
 *
 *   1. the page asks the Companion through WebView2's message channel: { type: 'xpeed:session' };
 *   2. the Companion asks the server for a one-time code with its device key and answers { type: 'xpeed:session', code }
 *      (or { type: 'xpeed:session', error } when it is not connected or the server cannot sign);
 *   3. the page trades the code at POST /api/sim/web-session for a Firebase custom token and signs in with it.
 *
 * The device key never reaches the page, and a code works once, for two minutes.
 */
import { isCompanionShell } from '@/lib/companion-shell';

export const SESSION_MESSAGE = 'xpeed:session';
/** Set for the tab when the person signs out inside the Companion: no automatic sign-in until they sign in again. */
export const SIGNED_OUT_KEY = 'xpeed.companion.signedOut';
/** Set for the tab once the page has checked that it is signed in as the Companion's account. */
export const CHECKED_KEY = 'xpeed.companion.checked';
/** How long the Companion and the server get to answer before the page shows its own sign-in. */
const ANSWER_MS = 8000;

interface WebViewChannel {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}

/** WebView2's channel to the program around the page, when the page is in one. */
export function companionChannel(): WebViewChannel | null {
  const channel = (globalThis as { chrome?: { webview?: WebViewChannel } }).chrome?.webview;
  return channel && typeof channel.postMessage === 'function' ? channel : null;
}

/** Whether this page can be signed in by the Companion: in its window, with its channel. */
export function canSignInFromCompanion(): boolean {
  return isCompanionShell() && companionChannel() !== null;
}

const readFlag = (key: string) => { try { return window.sessionStorage.getItem(key) === '1'; } catch { return false; } };
const writeFlag = (key: string, on: boolean) => {
  try { if (on) window.sessionStorage.setItem(key, '1'); else window.sessionStorage.removeItem(key); } catch { /* Storage blocked. */ }
};

export const signedOutHere = () => readFlag(SIGNED_OUT_KEY);
export const markSignedOut = (on: boolean) => writeFlag(SIGNED_OUT_KEY, on);
export const checkedHere = () => readFlag(CHECKED_KEY);
export const markChecked = (on: boolean) => writeFlag(CHECKED_KEY, on);

/** Asks the Companion for a one-time code; null when it has none (not connected, not configured, no answer in time). */
export function askCompanionForCode(timeoutMs = ANSWER_MS): Promise<string | null> {
  const channel = companionChannel();
  if (!channel) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (code: string | null) => { clearTimeout(timer); channel.removeEventListener('message', listen); resolve(code); };
    const listen = (event: { data: unknown }) => {
      const data = event.data as { type?: unknown; code?: unknown } | null;
      if (!data || data.type !== SESSION_MESSAGE) return;
      done(typeof data.code === 'string' && data.code ? data.code : null);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    channel.addEventListener('message', listen);
    channel.postMessage({ type: SESSION_MESSAGE });
  });
}

/** Trades a code for a custom token and the uid it signs in as; null when the server refuses or cannot answer. */
export async function redeemCode(code: string): Promise<{ token: string; uid: string } | null> {
  try {
    const response = await fetch('/api/sim/web-session', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { token?: unknown; uid?: unknown };
    return typeof body.token === 'string' && typeof body.uid === 'string' && body.token && body.uid ? { token: body.token, uid: body.uid } : null;
  } catch {
    return null;
  }
}

export type CompanionOutcome = 'signed-in' | 'same' | 'unavailable';

/**
 * Makes the page's sign-in match the Companion's account: signs in when the page is signed out (`currentUid` null) or signed
 * in as somebody else; 'same' when it already is that account; 'unavailable' when the Companion or the server cannot help
 * (the page then keeps its own sign-in).
 */
export async function signInFromCompanion(
  currentUid: string | null,
  signIn: (token: string) => Promise<unknown>,
  timeoutMs = ANSWER_MS,
): Promise<CompanionOutcome> {
  const code = await askCompanionForCode(timeoutMs);
  if (!code) return 'unavailable';
  const session = await redeemCode(code);
  if (!session) return 'unavailable';
  if (session.uid === currentUid) return 'same';
  try {
    await signIn(session.token);
    return 'signed-in';
  } catch {
    return 'unavailable';
  }
}
