// First-party error tracking for the site: when the page breaks in somebody's browser, a small report goes to Xpeed's own server
// (POST /api/client-errors) and nowhere else. No third-party error service is involved, so the privacy policy stays true.
//
// What is sent: a scrubbed message, a scrubbed and trimmed stack, the route pattern WITHOUT its query string, the build, the browser
// family and major version, a fingerprint and the time. Never: an e-mail, a phone number, a token, a query string, a full user-agent,
// the contents of the page or of any form. The signed-in person is recognised by the server from the session header (only to count
// how many people a problem touched); it is never in the body.
//
// A reporter must never make things worse: it is rate limited (20 a minute), it sends the same problem at most once a minute, it
// never reports its own failures (a POST that fails is dropped, never retried and never reported), and nothing it does can throw.
import { browserFamily, fingerprintOf, scrubMessage, scrubRoute, scrubStack } from '@/lib/error-scrub';

declare const __APP_BUILD__: string | undefined;

/** Reports one client may send in a minute. */
export const REPORTS_PER_MINUTE = 20;
/** The same problem is not sent again within this time. */
export const DEDUPE_MS = 60_000;
/** Reports one page load may send in total, however long it stays open. */
export const MAX_REPORTS_PER_PAGE = 100;
export const ENDPOINT = '/api/client-errors';
const TOKEN_WAIT_MS = 1500;

export interface ErrorReport {
  message: string;
  stack: string;
  route: string;
  build: string;
  agent: string;
  fingerprint: string;
  at: string;
}

export interface ReporterOptions {
  /** Where to send. Defaults to the site's own address (the Android app talks to the live site). */
  baseUrl?: () => string;
  /** The sign-in token, if the person is signed in. Optional; a failure or a slow answer just means an anonymous report. */
  getToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Reports are not sent while this is true (development). */
  disabled?: boolean;
}

// Errors that say nothing about Xpeed: a browser extension, a cross-origin script that gives no detail, a layout loop warning.
const NOISE = [/^script error\.?$/i, /ResizeObserver loop/i, /^Non-Error promise rejection captured/i, /^Load failed$/i];
const FOREIGN_FRAME = /(?:chrome|moz|safari|safari-web)-extension:\/\//i;

const buildId = (): string => {
  try { return typeof __APP_BUILD__ === 'string' && __APP_BUILD__ ? __APP_BUILD__ : 'dev'; } catch { return 'dev'; }
};

/** The report for a thrown value, or null when it is not worth one. Never throws. */
export function buildReport(error: unknown, { route, userAgent, at = new Date() }: { route?: string; userAgent?: string; at?: Date } = {}): ErrorReport | null {
  try {
    const raw = error instanceof Error ? error : null;
    const text = raw ? raw.message : typeof error === 'string' ? error : typeof (error as { message?: unknown } | null)?.message === 'string' ? (error as { message: string }).message : '';
    const name = raw && raw.name && raw.name !== 'Error' ? `${raw.name}: ` : '';
    const message = scrubMessage(`${name}${text}`);
    if (!message || NOISE.some((pattern) => pattern.test(message))) return null;
    const rawStack = raw?.stack ?? (typeof (error as { stack?: unknown } | null)?.stack === 'string' ? (error as { stack: string }).stack : '');
    if (FOREIGN_FRAME.test(rawStack)) return null;
    const stack = scrubStack(rawStack);
    return {
      message,
      stack,
      route: scrubRoute(route ?? (typeof window !== 'undefined' ? window.location.pathname : '/')),
      build: buildId(),
      agent: browserFamily(userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')),
      fingerprint: fingerprintOf(message, stack),
      at: at.toISOString(),
    };
  } catch {
    return null;
  }
}

export function createErrorReporter(options: ReporterOptions = {}) {
  const now = options.now ?? Date.now;
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const recent: number[] = [];
  const seen = new Map<string, number>();
  let sentTotal = 0;

  /** Queues one report. Returns whether it was sent (false: filtered, duplicated, over a limit or switched off). */
  async function report(error: unknown): Promise<boolean> {
    if (options.disabled) return false;
    try {
      const built = buildReport(error, { at: new Date(now()) });
      if (!built) return false;
      const time = now();
      const last = seen.get(built.fingerprint);
      if (last !== undefined && time - last < DEDUPE_MS) return false;
      while (recent.length && time - recent[0]! >= 60_000) recent.shift();
      if (recent.length >= REPORTS_PER_MINUTE || sentTotal >= MAX_REPORTS_PER_PAGE) return false;
      seen.set(built.fingerprint, time);
      if (seen.size > 200) for (const [key, at] of seen) if (time - at >= DEDUPE_MS) seen.delete(key);
      recent.push(time);
      sentTotal++;

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      try {
        const token = options.getToken ? await Promise.race([options.getToken(), new Promise<null>((done) => setTimeout(() => done(null), TOKEN_WAIT_MS))]) : null;
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch { /* an anonymous report is fine */ }
      const base = (options.baseUrl?.() ?? (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '');
      // A failed POST is dropped: no retry, no report about the failure. The next different problem gets its own turn.
      await Promise.resolve(send(`${base}${ENDPOINT}`, { method: 'POST', headers, body: JSON.stringify(built), keepalive: true, credentials: 'omit' })).then(() => undefined, () => undefined);
      return true;
    } catch {
      return false;
    }
  }

  return { report };
}

let active: ReturnType<typeof createErrorReporter> | undefined;

/** Reports an error from anywhere (the React error boundary). Does nothing before `installErrorReporter` ran. Never throws. */
export function reportError(error: unknown): void {
  try { void active?.report(error); } catch { /* never */ }
}

/** Listens for uncaught errors and unhandled promise rejections. Safe to call twice. Returns a function that removes the listeners. */
export function installErrorReporter(options: ReporterOptions = {}): () => void {
  if (typeof window === 'undefined') return () => undefined;
  active = createErrorReporter(options);
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    active = undefined;
  };
}
