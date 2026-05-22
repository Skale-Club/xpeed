import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ToolDefinition } from "../index.ts";
import { listSessions, getSession, getSessionFlags, getSessionRows } from "../services/sessions.ts";

export const listSessionsTool: ToolDefinition = {
  name: "list_sessions",
  description: "List OBD2 diagnostic sessions for a specific car profile. Results are paginated and sorted by session date (newest first). Returns session summary including date, filename, duration, and row count. Use get_session for more details on a specific session.",
  inputSchema: {
    type: "object",
    properties: {
      car_id: { type: "string", description: "The car profile ID" },
      cursor: { type: "string", description: "Opaque cursor for pagination. Pass the next_cursor value from a previous response to get the next page." },
      limit: { type: "number", description: "Maximum number of sessions to return (default 20, max 100)", default: 20 },
    },
    required: ["car_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const limit = Math.min(Math.max((args.limit as number) ?? 20, 1), 100);
    const result = await listSessions(client, args.car_id as string, args.cursor as string | undefined, limit, userId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};

export const getSessionTool: ToolDefinition = {
  name: "get_session",
  description: "Get detailed information about a specific OBD2 diagnostic session by its ID. Returns session metadata including filename, start/end time, duration, row count, and tracked parameters. Use list_sessions first to get session IDs.",
  inputSchema: {
    type: "object",
    properties: { session_id: { type: "string", description: "The session ID to retrieve" } },
    required: ["session_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const session = await getSession(client, args.session_id as string, userId);
    if (!session) {
      return { content: [{ type: "text", text: "Session not found." }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(session, null, 2) }] };
  },
};

export const getSessionFlagsTool: ToolDefinition = {
  name: "get_session_flags",
  description: "Get diagnostic flags and alerts for a specific OBD2 session. Returns severity (normal/attention/critical), parameter, message, and whether resolved. Use this to identify vehicle problems detected during a diagnostic session. By default only returns unresolved flags.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session ID" },
      include_resolved: { type: "boolean", description: "Whether to include resolved flags (default: false)", default: false },
    },
    required: ["session_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const flags = await getSessionFlags(client, args.session_id as string, args.include_resolved as boolean, userId);
    return { content: [{ type: "text", text: JSON.stringify(flags, null, 2) }] };
  },
};

export const getSessionRowsTool: ToolDefinition = {
  name: "get_session_rows",
  description: "Get the raw OBD2 time-series data rows for a specific session. Returns paginated data points with timestamp and parameter values. Use this to inspect the actual sensor readings when the summary or flags don't provide enough detail. Do NOT use this for every session — prefer get_session and get_session_flags which are more efficient.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string", description: "The session ID" },
      cursor: { type: "string", description: "Cursor for pagination based on t_seconds" },
      limit: { type: "number", description: "Maximum rows to return (default 100, max 1000)", default: 100 },
    },
    required: ["session_id"],
  },
  handler: async (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => {
    const limit = Math.min(Math.max((args.limit as number) ?? 100, 1), 1000);
    const result = await getSessionRows(client, args.session_id as string, args.cursor as string | undefined, limit, userId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  },
};
