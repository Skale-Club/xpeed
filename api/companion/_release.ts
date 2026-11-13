// Xpeed Companion's public release information, read from the rolling GitHub release (`companion-latest`).
// CI (.github/workflows/xpeed-sim.yml) puts `latest.json`, the installer and SHA256SUMS.txt there; this module reads
// `latest.json`, validates it strictly and keeps it for a few minutes. Docs: docs/platform/RELEASES.md.

/** Where the rolling release lives. Only `<base>/<file>` is ever redirected to, so the download can never point elsewhere. */
export const DEFAULT_RELEASE_BASE = 'https://github.com/Skale-Club/xpeed/releases/download/companion-latest';
const CACHE_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 5000;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;

export interface CompanionManifest {
  version: string;
  build: string;
  file: string;
  sha256: string;
  size: number;
  releasedAt: string;
  minVersion: string;
  /** False when CI had no signing certificate: Windows will show the "unknown publisher" warning. */
  signed: boolean;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.exe$/;
const VERSION = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every field checked; anything unexpected (a path in `file`, a short hash, a negative size) rejects the whole file. */
export function parseManifest(text: string): CompanionManifest | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isRecord(data)) return null;
  const { version, build, file, sha256, size, releasedAt, minVersion, notes, signed } = data;
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  if (typeof minVersion !== 'string' || !VERSION.test(minVersion)) return null;
  if (typeof build !== 'string' || !/^[0-9a-f]{7,40}$/.test(build)) return null;
  // A plain file name: no slash, no dot-dot, no query. It is appended to the release base to form the download address.
  if (typeof file !== 'string' || !FILE_NAME.test(file) || file.includes('..')) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) return null;
  if (typeof releasedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(releasedAt) || Number.isNaN(Date.parse(releasedAt))) return null;
  if (notes !== undefined && (typeof notes !== 'string' || notes.length > 4000)) return null;
  if (signed !== undefined && typeof signed !== 'boolean') return null;
  return { version, build, file, sha256, size, releasedAt, minVersion, signed: signed === true };
}

/** `COMPANION_RELEASE_BASE`, without a trailing slash. https only (plain http just for a local test server); anything else falls back to the default. */
export function releaseBase(): string {
  const configured = process.env.COMPANION_RELEASE_BASE?.trim();
  if (!configured) return DEFAULT_RELEASE_BASE;
  try {
    const url = new URL(configured);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return DEFAULT_RELEASE_BASE;
    if (url.username || url.password || url.search || url.hash) return DEFAULT_RELEASE_BASE;
    return url.href.replace(/\/+$/, '');
  } catch {
    return DEFAULT_RELEASE_BASE;
  }
}

/** The one place a download may point to: the base, a slash and a file name already validated by `parseManifest`. */
export function installerUrl(base: string, manifest: CompanionManifest): string | null {
  if (!FILE_NAME.test(manifest.file) || manifest.file.includes('..')) return null;
  const target = `${base}/${manifest.file}`;
  try {
    const url = new URL(target);
    const root = new URL(`${base}/`);
    return url.origin === root.origin && url.pathname === `${root.pathname}${manifest.file}` ? url.href : null;
  } catch {
    return null;
  }
}

interface Cached { base: string; at: number; manifest: CompanionManifest }
let cached: Cached | null = null;
let inflight: Promise<CompanionManifest | null> | null = null;

/** For tests: forget what was kept. */
export function forgetCompanionRelease(): void {
  cached = null;
  inflight = null;
}

const cacheMs = () => {
  // A test hook, not a setting: lets the checks see the cache expire without waiting five minutes.
  const raw = process.env.COMPANION_RELEASE_CACHE_MS;
  const override = Number(raw);
  return raw && Number.isFinite(override) && override >= 0 ? override : CACHE_MS;
};

async function fetchManifest(base: string): Promise<CompanionManifest | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // GitHub answers a release download with a redirect to its file store, so redirects are followed.
    const response = await fetch(`${base}/latest.json`, { redirect: 'follow', signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_MANIFEST_BYTES) return null;
    return parseManifest(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The current manifest: kept for five minutes; when the release cannot be read, the last good one (however old); null when there is none. */
export async function currentManifest(): Promise<CompanionManifest | null> {
  const base = releaseBase();
  const now = Date.now();
  if (cached && cached.base === base && now - cached.at < cacheMs()) return cached.manifest;
  // Many visitors at once share one upstream request.
  inflight ??= fetchManifest(base).then((manifest) => {
    if (manifest) cached = { base, at: Date.now(), manifest };
    return manifest;
  }).finally(() => { inflight = null; });
  const fresh = await inflight;
  if (fresh) return fresh;
  return cached && cached.base === base ? cached.manifest : null;
}

export const unavailable = () =>
  new Response(JSON.stringify({ error: 'unavailable', retryable: true }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': '60' },
  });

export const notAllowed = () =>
  new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
  });
