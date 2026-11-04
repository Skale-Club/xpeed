// A stand-in for the table and function half of the Supabase client: the same chained calls
// (from().select().eq()..., rpc()), sent as data to this app's own server at /api/db.
// Switched on with VITE_DATA_API=true (see integrations/supabase/client.ts). The server
// checks the Google token and runs the query under the database's row level security.
import { Capacitor } from '@capacitor/core';
import { getAccessToken } from '@/lib/auth/google';

type Json = unknown;
export interface ApiError { message: string; code?: string; details?: string | null; hint?: string | null }
export interface ApiResult { data: Json; error: ApiError | null; count?: number | null }
type Shape = 'many' | 'single' | 'maybe';
type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'contains';

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

abstract class Chain implements PromiseLike<ApiResult> {
  protected shape: Shape = 'many';
  single() { this.shape = 'single'; return this; }
  maybeSingle() { this.shape = 'maybe'; return this; }
  protected abstract payload(): Record<string, unknown>;
  then<A = ApiResult, B = never>(
    onfulfilled?: ((value: ApiResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return send(this.payload()).then(onfulfilled, onrejected);
  }
}

type Action = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

class QueryBuilder extends Chain {
  private action: Action = 'select';
  private columns?: string;
  private values?: Json;
  private filters: { column: string; op: FilterOp; value: Json }[] = [];
  private ors: string[] = [];
  private sort: { column: string; ascending: boolean; nullsFirst?: boolean }[] = [];
  private max?: number;
  private start?: number;
  private wantCount = false;
  private headOnly = false;
  private conflict?: string;
  private ignore = false;
  private returning = false;

  constructor(private table: string) { super(); }

  select(columns = '*', options?: { count?: string; head?: boolean }) {
    this.columns = columns;
    if (this.action !== 'select') this.returning = true;
    if (options?.count) this.wantCount = true;
    if (options?.head) this.headOnly = true;
    return this;
  }
  insert(values: Json) { this.action = 'insert'; this.values = values; return this; }
  update(values: Json) { this.action = 'update'; this.values = values; return this; }
  upsert(values: Json, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.action = 'upsert'; this.values = values; this.conflict = options?.onConflict; this.ignore = options?.ignoreDuplicates === true;
    return this;
  }
  delete() { this.action = 'delete'; return this; }

  private add(column: string, op: FilterOp, value: Json) { this.filters.push({ column, op, value }); return this; }
  eq(column: string, value: Json) { return this.add(column, 'eq', value); }
  neq(column: string, value: Json) { return this.add(column, 'neq', value); }
  gt(column: string, value: Json) { return this.add(column, 'gt', value); }
  gte(column: string, value: Json) { return this.add(column, 'gte', value); }
  lt(column: string, value: Json) { return this.add(column, 'lt', value); }
  lte(column: string, value: Json) { return this.add(column, 'lte', value); }
  like(column: string, value: string) { return this.add(column, 'like', value); }
  ilike(column: string, value: string) { return this.add(column, 'ilike', value); }
  is(column: string, value: Json) { return this.add(column, 'is', value); }
  in(column: string, values: Json[]) { return this.add(column, 'in', values); }
  contains(column: string, value: Json) { return this.add(column, 'contains', value); }
  match(values: Record<string, Json>) { for (const [column, value] of Object.entries(values)) this.eq(column, value); return this; }
  filter(column: string, op: string, value: Json) { return this.add(column, op as FilterOp, value); }
  or(expression: string) { this.ors.push(expression); return this; }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.sort.push({ column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst });
    return this;
  }
  limit(count: number) { this.max = count; return this; }
  range(from: number, to: number) { this.start = from; this.max = to - from + 1; return this; }

  protected payload() {
    return {
      kind: 'query', table: this.table, action: this.action, select: this.columns, values: this.values,
      filters: this.filters, or: this.ors, order: this.sort, limit: this.max, offset: this.start,
      shape: this.shape, count: this.wantCount, head: this.headOnly,
      onConflict: this.conflict, ignoreDuplicates: this.ignore, returning: this.returning,
    };
  }
}

class RpcBuilder extends Chain {
  constructor(private name: string, private args?: Json) { super(); }
  protected payload() { return { kind: 'rpc', name: this.name, args: this.args ?? {}, shape: this.shape }; }
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
  from: (table: string) => new QueryBuilder(table),
  rpc: (name: string, args?: Json) => new RpcBuilder(name, args),
  storage: { from: (bucket: string) => new StorageBucket(bucket) },
  channel: (_name: string) => new PollingChannel(),
  removeChannel: (channel: PollingChannel) => { channel.stop(); return Promise.resolve('ok'); },
};

/**
 * Keeps the rest of the Supabase client (edge functions) as it was and answers tables, database
 * functions, files and change notices through this app's server instead.
 */
export function withApiData<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'from') return apiData.from;
      if (property === 'rpc') return apiData.rpc;
      if (property === 'storage') return apiData.storage;
      if (property === 'channel') return apiData.channel;
      if (property === 'removeChannel') return apiData.removeChannel;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
