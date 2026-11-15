// What the two error endpoints share (POST /api/client-errors from the site, POST /api/sim/companion-errors from Xpeed Companion):
// reading a body strictly, scrubbing it AGAIN (the sender may be old, broken or hostile), computing the fingerprint on the server, and
// recording it through one database function (error_report_record) that also does the rate limit. Never keeps an e-mail, a phone
// number, a token, a query string, an IP address or an account id: who was affected is a one-way hash, only to count people.
import { sha256Hex } from './sim/_shared';
import type { Backend } from './_backend';
import { browserFamily, fingerprintOf, scrubLabel, scrubMessage, scrubRoute, scrubStack } from '../src/lib/error-scrub';

/** Reports one IP address may send in a minute (the browser sends at most 20 a minute itself; several people can share an address). */
export const SITE_REPORTS_PER_IP_MINUTE = 60;
/** Reports one Companion (one device key) may send in a minute. */
export const COMPANION_REPORTS_PER_MINUTE = 10;
/** A report is a few KB at most; anything bigger is not one. */
export const MAX_REPORT_BYTES = 16 * 1024;

export interface NormalizedReport {
  message: string;
  stack: string;
  route: string | null;
  version: string | null;
  agent: string | null;
  worker: string | null;
  fingerprint: string;
  at: Date | null;
}

export type Read = { ok: true; value: NormalizedReport } | { ok: false; why: string };

const parseObject = (text: string): Record<string, unknown> | string => {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return 'invalid_json'; }
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : 'invalid_request';
};

const when = (value: unknown): Date | null => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
};

// 0.7.0, or 0.7.0-beta.1 (Companion); a short commit id or "dev" (site).
const COMPANION_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.]{1,16})?$/;
const SITE_BUILD = /^[0-9A-Za-z._-]{1,32}$/;
const WORKER = /^[a-z][a-z0-9_ -]{0,31}$/i;

/** The report a browser sent, scrubbed, or the word for what is wrong with it. `userAgent` is the request's header: the body's `agent` is not trusted. */
export function readSiteReport(text: string, userAgent: string | null): Read {
  const body = parseObject(text);
  if (typeof body === 'string') return { ok: false, why: body };
  const { message, stack, route, build, at } = body;
  if (typeof message !== 'string' || message.trim() === '' || message.length > 4000) return { ok: false, why: 'invalid_message' };
  if (stack !== undefined && stack !== null && (typeof stack !== 'string' || stack.length > 20_000)) return { ok: false, why: 'invalid_stack' };
  if (route !== undefined && route !== null && (typeof route !== 'string' || route.length > 2000)) return { ok: false, why: 'invalid_route' };
  if (build !== undefined && build !== null && (typeof build !== 'string' || !SITE_BUILD.test(build))) return { ok: false, why: 'invalid_build' };
  const cleanMessage = scrubMessage(message);
  if (!cleanMessage) return { ok: false, why: 'invalid_message' };
  const cleanStack = scrubStack(stack);
  return {
    ok: true,
    value: {
      message: cleanMessage,
      stack: cleanStack,
      route: scrubRoute(route),
      version: typeof build === 'string' ? scrubLabel(build) || null : null,
      agent: browserFamily(userAgent ?? ''),
      worker: null,
      // The server's own fingerprint: a sender cannot make a problem look like a new one (or like an old one) with a made-up value.
      fingerprint: fingerprintOf(cleanMessage, cleanStack),
      at: when(at),
    },
  };
}

/** The report Xpeed Companion sent: { version, worker, message, backtrace, os, at? }. */
export function readCompanionReport(text: string): Read {
  const body = parseObject(text);
  if (typeof body === 'string') return { ok: false, why: body };
  const { version, worker, message, backtrace, os, at } = body;
  if (typeof version !== 'string' || !COMPANION_VERSION.test(version)) return { ok: false, why: 'invalid_version' };
  if (typeof worker !== 'string' || !WORKER.test(worker)) return { ok: false, why: 'invalid_worker' };
  if (typeof message !== 'string' || message.trim() === '' || message.length > 4000) return { ok: false, why: 'invalid_message' };
  if (backtrace !== undefined && backtrace !== null && (typeof backtrace !== 'string' || backtrace.length > 20_000)) return { ok: false, why: 'invalid_backtrace' };
  if (os !== undefined && os !== null && (typeof os !== 'string' || os.length > 64)) return { ok: false, why: 'invalid_os' };
  const cleanMessage = scrubMessage(message);
  if (!cleanMessage) return { ok: false, why: 'invalid_message' };
  const cleanStack = scrubStack(backtrace);
  const cleanWorker = scrubLabel(worker).toLowerCase();
  return {
    ok: true,
    value: {
      message: cleanMessage,
      stack: cleanStack,
      route: null,
      version,
      agent: typeof os === 'string' ? scrubLabel(os) || null : null,
      worker: cleanWorker || null,
      fingerprint: fingerprintOf(cleanMessage, cleanStack, cleanWorker),
      at: when(at),
    },
  };
}

/** One-way hash of an account id, to count the people a problem touched (the same in the site's and the Companion's reports; the SQL function computes it the same way). */
export const userHash = (userId: string) => sha256Hex(`xpeed-errors:${userId}`);

export type Recorded = { status: 'ok'; group: string; isNew: boolean; reopened: boolean } | { status: 'rate'; wait: number } | { status: 'full' } | null;

/** Records a report. `null` is a Companion key that is unknown or revoked. Throws when the database fails. */
export async function recordReport(
  backend: Backend,
  source: 'site' | 'companion',
  report: NormalizedReport,
  who: { rateKey: string; rateMax: number; tokenHash?: string; userId?: string | null },
): Promise<Recorded> {
  const done = await backend.service.rpc('error_report_record', {
    p_source: source, p_rate_key: who.rateKey, p_rate_max: who.rateMax, p_token_hash: who.tokenHash ?? null,
    p_user_hash: who.userId ? userHash(who.userId) : null, p_fingerprint: report.fingerprint,
    p_message: report.message, p_stack: report.stack, p_route: report.route, p_version: report.version, p_agent: report.agent,
    p_worker: report.worker, p_occurred_at: (report.at ?? new Date()).toISOString(),
  });
  if (done.error) throw done.error;
  return done.data as Recorded;
}

export const failedReport = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));
