// What the read side (v1.ts) and the social side (_social.ts) of API v1 share: parameter checks, the opaque cursor, paging.
import type { SupabaseClient } from '@supabase/supabase-js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAME = /^[a-z][a-z0-9_]{0,31}$/;
export const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** A request the caller got wrong: the code names the parameter; nothing about it can work on a retry. */
export class Invalid extends Error {
  constructor(readonly code: string) { super(code); }
}

export type Item = Record<string, unknown> & { _k?: string; _i?: string };

export const encodeCursor = (time: string, id: string) => Buffer.from(JSON.stringify([time, id])).toString('base64url');
export function decodeCursor(raw: string | null): { t: string; id: string } | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string'
      && CURSOR_TIME.test(parsed[0]) && UUID.test(parsed[1])) return { t: parsed[0], id: parsed[1].toLowerCase() };
  } catch { /* falls through */ }
  throw new Invalid('invalid_cursor');
}

export function uuidParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  if (value === null || value === '') return null;
  if (!UUID.test(value)) throw new Invalid(`invalid_${name}`);
  return value.toLowerCase();
}
export function gameParam(params: URLSearchParams): string | null {
  const value = params.get('game');
  if (value === null || value === '') return null;
  if (!GAME.test(value)) throw new Invalid('invalid_game');
  return value;
}
/** A tyre compound as the game writes it: 1 to 40 characters, no control characters (the same rule as the lap file header). Null when absent. */
export function tyreParam(params: URLSearchParams): string | null {
  const value = params.get('tyre');
  if (value === null || value === '') return null;
  const chars = [...value];
  if (chars.length > 40 || chars.some((ch) => ch.charCodeAt(0) <= 0x1f || ch.charCodeAt(0) === 0x7f)) throw new Invalid('invalid_tyre');
  return value;
}
/** The aid boards a request can ask for (api/sim/_aids.ts sorts laps into classes; `all` is every lap). */
export const AID_BOARDS = ['all', 'no_tc_abs', 'none'] as const;
export type AidBoard = (typeof AID_BOARDS)[number];
/** The aid board of a request: all (the default), no_tc_abs or none; anything else is `400 invalid_aids`. */
export function aidsParam(params: URLSearchParams): AidBoard {
  const value = params.get('aids');
  if (value === null || value === '') return 'all';
  if (!(AID_BOARDS as readonly string[]).includes(value)) throw new Invalid('invalid_aids');
  return value as AidBoard;
}
/** 1 to 100, 50 when absent; a number above 100 is read as 100. */
export function limitParam(params: URLSearchParams): number {
  const value = params.get('limit');
  if (value === null || value === '') return DEFAULT_LIMIT;
  if (!/^\d{1,9}$/.test(value) || Number(value) < 1) throw new Invalid('invalid_limit');
  return Math.min(Number(value), MAX_LIMIT);
}

/** The functions return up to limit + 1 items: the extra one says there is another page, and the cursor points after the last one kept. */
export function paged(rows: Item[], limit: number): { items: Record<string, unknown>[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  const nextCursor = rows.length > limit && last?._k && last._i ? encodeCursor(last._k, last._i) : null;
  return { items: kept.map(({ _k, _i, ...item }) => item), nextCursor };
}

export async function call<T>(db: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const answer = await db.rpc(name, args);
  if (answer.error) throw answer.error;
  return answer.data as T;
}

export const failed = (event: string, error: unknown) => console.error(JSON.stringify({
  event,
  message: error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === 'string' ? (error as { message: string }).message : 'unknown',
}));
