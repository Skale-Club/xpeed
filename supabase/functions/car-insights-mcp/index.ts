// Car Insights MCP Server — JSON-RPC 2.0 over HTTP (MCP protocol 2024-11-05)
// Auth: X-API-Key header matched against app_settings.mcp_api_key
// Uses service role to bypass RLS (trusted AI-agent-only endpoint).
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAdminSetting } from "../_shared/admin-config.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonRpc(id: unknown, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const TOOLS = [
  {
    name: "list_vehicles",
    description: "List all vehicle profiles. Returns id, name, make, model, year, engine_type.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_sessions",
    description: "List recent sessions for a vehicle. Returns id, filename, upload date, row count, active DTCs, and AI analysis summary.",
    inputSchema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "Car profile UUID" },
        limit: { type: "number", description: "Max sessions (default 10, max 50)" },
      },
      required: ["vehicle_id"],
    },
  },
  {
    name: "get_session_detail",
    description: "Full detail for one session: AI analysis, key findings, recommended action, and all diagnostic flags.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session UUID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "get_vehicle_health",
    description: "Parameter baselines (rolling 20-session averages) plus recent critical/attention flags for a vehicle.",
    inputSchema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "Car profile UUID" },
      },
      required: ["vehicle_id"],
    },
  },
  {
    name: "list_maintenance",
    description: "List maintenance events for a vehicle (type, date, odometer, notes).",
    inputSchema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "Car profile UUID" },
        limit: { type: "number", description: "Max events (default 20, max 100)" },
      },
      required: ["vehicle_id"],
    },
  },
  {
    name: "list_flags",
    description: "Recent diagnostic flags across all sessions for a vehicle, ordered by severity.",
    inputSchema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "Car profile UUID" },
        severity: { type: "string", enum: ["critical", "attention", "normal"], description: "Filter by severity (optional)" },
        limit: { type: "number", description: "Max flags (default 30, max 100)" },
      },
      required: ["vehicle_id"],
    },
  },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  // --- Auth ---
  const apiKey = req.headers.get("X-API-Key") || req.headers.get("x-api-key");
  const storedKey = await getAdminSetting("mcp_api_key");
  if (!storedKey || !apiKey || apiKey !== storedKey) {
    return jsonRpcError(null, -32001, "Unauthorized: missing or invalid X-API-Key", 401);
  }

  // --- Parse JSON-RPC ---
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error", 400);
  }

  const { id = null, method, params = {} } = body;
  if (!method) return jsonRpcError(id, -32600, "Invalid Request: missing method");

  // --- DB client (service role) ---
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- MCP protocol methods ---
  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "car-insights-mcp", version: "1.0.0" },
      });

    case "notifications/initialized":
      return new Response(null, { status: 204, headers: corsHeaders });

    case "tools/list":
      return jsonRpc(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params.name as string;
      const args = (params.arguments || {}) as Record<string, unknown>;

      switch (toolName) {
        // ---- list_vehicles ----
        case "list_vehicles": {
          const { data, error } = await db
            .from("car_profiles")
            .select("id, name, make, model, year, engine_type, created_at")
            .order("created_at", { ascending: false });
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        // ---- list_sessions ----
        case "list_sessions": {
          const limit = Math.min(Number(args.limit) || 10, 50);
          const { data, error } = await db
            .from("sessions")
            .select("id, source_filename, uploaded_at, row_count, duration_seconds, active_dtcs, gemini_analysis")
            .eq("car_profile_id", args.vehicle_id as string)
            .order("uploaded_at", { ascending: false })
            .limit(limit);
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        // ---- get_session_detail ----
        case "get_session_detail": {
          const [sessionRes, flagsRes] = await Promise.all([
            db
              .from("sessions")
              .select("id, source_filename, uploaded_at, row_count, duration_seconds, active_dtcs, columns, summary, gemini_analysis")
              .eq("id", args.session_id as string)
              .single(),
            db
              .from("session_flags")
              .select("severity, canonical_key, parameter_key, message, evidence, created_at")
              .eq("session_id", args.session_id as string)
              .order("severity"),
          ]);
          if (sessionRes.error) return jsonRpcError(id, -32603, sessionRes.error.message);
          const result = { session: sessionRes.data, flags: flagsRes.data ?? [] };
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        }

        // ---- get_vehicle_health ----
        case "get_vehicle_health": {
          const vid = args.vehicle_id as string;
          const [baselinesRes, recentSessionsRes] = await Promise.all([
            db
              .from("parameter_baselines")
              .select("parameter_key, avg_value, count, updated_at")
              .eq("car_profile_id", vid)
              .order("updated_at", { ascending: false }),
            db
              .from("sessions")
              .select("id, uploaded_at")
              .eq("car_profile_id", vid)
              .order("uploaded_at", { ascending: false })
              .limit(5),
          ]);

          // Fetch flags for recent sessions
          let recentFlags: any[] = [];
          if (recentSessionsRes.data && recentSessionsRes.data.length > 0) {
            const sessionIds = recentSessionsRes.data.map((s: any) => s.id);
            const { data: flags } = await db
              .from("session_flags")
              .select("severity, canonical_key, message, session_id, created_at")
              .in("session_id", sessionIds)
              .in("severity", ["critical", "attention"])
              .order("created_at", { ascending: false })
              .limit(30);
            recentFlags = flags ?? [];
          }

          const result = {
            baselines: baselinesRes.data ?? [],
            recent_flags: recentFlags,
          };
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        }

        // ---- list_maintenance ----
        case "list_maintenance": {
          const limit = Math.min(Number(args.limit) || 20, 100);
          const { data, error } = await db
            .from("maintenance_events")
            .select("id, type, date, odometer, notes, created_at")
            .eq("car_profile_id", args.vehicle_id as string)
            .order("date", { ascending: false })
            .limit(limit);
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        // ---- list_flags ----
        case "list_flags": {
          const vid = args.vehicle_id as string;
          const limit = Math.min(Number(args.limit) || 30, 100);

          // Get session IDs for this vehicle
          const { data: sessions } = await db
            .from("sessions")
            .select("id")
            .eq("car_profile_id", vid);

          if (!sessions || sessions.length === 0) {
            return jsonRpc(id, { content: [{ type: "text", text: "[]" }] });
          }

          const sessionIds = sessions.map((s: any) => s.id);
          let query = db
            .from("session_flags")
            .select("id, severity, canonical_key, parameter_key, message, evidence, session_id, created_at")
            .in("session_id", sessionIds)
            .order("severity")
            .order("created_at", { ascending: false })
            .limit(limit);

          if (args.severity) {
            query = query.eq("severity", args.severity as string);
          }

          const { data, error } = await query;
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
});
