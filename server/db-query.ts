// Runs the table queries and function calls the browser used to send to Supabase's
// PostgREST. The request is data (never SQL): table and column names are checked
// against the real schema, values are always bound parameters, and the work runs as
// the caller's database role so row level security decides what they can touch.
import type pg from 'pg';
import { asAnonymous, asIdentity, asService, asServiceTransaction, type VerifiedClaims } from './db';

type Row = Record<string, unknown>;
type Pool = pg.Pool;

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'contains';
export interface Filter { column: string; op: FilterOp; value: unknown }
export interface DbQuery {
  kind: 'query';
  table: string;
  action: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  select?: string;
  values?: Row | Row[];
  filters?: Filter[];
  or?: string[];
  order?: { column: string; ascending?: boolean; nullsFirst?: boolean }[];
  limit?: number;
  offset?: number;
  shape?: 'many' | 'single' | 'maybe';
  count?: boolean;
  head?: boolean;
  onConflict?: string;
  ignoreDuplicates?: boolean;
  returning?: boolean;
}
export interface DbRpc { kind: 'rpc'; name: string; args?: Row; shape?: 'many' | 'single' | 'maybe' }
export type DbRequest = DbQuery | DbRpc;
export interface DbError { message: string; code?: string; details?: string | null; hint?: string | null }
export interface DbResult { data: unknown; error: DbError | null; count?: number | null }

/** PostgREST caps a response; the app pages by this number. */
export const MAX_ROWS = 1000;
const OPS = new Set<FilterOp>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains']);
const SQL_OPERATOR: Partial<Record<FilterOp, string>> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TYPE = /^[a-z_][a-z0-9_]*$/;

class BadRequest extends Error {
  constructor(message: string, readonly code = 'XPEED400') { super(message); }
}

// ---------------------------------------------------------------- schema

interface Column { udt: string; json: boolean; array: boolean }
interface ForeignKey { child: string; parent: string; childColumns: string[]; parentColumns: string[] }
interface Table { name: string; columns: Map<string, Column>; primaryKey: string[] }
interface Schema { tables: Map<string, Table>; foreignKeys: ForeignKey[]; loadedAt: number }
interface FunctionInfo { returnsSet: boolean; returns: string; argNames: string[]; argTypes: string[] }

const SCHEMA_TTL_MS = 5 * 60_000;
const schemas = new WeakMap<Pool, Schema>();
const functions = new WeakMap<Pool, Map<string, FunctionInfo[]>>();

export function forgetSchema(pool: Pool) { schemas.delete(pool); functions.delete(pool); }

async function loadSchema(pool: Pool): Promise<Schema> {
  const cached = schemas.get(pool);
  if (cached && Date.now() - cached.loadedAt < SCHEMA_TTL_MS) return cached;
  const result = await asService(async (client) => {
    const columns = await client.query(`SELECT c.table_name, c.column_name, c.udt_name FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = 'public' ORDER BY c.table_name, c.ordinal_position`);
    const keys = await client.query(`SELECT cl.relname AS table_name, array_agg(a.attname::text ORDER BY k.ord) AS columns
      FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'p' AND cl.relnamespace = 'public'::regnamespace GROUP BY cl.relname, c.oid`);
    const fks = await client.query(`SELECT child.relname AS child, parent.relname AS parent,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
      FROM pg_constraint c JOIN pg_class child ON child.oid = c.conrelid JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE c.contype = 'f' AND child.relnamespace = 'public'::regnamespace AND parent.relnamespace = 'public'::regnamespace`);
    return { columns: columns.rows, keys: keys.rows, fks: fks.rows };
  }, pool);
  const tables = new Map<string, Table>();
  for (const row of result.columns) {
    const table = tables.get(row.table_name) ?? { name: row.table_name, columns: new Map(), primaryKey: [] };
    const udt = String(row.udt_name);
    table.columns.set(row.column_name, { udt, json: udt === 'json' || udt === 'jsonb', array: udt.startsWith('_') });
    tables.set(row.table_name, table);
  }
  for (const row of result.keys) { const table = tables.get(row.table_name); if (table) table.primaryKey = row.columns; }
  const loaded: Schema = {
    tables, loadedAt: Date.now(),
    foreignKeys: result.fks.map((r) => ({ child: r.child, parent: r.parent, childColumns: r.child_columns, parentColumns: r.parent_columns })),
  };
  schemas.set(pool, loaded);
  return loaded;
}

