// What an error report may carry. Used twice: by the browser before it sends anything (src/lib/error-reporter.ts) and by the server
// again before it stores anything (api/client-errors.ts, api/sim/companion-errors.ts), so a client that is old, broken or hostile
// still cannot put an e-mail, a phone number, a token or a query string into the database.
//
// Pure functions, no browser or Node API: this file is bundled into both.

export const MAX_MESSAGE_CHARS = 500;
export const MAX_STACK_CHARS = 4000;
export const MAX_STACK_LINES = 30;
export const MAX_ROUTE_CHARS = 200;
export const MAX_LABEL_CHARS = 64;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// Three base64url parts, the first one a JSON object ("eyJ"): a JWT (an access token, a Firebase ID token).
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi;
// A Companion device key (xpd_...) and any other long opaque string (an API key, a share token, a hash).
const DEVICE_KEY = /\bxpd_[A-Za-z0-9_-]{6,}/g;
const OPAQUE = /[A-Za-z0-9_-]{32,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// +1 555 000 0001, (555) 000-0001, 555.000.0001, 5550000001: seven or more digits with the usual separators between.
const PHONE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,}\d(?![\w])/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// C:\Users\Name\..., /home/name/..., /Users/name/...: the person's account name is in the path of a crash.
const HOME_PATH = /([A-Za-z]:[\\/]+Users[\\/]+|\/home\/|\/Users\/)[^\\/\s:)'"]+/gi;
// ?a=b and #fragment on an address (or on anything that looks like a path): the part after the "?" is dropped.
const QUERY = /(?<=[\w/.=-])\?[^\s'"`)]+/g;
const FRAGMENT = /(?<=[\w/])#[^\s'"`)]+/g;

/** The text with every e-mail, phone number, token, id and query string replaced by a word in brackets. Idempotent. */
export function scrubText(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(JWT, '[token]')
    .replace(BEARER, '$1 [token]')
    .replace(DEVICE_KEY, '[token]')
    // The query string and the fragment go before the e-mail pass: an address inside one is removed with it, in one piece.
    .replace(QUERY, '')
    .replace(FRAGMENT, '')
    .replace(EMAIL, '[email]')
    .replace(UUID, '[id]')
    .replace(HOME_PATH, '$1[user]')
    .replace(IPV4, '[ip]')
    .replace(PHONE, (found) => {
      const digits = found.replace(/\D/g, '').length;
      // A version such as 10.0.26200 is not a phone number; a long run of digits, or a number with spaces, brackets or dashes, is.
      return digits >= 7 && !(/^[\d.]+$/.test(found) && digits < 10 && found.includes('.')) ? '[phone]' : found;
    })
    .replace(OPAQUE, '[token]')
    // Control characters other than the line break and the tab have no place in a report.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** A short single-line message, scrubbed. */
export function scrubMessage(input: unknown): string {
  return scrubText(input).replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
}

/** A stack, scrubbed and trimmed to its first lines and characters. */
export function scrubStack(input: unknown): string {
  return scrubText(input).split('\n').slice(0, MAX_STACK_LINES).map((line) => line.trimEnd()).join('\n').trim().slice(0, MAX_STACK_CHARS);
}

/** A short label (a version, a worker name, a browser family): letters, digits and a few separators, nothing else. */
export function scrubLabel(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[^A-Za-z0-9._ /+-]/g, '').trim().slice(0, MAX_LABEL_CHARS);
}

// Pages whose last segment is somebody's or something's own: a share token, a handle, a record id.
const OWNED = new Set(['s', 'share', 'session', 'sessions', 'tracks', 'cars', 'drivers', 'connect', 'laps', 'reports']);

/**
 * The page the error happened on, as a route pattern: the path only (never the query string or the fragment), with any segment that is
 * an id, a handle or a token turned into `:id`. Anything that is not a path gives "/".
 */
export function scrubRoute(input: unknown): string {
  if (typeof input !== 'string') return '/';
  let path = input.trim();
  const origin = path.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (origin) path = path.slice(origin[0].length);
  path = path.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return '/';
  const parts = path.split('/').filter(Boolean);
  const out = parts.map((part, index) => {
    const before = (parts[index - 1] ?? '').toLowerCase();
    const looksLikeId = /^\d+$/.test(part) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(part) || part.length >= 20 || (/\d/.test(part) && part.length >= 8) || part.includes('@');
    return looksLikeId || OWNED.has(before) ? ':id' : part;
  });
  return `/${out.join('/')}`.replace(/[^A-Za-z0-9/_:.-]/g, '').slice(0, MAX_ROUTE_CHARS) || '/';
}

/** "chrome/131 mobile": the browser family and its major version, and whether it is a phone; never the full user-agent string. */
export function browserFamily(userAgent: unknown): string {
  if (typeof userAgent !== 'string') return 'other';
  const ua = userAgent;
  const pick = (pattern: RegExp, name: string) => {
    const match = ua.match(pattern);
    return match ? `${name}/${match[1]}` : null;
  };
  const family =
    pick(/\bEdg(?:e|A|iOS)?\/(\d+)/, 'edge') ?? pick(/\bSamsungBrowser\/(\d+)/, 'samsung') ?? pick(/\bOPR\/(\d+)/, 'opera') ??
    pick(/\b(?:Chrome|CriOS)\/(\d+)/, 'chrome') ?? pick(/\b(?:Firefox|FxiOS)\/(\d+)/, 'firefox') ?? (/\bSafari\//.test(ua) ? pick(/\bVersion\/(\d+)/, 'safari') : null) ?? 'other';
  const mobile = /\b(Android|iPhone|iPad|iPod|Mobile)\b/.test(ua) ? 'mobile' : 'desktop';
  return `${family} ${mobile}`;
}

/** 53-bit string hash (cyrb53), as 14 hex digits: small, synchronous and the same in a browser and in Node. */
export function hash53(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** The first frame of a stack (the line that is not the message), with the numbers and the build hashes in file names taken out. */
export function topFrame(stack: string): string {
  const frame = stack.split('\n').map((line) => line.trim()).find((line) => /^(at\s|[\w$.<>@/-]*@|\S+\.(rs|js|mjs|tsx?):\d)/.test(line) || /^\d+:\s/.test(line)) ?? '';
  return frame.replace(/[-.][A-Za-z0-9_-]{6,12}(?=\.(?:m?js|css)\b)/g, '').replace(/\d+/g, '0').slice(0, 200);
}

/**
 * The same bug gives the same fingerprint on every computer and every build: the message and the top frame, with numbers made equal
 * ("restarted 3 times" and "restarted 5 times" are one problem). `extra` is anything else that tells two problems apart (the worker).
 */
export function fingerprintOf(message: string, stack: string, extra = ''): string {
  return hash53(`${extra}|${message.replace(/\d+/g, '0')}|${topFrame(stack)}`);
}
