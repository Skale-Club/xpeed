// The chained query calls of the Supabase client (from().select().eq()..., rpc()), collected into
// one request object. Pure: whoever builds it decides how the request is run (the browser sends it
// to /api/db, the server runs it against the database directly).
export type Json = unknown;
export interface ApiError { message: string; code?: string; details?: string | null; hint?: string | null }
export interface ApiResult { data: Json; error: ApiError | null; count?: number | null }
export type Runner = (payload: Record<string, unknown>) => PromiseLike<ApiResult>;
type Shape = 'many' | 'single' | 'maybe';
type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'contains';

export abstract class Chain implements PromiseLike<ApiResult> {
  protected shape: Shape = 'many';
  constructor(protected run: Runner) {}
  single() { this.shape = 'single'; return this; }
  maybeSingle() { this.shape = 'maybe'; return this; }
  protected abstract payload(): Record<string, unknown>;
  then<A = ApiResult, B = never>(
    onfulfilled?: ((value: ApiResult) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return Promise.resolve(this.run(this.payload())).then(onfulfilled, onrejected);
  }
}

type Action = 'select' | 'insert' | 'update' | 'upsert' | 'delete';

export class QueryBuilder extends Chain {
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

  constructor(private table: string, run: Runner) { super(run); }

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

export class RpcBuilder extends Chain {
  constructor(private name: string, private args: Json, run: Runner) { super(run); }
  protected payload() { return { kind: 'rpc', name: this.name, args: this.args ?? {}, shape: this.shape }; }
}
