import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface SessionSummary {
  id: string;
  car_profile_id: string | null;
  uploaded_at: string;
  source_filename: string;
  session_start: string | null;
  session_end: string | null;
  duration_seconds: number | null;
  row_count: number;
  columns: string[] | null;
  created_at: string;
}

export interface SessionFlag {
  id: string;
  session_id: string;
  severity: string;
  canonical_key: string;
  parameter_key: string;
  message: string;
  resolved: boolean | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  t_seconds: number | null;
  t_timestamp: string | null;
  data: Record<string, unknown>;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  returned: number;
  next_cursor?: string;
}

const SESSION_SELECT = "id, car_profile_id, uploaded_at, source_filename, session_start, session_end, duration_seconds, row_count, columns, created_at";

export async function listSessions(
  client: SupabaseClient,
  carProfileId: string,
  cursor?: string,
  limit: number = 20,
  userId?: string,
): Promise<PaginatedResult<SessionSummary>> {
  let query = client.from("sessions").select(SESSION_SELECT, { count: "exact" }).eq("car_profile_id", carProfileId);
  if (userId) query = query.eq("user_id", userId);
  query = query.order("session_start", { ascending: false, nullsFirst: false }).limit(limit + 1);
  if (cursor) query = query.lt("session_start", cursor);

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to list sessions: ${error.message}`);

  const items = data?.slice(0, limit) ?? [];
  const hasMore = (data?.length ?? 0) > limit;
  const lastItem = items[items.length - 1];

  return {
    items,
    total: count ?? 0,
    returned: items.length,
    ...(hasMore && lastItem?.session_start ? { next_cursor: lastItem.session_start } : {}),
  };
}

export async function getSession(client: SupabaseClient, sessionId: string, userId?: string): Promise<SessionSummary | null> {
  let query = client.from("sessions").select(SESSION_SELECT).eq("id", sessionId);
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Failed to get session: ${error.message}`);
  return data;
}

export async function getSessionFlags(
  client: SupabaseClient,
  sessionId: string,
  includeResolved: boolean = false,
  userId?: string,
): Promise<SessionFlag[]> {
  let query = client.from("session_flags").select("id, session_id, severity, canonical_key, parameter_key, message, resolved, created_at").eq("session_id", sessionId);
  if (userId) query = query.eq("user_id", userId);
  if (!includeResolved) query = query.or("resolved.is.null,resolved.eq.false");
  query = query.order("created_at", { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(`Failed to get session flags: ${error.message}`);
  return data ?? [];
}

export async function getSessionRows(
  client: SupabaseClient,
  sessionId: string,
  cursor?: string,
  limit: number = 100,
  userId?: string,
): Promise<PaginatedResult<SessionRow>> {
  let query = client.from("session_rows").select("id, t_seconds, t_timestamp, data", { count: "exact" }).eq("session_id", sessionId);
  if (userId) query = query.eq("user_id", userId);
  query = query.order("t_seconds", { ascending: true, nullsFirst: false }).limit(limit + 1);
  if (cursor) query = query.gt("t_seconds", cursor);

  const { data, error, count } = await query;
  if (error) throw new Error(`Failed to get session rows: ${error.message}`);

  const items = data?.slice(0, limit) ?? [];
  const hasMore = (data?.length ?? 0) > limit;
  const lastItem = items[items.length - 1];

  return {
    items,
    total: count ?? 0,
    returned: items.length,
    ...(hasMore && lastItem?.t_seconds != null ? { next_cursor: String(lastItem.t_seconds) } : {}),
  };
}
