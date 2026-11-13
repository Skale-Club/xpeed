// An S3-compatible FileStore (Cloudflare R2, Backblaze B2, Hetzner Object Storage, MinIO, AWS...), written with
// node:crypto and fetch: AWS Signature Version 4 for PUT, GET, HEAD, DELETE and ListObjectsV2, nothing else.
//
// Every app bucket ("sim-laps", "session-photos"...) is a key prefix inside the one S3 bucket from S3_BUCKET, so one
// storage bucket is enough and the object for sim-laps/<user>/<hash>.xlap.gz is that exact key.
//
// Same behaviour as DiskStore (scripts/verify-storage.mjs runs one contract suite against both): keys come from
// checkBucket/checkPath only, `upsert: false` refuses an existing object (409 already_exists), a missing object is null
// on get/head and ignored on remove, and anything else that goes wrong is a plain Error (the routes answer 500
// "unavailable" for it and log the message, which never contains a key or a secret).
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { FileError, checkBucket, checkPath, storedContentType, type FileStore, type ListedFile } from './files';

export interface S3Config {
  /** `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`, `https://fsn1.your-objectstorage.com`... */
  endpoint: string;
  /** `auto` for R2; the real region for B2 (`us-west-004`) and Hetzner (`fsn1`). */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `endpoint/bucket/key` when true (works everywhere), `bucket.endpoint/key` when false. */
  forcePathStyle: boolean;
}

// ---------------------------------------------------------------- Signature Version 4

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
export const EMPTY_SHA256 = sha256('');

/** RFC 3986 percent-encoding: what SigV4 wants (encodeURIComponent leaves ! ' ( ) * alone). */
const rfc3986 = (text: string) => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** An object key as a URL path: every segment encoded, slashes kept. */
const encodeKey = (key: string) => key.split('/').map(rfc3986).join('/');

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to send besides the ones signing adds (host, x-amz-date, x-amz-content-sha256). All of them are signed. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body (EMPTY_SHA256 when there is none). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
  date?: Date;
}

/** The headers to send: the given ones plus host, x-amz-date, x-amz-content-sha256 and Authorization. */
export function signV4(input: SignInput): Record<string, string> {
  const date = input.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const service = input.service ?? 's3';

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ');
  headers.host = input.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = input.payloadHash;

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = input.url.pathname.split('/').map((segment) => rfc3986(decodeURIComponent(segment))).join('/') || '/';
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([name, value]) => [rfc3986(name), rfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`).join('&');
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // `host` is set by fetch from the URL (the same value that was signed); it must not be passed on.
  delete headers.host;
  return headers;
}

/** Where an object lives: `endpoint/bucket/key` (path style) or `bucket.endpoint/key` (virtual hosted style). */
export function s3Url(config: Pick<S3Config, 'endpoint' | 'bucket' | 'forcePathStyle'>, key: string, query: Record<string, string> = {}): URL {
  const base = new URL(config.endpoint);
  const encodedKey = key ? encodeKey(key) : '';
  const url = config.forcePathStyle
    ? new URL(`${base.protocol}//${base.host}/${rfc3986(config.bucket)}${encodedKey ? `/${encodedKey}` : '/'}`)
    : new URL(`${base.protocol}//${config.bucket}.${base.host}/${encodedKey}`);
  // Built by hand: URLSearchParams would write spaces as "+", and S3 signs "%20".
  const pairs = Object.entries(query).map(([name, value]) => `${rfc3986(name)}=${rfc3986(value)}`);
  if (pairs.length) url.search = pairs.join('&');
  return url;
}

// ---------------------------------------------------------------- the store

export interface S3Options {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Extra tries after a network error or a 429/5xx answer (default 2). */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  /** An object larger than this is refused on read instead of being held in memory (default 128 MB). */
  maxReadBytes?: number;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const unescapeXml = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlTag = (block: string, tag: string) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block); return m ? unescapeXml(m[1]) : undefined; };
/** ListObjectsV2 with encoding-type=url writes keys url-encoded, spaces as "+". */
const decodeListed = (text: string) => decodeURIComponent(text.replace(/\+/g, ' '));
const nameOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const MAX_LISTED = 100_000;

