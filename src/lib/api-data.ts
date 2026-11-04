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

export const apiData = {
  from: (table: string) => new QueryBuilder(table),
  rpc: (name: string, args?: Json) => new RpcBuilder(name, args),
};

/**
 * Keeps every other part of the Supabase client (storage, edge functions, realtime) as it was
 * and answers from() and rpc() through this app's server instead.
 */
export function withApiData<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === 'from') return apiData.from;
      if (property === 'rpc') return apiData.rpc;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