async function loadFunctions(pool: Pool, name: string): Promise<FunctionInfo[]> {
  let byName = functions.get(pool);
  if (!byName) { byName = new Map(); functions.set(pool, byName); }
  const known = byName.get(name);
  if (known) return known;
  const { rows } = await asService((client) => client.query(`SELECT p.proretset AS returns_set, format_type(p.prorettype, NULL) AS returns,
      coalesce((SELECT array_agg(a.n ORDER BY a.o) FROM unnest(coalesce(p.proargnames, '{}')) WITH ORDINALITY AS a(n, o)
        WHERE coalesce((p.proargmodes)[a.o], 'i') IN ('i', 'b', 'v')), '{}') AS arg_names,
      coalesce((SELECT array_agg(format_type(t, NULL) ORDER BY o) FROM unnest(string_to_array(p.proargtypes::text, ' ')::oid[]) WITH ORDINALITY AS u(t, o) WHERE p.proargtypes::text <> ''), '{}') AS arg_types
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1 AND p.prokind = 'f'`, [name]), pool);
  const infos = rows.map((r) => ({ returnsSet: r.returns_set, returns: r.returns, argNames: r.arg_names, argTypes: r.arg_types }));
  byName.set(name, infos);
  return infos;
}

// ---------------------------------------------------------------- building blocks