export class S3Store implements FileStore {
  private readonly config: S3Config;
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxReadBytes: number;

  constructor(config: S3Config, options: S3Options = {}) {
    this.config = { ...config, endpoint: config.endpoint.replace(/\/+$/, '') };
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxReadBytes = options.maxReadBytes ?? 128 * 1024 * 1024;
  }

  private key(bucket: string, path: string) { return `${checkBucket(bucket)}/${checkPath(path)}`; }

  /** One signed request, with retries for what is safe to repeat. Returns the response whatever its status. */
  private async send(method: 'GET' | 'HEAD' | 'PUT' | 'DELETE', key: string, init: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string>; retry?: boolean; timeoutMs?: number } = {}): Promise<Response> {
    const retry = init.retry ?? true;
    const attempts = retry ? this.retries + 1 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((done) => setTimeout(done, this.retryDelayMs * 2 ** (attempt - 1)));
      const url = s3Url(this.config, key, init.query);
      // Signed again on every try: the signature carries the time.
      const headers = signV4({
        method, url, headers: init.headers, payloadHash: init.body ? sha256(init.body) : EMPTY_SHA256,
        accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey, region: this.config.region, date: this.now(),
      });
      try {
        const response = await this.http(url, { method, headers, body: init.body as BodyInit | undefined, signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs) });
        if (RETRY_STATUS.has(response.status) && attempt < attempts - 1) { await response.body?.cancel().catch(() => undefined); continue; }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) break;
      }
    }
    // The message names the operation and the error kind, never the key or the address.
    throw new Error(`S3 ${method} failed: ${lastError instanceof Error ? lastError.name : 'network error'}`);
  }

  /** An Error for an answer we did not expect, with the S3 error code when the body has one. */
  private async fail(operation: string, response: Response): Promise<Error> {
    let code = '';
    try { code = xmlTag(await response.text(), 'Code') ?? ''; } catch { /* no body */ }
    return new Error(`S3 ${operation} failed: ${response.status}${code ? ` ${code}` : ''}`);
  }

  async put(bucket: string, path: string, data: Uint8Array, { upsert }: { upsert: boolean }) {
    const key = this.key(bucket, path);
    if (!upsert && (await this.head(bucket, path))) throw new FileError(409, 'already_exists', 'The resource already exists');
    const headers: Record<string, string> = { 'content-type': storedContentType(bucket, path) };
    // Providers that honour it make "do not replace" atomic; the check above covers the ones that do not.
    if (!upsert) headers['if-none-match'] = '*';
    const response = await this.send('PUT', key, { body: data, headers, retry: upsert, timeoutMs: Math.max(this.timeoutMs, 10 * 60_000) });
    if (response.ok) { await response.body?.cancel().catch(() => undefined); return; }
    if (!upsert && (response.status === 412 || response.status === 409)) {
      await response.body?.cancel().catch(() => undefined);
      throw new FileError(409, 'already_exists', 'The resource already exists');
    }
    throw await this.fail('PUT', response);
  }

  async get(bucket: string, path: string) {
    const response = await this.send('GET', this.key(bucket, path));
    if (response.status === 404) {
      const code = xmlTag(await response.text().catch(() => ''), 'Code');
      if (code === 'NoSuchBucket') throw new Error('S3 GET failed: 404 NoSuchBucket');
      return null;
    }
    if (!response.ok) throw await this.fail('GET', response);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > this.maxReadBytes) { await response.body?.cancel().catch(() => undefined); throw new Error('S3 GET failed: object too large to read'); }
    // Read as a stream so a lying or unbounded answer is cut off at the limit instead of filling the memory.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > this.maxReadBytes) { await reader.cancel().catch(() => undefined); throw new Error('S3 GET failed: object too large to read'); }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  async head(bucket: string, path: string) {
    const response = await this.send('HEAD', this.key(bucket, path));
    if (response.status === 404) return null;
    if (!response.ok) throw await this.fail('HEAD', response);
    const size = Number(response.headers.get('content-length'));
    if (!Number.isFinite(size)) throw new Error('S3 HEAD failed: no size');
    return { size };
  }

  async remove(bucket: string, paths: string[]) {
    const keys = paths.map((path) => this.key(bucket, path));
    // A few at a time: B2 and R2 are happy with that, and a hundred paths is the most the route sends.
    for (let i = 0; i < keys.length; i += 8) {
      await Promise.all(keys.slice(i, i + 8).map(async (key) => {
        const response = await this.send('DELETE', key);
        // S3 answers 204 for a missing key; some providers answer 404. Either way it is gone.
        if (response.ok || response.status === 404) { await response.body?.cancel().catch(() => undefined); return; }
        throw await this.fail('DELETE', response);
      }));
    }
  }

  /** ListObjectsV2, every page. `delimiter: '/'` gives one folder level, none gives everything below `prefix`. */
  private async *pages(prefix: string, delimiter: boolean): AsyncGenerator<{ files: { key: string; size: number; updatedAt: string }[]; folders: string[] }> {
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', 'encoding-type': 'url', 'max-keys': '1000', prefix };
      if (delimiter) query.delimiter = '/';
      if (token) query['continuation-token'] = token;
      const response = await this.send('GET', '', { query });
      if (!response.ok) throw await this.fail('LIST', response);
      const xml = await response.text();
      const files = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({
        key: decodeListed(xmlTag(m[1], 'Key') ?? ''), size: Number(xmlTag(m[1], 'Size') ?? 0), updatedAt: xmlTag(m[1], 'LastModified') ?? new Date(0).toISOString(),
      }));
      const folders = [...xml.matchAll(/<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g)].map((m) => decodeListed(xmlTag(m[1], 'Prefix') ?? ''));
      yield { files, folders };
      token = xmlTag(xml, 'IsTruncated') === 'true' ? xmlTag(xml, 'NextContinuationToken') : undefined;
    } while (token);
  }

  async list(bucket: string, prefix: string, { limit = 100, offset = 0, search }: { limit?: number; offset?: number; search?: string } = {}): Promise<ListedFile[]> {
    const base = `${checkBucket(bucket)}/${prefix ? `${checkPath(prefix)}/` : ''}`;
    const found: ListedFile[] = [];
    for await (const page of this.pages(base, true)) {
      for (const file of page.files) {
        const name = file.key.slice(base.length);
        // A "folder marker" object (key ending in "/") and hidden names are not files of ours.
        if (!name || name.includes('/') || name.startsWith('.') || (search && !name.includes(search))) continue;
        found.push({ name, size: file.size, updatedAt: new Date(file.updatedAt).toISOString(), folder: false });
      }
      for (const folder of page.folders) {
        const name = folder.slice(base.length).replace(/\/$/, '');
        if (!name || name.startsWith('.') || (search && !name.includes(search))) continue;
        found.push({ name, size: 0, updatedAt: new Date(0).toISOString(), folder: true });
      }
      if (found.length > MAX_LISTED) break;
    }
    found.sort((a, b) => nameOrder(a.name, b.name));
    return found.slice(offset, offset + Math.min(Math.max(limit, 0), 1000));
  }

  async *listAll(bucket: string, prefix = ''): AsyncGenerator<{ path: string; size: number }> {
    const root = `${checkBucket(bucket)}/`;
    const base = `${root}${prefix ? `${checkPath(prefix)}/` : ''}`;
    for await (const page of this.pages(base, false)) {
      for (const file of page.files.sort((a, b) => nameOrder(a.key, b.key))) {
        const path = file.key.slice(root.length);
        if (!path || path.endsWith('/') || path.split('/').some((part) => part.startsWith('.'))) continue;
        yield { path, size: file.size };
      }
    }
  }

  async probe(): Promise<boolean> {
    try {
      const key = `.probe/${randomUUID()}`;
      const put = await this.send('PUT', key, { body: new TextEncoder().encode('ok'), headers: { 'content-type': 'text/plain' }, timeoutMs: 15_000 });
      if (!put.ok) return false;
      await put.body?.cancel().catch(() => undefined);
      const del = await this.send('DELETE', key, { timeoutMs: 15_000 });
      await del.body?.cancel().catch(() => undefined);
      return del.ok || del.status === 404;
    } catch { return false; }
  }
}
