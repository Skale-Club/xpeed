// A stand-in for the table and function half of the Supabase client: the same chained calls
// (from().select().eq()..., rpc()), sent as data to this app's own server at /api/db.
// Switched on with VITE_DATA_API=true (see integrations/supabase/client.ts). The server
// checks the Google token and runs the query under the database's row level security.
import { Capacitor } from '@capacitor/core';
import { getAccessToken } from '@/lib/auth/google';

import { QueryBuilder, RpcBuilder, type ApiResult, type Json } from '@/lib/query-builder';
export type { ApiError, ApiResult } from '@/lib/query-builder';

const PRODUCTION_URL = 'https://xpeed.skale.club';
const REQUEST_TIMEOUT_MS = 30_000;

/** The installed Android app runs from https://localhost and must call the real server. */
export function apiOrigin(): string {
  if (!Capacitor.isNativePlatform()) return '';
  const configured = import.meta.env.VITE_APP_URL as string | undefined;
  return (configured || PRODUCTION_URL).replace(/\/$/, '');
}

export async function send(body: Record<string, unknown>): Promise<ApiResult> {
  try {
    const token = await getAccessToken();
    const response = await fetch(`${apiOrigin()}/api/db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      // A request that never answers must not hold a screen on its loading state.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) return { data: null, error: { message: 'Not signed in', code: '401' } };
    if (!response.ok) return { data: null, error: { message: `The server answered ${response.status}`, code: String(response.status) } };
    const result = (await response.json()) as ApiResult;
    return { data: result.data ?? null, error: result.error ?? null, count: result.count ?? null };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Request failed';
    // Same wording the app's offline handling already looks for.
    return { data: null, error: { message: /abort|timeout/i.test(message) ? 'Failed to fetch (timeout)' : message || 'Failed to fetch' } };
  }
}

// ---------------------------------------------------------------- files

const UPLOAD_TIMEOUT_MS = 120_000;
export interface StorageError { message: string; statusCode?: string; code?: string }
type FileInput = Blob | ArrayBuffer | Uint8Array;

async function authHeaders(extra: Record<string, string> = {}) {
  const token = await getAccessToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}
const objectUrl = (bucket: string, path: string) =>
  `${apiOrigin()}/api/storage/object/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;

async function storageCall<T>(request: () => Promise<Response>): Promise<{ data: T | null; error: StorageError | null }> {
  try {
    const response = await request();
    const body = (await response.json().catch(() => null)) as { data?: T; error?: StorageError | null } | null;
    if (!response.ok || body?.error) {
      return { data: null, error: body?.error ?? { message: `The server answered ${response.status}`, statusCode: String(response.status) } };
    }
    return { data: (body?.data ?? null) as T | null, error: null };
  } catch (cause) {
    return { data: null, error: { message: cause instanceof Error ? cause.message || 'Failed to fetch' : 'Failed to fetch' } };
  }
}

class StorageBucket {
  constructor(private bucket: string) {}

  upload(path: string, file: FileInput, options?: { contentType?: string; upsert?: boolean }) {
    return storageCall<{ path: string }>(async () => fetch(`${objectUrl(this.bucket, path)}?upsert=${options?.upsert === true}`, {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': options?.contentType || (file instanceof Blob ? file.type : '') || 'application/octet-stream' }),
      body: file as BodyInit,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    }));
  }
  remove(paths: string[]) {
    return storageCall<{ name: string }[]>(async () => fetch(`${apiOrigin()}/api/storage/remove`, {
      method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ bucket: this.bucket, paths }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
  }
  async createSignedUrl(path: string, expiresIn: number) {
    const result = await storageCall<{ signedPath: string }>(async () => fetch(`${apiOrigin()}/api/storage/sign`, {
      method: 'POST', headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ bucket: this.bucket, path, expiresIn }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    return result.data
      ? { data: { signedUrl: `${apiOrigin()}${result.data.signedPath}` }, error: null }
      : { data: null, error: result.error };
  }
  async download(path: string) {
    try {
      const response = await fetch(objectUrl(this.bucket, path), { headers: await authHeaders(), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      if (!response.ok) return { data: null, error: { message: response.status === 404 ? 'Object not found' : `The server answered ${response.status}`, statusCode: String(response.status) } };
      return { data: await response.blob(), error: null };
    } catch (cause) {
      return { data: null, error: { message: cause instanceof Error ? cause.message || 'Failed to fetch' : 'Failed to fetch' } };
    }
  }
  getPublicUrl(path: string) { return { data: { publicUrl: objectUrl(this.bucket, path) } }; }
}

// ---------------------------------------------------------------- edge functions

// An AI answer can take a while; the Supabase client waited about as long.
const FUNCTION_TIMEOUT_MS = 120_000;

/** Aborts when any of the signals does (AbortSignal.any is missing from older Android WebViews). */
function anyOf(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Same shape the Supabase client returned: a non-2xx answer carries the Response in `context`. */
const failedFunction = (name: 'FunctionsHttpError' | 'FunctionsFetchError', message: string, context: unknown) =>
  Object.assign(new Error(message), { name, context });

const functionsApi = {
  async invoke(name: string, options?: { body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }) {
    try {
      const timeout = AbortSignal.timeout(FUNCTION_TIMEOUT_MS);
      const response = await fetch(`${apiOrigin()}/api/fn/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json', ...options?.headers }),
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
        signal: options?.signal ? anyOf(options.signal, timeout) : timeout,
      });
      if (!response.ok) return { data: null, error: failedFunction('FunctionsHttpError', 'Edge Function returned a non-2xx status code', response) };
      const json = (response.headers.get('content-type') ?? '').includes('application/json');
      return { data: (json ? await response.json() : await response.text()) as unknown, error: null };
    } catch (cause) {
      return { data: null, error: failedFunction('FunctionsFetchError', 'Failed to send a request to the Edge Function', cause) };
    }
  },
};

// ---------------------------------------------------------------- change notices

const POLL_MS = 30_000;
type ChangeHandler = { table: string; column?: string; value?: string; callback: () => void; last?: number };

/**
 * The two screens that used Supabase realtime only need to know "something changed for this car".
 * This asks how many matching rows exist every 30 seconds while the page is visible and calls back
 * when the number moves. Not a live feed, and good enough for a "new trip" notice.
 */
class PollingChannel {
  private handlers: ChangeHandler[] = [];
  private timer?: ReturnType<typeof setInterval>;
  on(_type: string, filter: { table: string; filter?: string; event?: string; schema?: string }, callback: () => void) {
    const match = /^([a-z_][a-z0-9_]*)=eq\.(.+)$/i.exec(filter.filter ?? '');
    this.handlers.push({ table: filter.table, column: match?.[1], value: match?.[2], callback });
    return this;
  }
  subscribe() {
    void this.tick(true);
    this.timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState === 'visible') void this.tick(false); }, POLL_MS);
    return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.handlers = []; }

  private async tick(baseline: boolean) {
    for (const handler of [...this.handlers]) {
      const result = await send({
        kind: 'query', table: handler.table, action: 'select', select: 'id', count: true, head: true,
        filters: handler.column ? [{ column: handler.column, op: 'eq', value: handler.value }] : [],
      });
      if (result.error || typeof result.count !== 'number') continue;
      const changed = handler.last !== undefined && result.count !== handler.last;
      handler.last = result.count;
      if (changed && !baseline) handler.callback();
    }
  }
}

export const apiData = {
  from: (table: string) => new QueryBuilder(table, send),
  rpc: (name: string, args?: Json) => new RpcBuilder(name, args, send),
  storage: { from: (bucket: string) => new StorageBucket(bucket) },
  functions: functionsApi,
  channel: (_name: string) => new PollingChannel(),
  removeChannel: (channel: PollingChannel) => { channel.stop(); return Promise.resolve('ok'); },
};

/**
 * Answers tables, database functions, files, edge functions and change notices through this app's
 * server instead of Supabase. Anything else on the client (auth helpers) is left as it was.
 */
export function withApiData<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'from') return apiData.from;
      if (property === 'rpc') return apiData.rpc;
      if (property === 'storage') return apiData.storage;
      if (property === 'functions') return apiData.functions;
      if (property === 'channel') return apiData.channel;
      if (property === 'removeChannel') return apiData.removeChannel;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