class Params {
  readonly values: unknown[] = [];
  add(value: unknown) {
    this.values.push(value !== null && typeof value === 'object' && !Array.isArray(value) ? JSON.stringify(value) : value);
    return `$${this.values.length}`;
  }
  addJson(value: unknown) { this.values.push(JSON.stringify(value)); return `$${this.values.length}::jsonb`; }
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

function tableOf(schema: Schema, name: unknown): Table {
  // Internal bookkeeping tables are never reachable, whatever the grants say.
  if (typeof name !== 'string' || !NAME.test(name) || name.startsWith('xpeed_')) throw new BadRequest('Unknown table');
  const table = schema.tables.get(name);
  if (!table) throw new BadRequest(`Unknown table "${name}"`, '42P01');
  return table;
}
function columnOf(table: Table, name: unknown): { sql: string; column: Column; name: string } {
  if (typeof name !== 'string' || !NAME.test(name)) throw new BadRequest('Invalid column');
  const column = table.columns.get(name);
  if (!column) throw new BadRequest(`Unknown column "${name}" on "${table.name}"`, '42703');
  return { sql: `t.${quote(name)}`, column, name };
}

function condition(table: Table, op: FilterOp, columnName: unknown, value: unknown, p: Params): string {
  if (!OPS.has(op)) throw new BadRequest(`Unsupported filter "${String(op)}"`);
  const { sql, column } = columnOf(table, columnName);
  switch (op) {
    case 'is':
      if (value === null || value === 'null') return `${sql} IS NULL`;
      if (value === true || value === 'true') return `${sql} IS TRUE`;
      if (value === false || value === 'false') return `${sql} IS FALSE`;
      throw new BadRequest('is() accepts null, true or false');
    case 'in': {
      if (!Array.isArray(value)) throw new BadRequest('in() needs a list');
      if (value.length === 0) return 'false';
      // Cast to the column's own type so uuid, int and timestamp lists compare correctly.
      const type = TYPE.test(column.udt) && !column.array ? column.udt : 'text';
      return type === 'text' && column.udt !== 'text' && column.udt !== 'varchar'
        ? `${sql}::text = ANY(${p.add(value)}::text[])`
        : `${sql} = ANY(${p.add(value)}::${type}[])`;
    }
    case 'contains':
      return column.json ? `${sql} @> ${p.addJson(value)}` : `${sql} @> ${p.add(value)}::${TYPE.test(column.udt) ? column.udt : 'text[]'}`;
    case 'like':
    case 'ilike':
      if (typeof value !== 'string') throw new BadRequest('like() needs text');
      return `${sql}::text ${op === 'like' ? 'LIKE' : 'ILIKE'} ${p.add(value)}`;
    default:
      if (value === undefined) throw new BadRequest('Missing filter value');
      return `${sql} ${SQL_OPERATOR[op]} ${p.add(value)}`;
  }
}

/** Splits on commas that are not inside parentheses. */
function splitTop(text: string): string[] {
  const parts: string[] = []; let depth = 0; let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** PostgREST's or() syntax, e.g. `a.lt.1,and(b.eq.2,c.lt.3)`. Items are OR-ed; and(...) groups are AND-ed. */
function orExpression(table: Table, text: string, p: Params, depth = 0): string {
  if (depth > 4) throw new BadRequest('or() is nested too deeply');
  const items = splitTop(text).map((item) => {
    const group = /^(and|or)\((.*)\)$/s.exec(item);
    if (group) return `(${splitTop(group[2]).map((inner) => orItem(table, inner, p, depth)).join(group[1] === 'and' ? ' AND ' : ' OR ')})`;
    return orItem(table, item, p, depth);
  });
  if (items.length === 0) throw new BadRequest('Empty or()');
  return `(${items.join(' OR ')})`;
}
function orItem(table: Table, item: string, p: Params, depth: number): string {
  if (/^(and|or)\(/.test(item)) return orExpression(table, item, p, depth + 1);
  const first = item.indexOf('.'); const second = first < 0 ? -1 : item.indexOf('.', first + 1);
  if (second < 0) throw new BadRequest('Malformed or() filter');
  const column = item.slice(0, first); const op = item.slice(first + 1, second) as FilterOp; const raw = item.slice(second + 1);
  const value = op === 'in' ? splitTop(raw.replace(/^\(|\)$/g, '')) : raw;
  return condition(table, op, column, value, p);
}

function where(table: Table, query: DbQuery, p: Params): string {
  const clauses = (query.filters ?? []).map((f) => condition(table, f.op, f.column, f.value, p));
  for (const expression of query.or ?? []) clauses.push(orExpression(table, expression, p));
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

/** `col, other, rel(col)`: plain columns plus one-to-one / one-to-many embeds through foreign keys. */
function selectList(schema: Schema, table: Table, alias: string, select: string | undefined, depth = 0): string {
  if (depth > 2) throw new BadRequest('Embedded selects are nested too deeply');
  const items: string[] = [];
  for (const part of splitTop(select?.trim() ? select : '*')) {
    if (part === '*') { items.push(`${alias}.*`); continue; }
    const embed = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s.exec(part);
    if (!embed) {
      const name = part.split('::')[0].trim();
      if (!NAME.test(name) || !table.columns.has(name)) throw new BadRequest(`Unknown column "${name}" on "${table.name}"`, '42703');
      items.push(`${alias}.${quote(name)}`);
      continue;
    }
    const related = tableOf(schema, embed[1]);
    const inner = `e${depth + 1}`;
    const toOne = schema.foreignKeys.find((fk) => fk.child === table.name && fk.parent === related.name);
    const toMany = schema.foreignKeys.find((fk) => fk.child === related.name && fk.parent === table.name);
    const link = (childAlias: string, childColumns: string[], parentAlias: string, parentColumns: string[]) =>
      childColumns.map((c, i) => `${childAlias}.${quote(c)} = ${parentAlias}.${quote(parentColumns[i])}`).join(' AND ');
    if (toOne) {
      const cols = selectList(schema, related, inner, embed[2], depth + 1);
      items.push(`(SELECT to_jsonb(r) FROM (SELECT ${cols} FROM public.${quote(related.name)} ${inner} WHERE ${link(alias, toOne.childColumns, inner, toOne.parentColumns)} LIMIT 1) r) AS ${quote(related.name)}`);
    } else if (toMany) {
      const cols = selectList(schema, related, inner, embed[2], depth + 1);
      items.push(`coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT ${cols} FROM public.${quote(related.name)} ${inner} WHERE ${link(inner, toMany.childColumns, alias, toMany.parentColumns)}) r), '[]'::jsonb) AS ${quote(related.name)}`);
    } else {
      throw new BadRequest(`No relationship between "${table.name}" and "${related.name}"`, 'PGRST200');
    }
  }
  return items.join(', ');
}

function orderBy(table: Table, query: DbQuery): string {
  const order = query.order ?? [];
  if (order.length === 0) return '';
  return ` ORDER BY ${order.map((o) => {
    const { sql } = columnOf(table, o.column);
    // Without nullsFirst the database default applies, exactly as it does for PostgREST.
    return `${sql}${o.ascending === false ? ' DESC' : ' ASC'}${o.nullsFirst === true ? ' NULLS FIRST' : o.nullsFirst === false ? ' NULLS LAST' : ''}`;
  }).join(', ')}`;
}

function windowOf(query: DbQuery): string {
  const limit = Math.min(Number.isInteger(query.limit) && (query.limit as number) >= 0 ? (query.limit as number) : MAX_ROWS, MAX_ROWS);
  const offset = Number.isInteger(query.offset) && (query.offset as number) > 0 ? (query.offset as number) : 0;
  return ` LIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`;
}

function rowsOf(values: unknown, table: Table): Row[] {
  const rows = Array.isArray(values) ? values : [values];
  if (rows.length === 0 || rows.length > 5000) throw new BadRequest('Between 1 and 5000 rows are expected');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BadRequest('Rows must be objects');
    for (const key of Object.keys(row)) columnOf(table, key);
  }
  return rows as Row[];
}
const keysOf = (rows: Row[]) => [...new Set(rows.flatMap((row) => Object.keys(row)))];

// ---------------------------------------------------------------- execution

type Run = (client: pg.PoolClient) => Promise<DbResult>;

/** The statement for one query, plus how to read its answer. */
async function compile(pool: Pool, query: DbQuery): Promise<Run> {
  const schema = await loadSchema(pool);
  const table = tableOf(schema, query.table);
  const p = new Params();
  const T = quote(table.name);
  const wantsRows = query.action === 'select' || query.returning === true;
  const filters = (query.filters?.length ?? 0) + (query.or?.length ?? 0);
  let statement: string;
  let countStatement: string | undefined;

  if (query.action === 'select') {
    const clause = where(table, query, p);
    const list = selectList(schema, table, 't', query.select);
    // head: only the count is wanted, so no row statement is run (it would not use the filter parameters).
    statement = query.head
      ? ''
      : `SELECT to_jsonb(q) AS r FROM (SELECT ${list} FROM public.${T} t${clause}${orderBy(table, query)}${windowOf(query)}) q`;
    if (query.count) countStatement = `SELECT count(*)::int AS n FROM public.${T} t${clause}`;
  } else {
    let write: string;
    if (query.action === 'insert' || query.action === 'upsert') {
      const rows = rowsOf(query.values, table);
      const keys = keysOf(rows);
      if (keys.length === 0) throw new BadRequest('Rows have no columns');
      const list = keys.map(quote).join(', ');
      let conflict = '';
      if (query.action === 'upsert') {
        const target = (query.onConflict ? query.onConflict.split(',').map((c) => c.trim()) : table.primaryKey);
        if (target.length === 0) throw new BadRequest('upsert() needs onConflict');
        target.forEach((c) => columnOf(table, c));
        const updates = keys.filter((k) => !target.includes(k));
        conflict = ` ON CONFLICT (${target.map(quote).join(', ')}) ${query.ignoreDuplicates || updates.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${updates.map((k) => `${quote(k)} = EXCLUDED.${quote(k)}`).join(', ')}`}`;
      }
      write = `INSERT INTO public.${T} AS t (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::public.${T}, ${p.addJson(rows)})${conflict}`;
    } else if (query.action === 'update') {
      if (filters === 0) throw new BadRequest('update() needs a filter');
      const values = rowsOf(query.values, table);
      if (values.length !== 1) throw new BadRequest('update() takes one object');
      const keys = Object.keys(values[0]);
      if (keys.length === 0) throw new BadRequest('Nothing to update');
      const source = p.addJson(values[0]);
      write = `UPDATE public.${T} AS t SET ${keys.map((k) => `${quote(k)} = r.${quote(k)}`).join(', ')} FROM jsonb_populate_record(NULL::public.${T}, ${source}) AS r${where(table, query, p)}`;
    } else if (query.action === 'delete') {
      if (filters === 0) throw new BadRequest('delete() needs a filter');
      write = `DELETE FROM public.${T} AS t${where(table, query, p)}`;
    } else {
      throw new BadRequest('Unsupported action');
    }
    statement = wantsRows
      ? `WITH w AS (${write} RETURNING t.*) SELECT to_jsonb(q) AS r FROM (SELECT ${selectList(schema, table, 't', query.select)} FROM w t) q`
      : write;
  }

  return async (client) => {
    const answer = statement ? await client.query(statement, p.values) : { rows: [] as { r: unknown }[] };
    let count: number | null | undefined;
    if (countStatement) count = (await client.query(countStatement, p.values)).rows[0].n;
    if (!wantsRows) return { data: null, error: null };
    const rows = answer.rows.map((row) => row.r as Row);
    return shape(rows, query.shape, count);
  };
}

function shape(rows: unknown[], mode: DbQuery['shape'], count?: number | null): DbResult {
  if (mode === 'single' || mode === 'maybe') {
    if (rows.length === 1) return { data: rows[0], error: null, count };
    if (mode === 'maybe' && rows.length === 0) return { data: null, error: null, count };
    return {
      data: null, count,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows`, hint: null },
    };
  }
  return { data: rows, error: null, count };
}

async function compileRpc(pool: Pool, call: DbRpc): Promise<Run> {
  if (typeof call.name !== 'string' || !NAME.test(call.name)) throw new BadRequest('Invalid function name');
  const args = call.args ?? {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new BadRequest('Arguments must be an object');
  const keys = Object.keys(args);
  keys.forEach((key) => { if (!NAME.test(key)) throw new BadRequest('Invalid argument name'); });
  const candidates = (await loadFunctions(pool, call.name))
    .filter((f) => keys.every((key) => f.argNames.includes(key)));
  if (candidates.length === 0) throw new BadRequest(`Could not find the function public.${call.name}`, 'PGRST202');
  // Overloads that differ only in optional arguments: prefer the one that takes exactly what was sent.
  const info = candidates.sort((a, b) => a.argNames.length - b.argNames.length)[0];
  const p = new Params();
  const named = keys.map((key) => {
    const type = info.argTypes[info.argNames.indexOf(key)] ?? '';
    const value = (args as Row)[key];
    return `${quote(key)} => ${type === 'json' || type === 'jsonb' ? p.addJson(value) : p.add(value)}`;
  });
  const callSql = `public.${quote(call.name)}(${named.join(', ')})`;
  const statement = info.returnsSet
    ? `SELECT to_jsonb(f) AS r FROM ${callSql} f`
    : info.returns === 'void' ? `SELECT ${callSql}, NULL::jsonb AS r` : `SELECT to_jsonb(${callSql}) AS r`;
  return async (client) => {
    const answer = await client.query(statement, p.values);
    if (info.returnsSet) return shape(answer.rows.map((row) => row.r), call.shape);
    const value = answer.rows[0]?.r ?? null;
    return call.shape === 'single' || call.shape === 'maybe' ? shape(value === null ? [] : [value], call.shape) : { data: value, error: null };
  };
}

function describe(error: unknown): DbError {
  if (error instanceof BadRequest) return { message: error.message, code: error.code, details: null, hint: null };
  const e = error as { message?: string; code?: string; detail?: string; hint?: string };
  // Database messages are written for developers but never hold other people's data beyond the row asked about.
  return { message: e.message ?? 'Request failed', code: e.code, details: e.detail ?? null, hint: e.hint ?? null };
}

/**
 * Who runs the work: a verified person, nobody (public pages such as shared reports), or the
 * server itself ('service': the database owner, no row level security; for the server's own jobs).
 */
export type Caller = VerifiedClaims | null | 'service';

export async function execute(pool: Pool, caller: Caller, request: DbRequest): Promise<DbResult> {
  try {
    const run = request.kind === 'rpc' ? await compileRpc(pool, request) : await compile(pool, request);
    const work = async (client: pg.PoolClient) => {
      await client.query("SET LOCAL statement_timeout = '20s'");
      const result = await run(client);
      // A single()/maybeSingle() that fails must undo the write it came with, as PostgREST does.
      if (result.error) throw Object.assign(new Error('rollback'), { result });
      return result;
    };
    if (caller === 'service') return await asServiceTransaction(work, pool);
    return caller ? await asIdentity(caller, work, pool) : await asAnonymous(work, pool);
  } catch (error) {
    const carried = (error as { result?: DbResult }).result;
    if (carried) return carried;
    return { data: null, error: describe(error) };
  }
}
