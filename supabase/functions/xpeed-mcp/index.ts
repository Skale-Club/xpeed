// Xpeed MCP Server — JSON-RPC 2.0 over HTTP (MCP protocol 2024-11-05)
//
// Auth — three accepted modes:
//   1. Xpeed OAuth JWT — Authorization: Bearer <our-issued-jwt>
//      Issued by /api/oauth/token after Dynamic Client Registration + PKCE flow.
//      HS256-signed with XPEED_OAUTH_JWT_SECRET. iss claim matches XPEED_APP_URL.
//   2. Supabase JWT   — Authorization: Bearer <supabase-jwt>
//      Any JWT issued by this Supabase project (email, Google OAuth, etc.)
//   3. API key token  — X-API-Key: <token> | Authorization: Bearer <token> | ?key=<token>
//      Opaque per-user tokens (SHA-256 hashed) from public.mcp_tokens.
//
// On 401, returns WWW-Authenticate header pointing to OAuth metadata so Claude.ai
// Custom Connector can discover the authorization server.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = Deno.env.get("XPEED_APP_URL") || "https://xpeed-skaleclub.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

function withAuthChallenge(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "WWW-Authenticate": `Bearer realm="xpeed-mcp", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`,
  };
}

function jsonRpc(id: unknown, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200, challenge = false): Response {
  const headers = { ...corsHeaders, "Content-Type": "application/json" };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: challenge ? withAuthChallenge(headers) : headers,
  });
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64urlDecode(input: string): Uint8Array {
  const pad = (4 - (input.length % 4)) % 4;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every(p => p.length > 0);
}

interface JWTPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  scope?: string;
  token_use?: string;
}

function decodeJWTPayload(token: string): JWTPayload | null {
  try {
    const [, payloadB64] = token.split(".");
    const json = new TextDecoder().decode(b64urlDecode(payloadB64));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function verifyXpeedJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const [headerB64, payloadB64, sigB64] = token.split(".");
  if (!headerB64 || !payloadB64 || !sigB64) return null;

  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const sig = b64urlDecode(sigB64);
  const valid = await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
  if (!valid) return null;

  const payload = decodeJWTPayload(token);
  if (!payload) return null;
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function ownsVehicle(db: SupabaseClient, userId: string, vehicleId: string): Promise<boolean> {
  const { data } = await db
    .from("car_profiles")
    .select("id")
    .eq("id", vehicleId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

const TOOLS = [
  {
    name: "list_vehicles",
    description: "List all vehicle profiles owned by the authenticated user. Returns id, name, make, model, year, engine_type.",
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
      properties: { session_id: { type: "string", description: "Session UUID" } },
      required: ["session_id"],
    },
  },
  {
    name: "get_vehicle_health",
    description: "Parameter baselines (rolling 20-session averages) plus recent critical/attention flags for a vehicle.",
    inputSchema: {
      type: "object",
      properties: { vehicle_id: { type: "string", description: "Car profile UUID" } },
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const jwtSecret = Deno.env.get("XPEED_OAUTH_JWT_SECRET");

  const url = new URL(req.url);
  const bearerHeader = req.headers.get("Authorization") || "";
  const bearerToken = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7) : null;
  const rawToken =
    req.headers.get("X-API-Key") ||
    req.headers.get("x-api-key") ||
    bearerToken ||
    url.searchParams.get("key");

  if (!rawToken) {
    return jsonRpcError(null, -32001, "Unauthorized: missing token", 401, true);
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let userId: string | null = null;

  if (looksLikeJwt(rawToken)) {
    const payload = decodeJWTPayload(rawToken);

    // Path A: our own OAuth JWT (iss === APP_URL)
    if (payload && payload.iss === APP_URL && jwtSecret) {
      const verified = await verifyXpeedJWT(rawToken, jwtSecret);
      if (verified && verified.sub) {
        userId = verified.sub;
      } else {
        return jsonRpcError(null, -32001, "Unauthorized: invalid Xpeed OAuth JWT", 401, true);
      }
    } else {
      // Path B: Supabase JWT
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${rawToken}` } },
        auth: { persistSession: false },
      });
      const { data: { user }, error } = await userClient.auth.getUser();
      if (error || !user) {
        return jsonRpcError(null, -32001, "Unauthorized: invalid or expired JWT", 401, true);
      }
      userId = user.id;
    }
  } else {
    // Path C: API key token (opaque)
    const tokenHash = await sha256Hex(rawToken);
    const { data: tokenRow } = await db
      .from("mcp_tokens")
      .select("id, user_id, revoked_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!tokenRow || tokenRow.revoked_at) {
      return jsonRpcError(null, -32001, "Unauthorized: invalid or revoked API key", 401, true);
    }

    userId = tokenRow.user_id as string;

    db.from("mcp_tokens")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", tokenRow.id)
      .then(() => {}, () => {});
  }

  if (!userId) {
    return jsonRpcError(null, -32001, "Unauthorized", 401, true);
  }

  // --- Parse JSON-RPC body ---
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error", 400);
  }

  const { id = null, method, params = {} } = body;
  if (!method) return jsonRpcError(id, -32600, "Invalid Request: missing method");

  switch (method) {
    case "initialize":
      return jsonRpc(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "xpeed-mcp", version: "4.0.0" },
      });

    case "notifications/initialized":
      return new Response(null, { status: 204, headers: corsHeaders });

    case "tools/list":
      return jsonRpc(id, { tools: TOOLS });

    case "tools/call": {
      const toolName = params.name as string;
      const args = (params.arguments || {}) as Record<string, unknown>;

      switch (toolName) {
        case "list_vehicles": {
          const { data, error } = await db
            .from("car_profiles")
            .select("id, name, make, model, year, engine_type, created_at")
            .eq("user_id", userId)
            .order("created_at", { ascending: false });
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        case "list_sessions": {
          const vid = args.vehicle_id as string;
          if (!(await ownsVehicle(db, userId, vid))) {
            return jsonRpcError(id, -32004, "Forbidden: vehicle not owned by this user");
          }
          const limit = Math.min(Number(args.limit) || 10, 50);
          const { data, error } = await db
            .from("sessions")
            .select("id, source_filename, uploaded_at, row_count, duration_seconds, active_dtcs, gemini_analysis")
            .eq("car_profile_id", vid)
            .eq("user_id", userId)
            .order("uploaded_at", { ascending: false })
            .limit(limit);
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        case "get_session_detail": {
          const sid = args.session_id as string;
          const sessionRes = await db
            .from("sessions")
            .select("id, source_filename, uploaded_at, row_count, duration_seconds, active_dtcs, columns, summary, gemini_analysis, user_id")
            .eq("id", sid)
            .eq("user_id", userId)
            .maybeSingle();
          if (sessionRes.error) return jsonRpcError(id, -32603, sessionRes.error.message);
          if (!sessionRes.data) return jsonRpcError(id, -32004, "Forbidden: session not found or not owned");

          const flagsRes = await db
            .from("session_flags")
            .select("severity, canonical_key, parameter_key, message, evidence, created_at")
            .eq("session_id", sid)
            .order("severity");

          return jsonRpc(id, {
            content: [{ type: "text", text: JSON.stringify({ session: sessionRes.data, flags: flagsRes.data ?? [] }, null, 2) }],
          });
        }

        case "get_vehicle_health": {
          const vid = args.vehicle_id as string;
          if (!(await ownsVehicle(db, userId, vid))) {
            return jsonRpcError(id, -32004, "Forbidden: vehicle not owned by this user");
          }

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
              .eq("user_id", userId)
              .order("uploaded_at", { ascending: false })
              .limit(5),
          ]);

          let recentFlags: any[] = [];
          if (recentSessionsRes.data?.length) {
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

          return jsonRpc(id, {
            content: [{ type: "text", text: JSON.stringify({ baselines: baselinesRes.data ?? [], recent_flags: recentFlags }, null, 2) }],
          });
        }

        case "list_maintenance": {
          const vid = args.vehicle_id as string;
          if (!(await ownsVehicle(db, userId, vid))) {
            return jsonRpcError(id, -32004, "Forbidden: vehicle not owned by this user");
          }
          const limit = Math.min(Number(args.limit) || 20, 100);
          const { data, error } = await db
            .from("maintenance_events")
            .select("id, type, date, odometer, notes, created_at")
            .eq("car_profile_id", vid)
            .eq("user_id", userId)
            .order("date", { ascending: false })
            .limit(limit);
          if (error) return jsonRpcError(id, -32603, error.message);
          return jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
        }

        case "list_flags": {
          const vid = args.vehicle_id as string;
          if (!(await ownsVehicle(db, userId, vid))) {
            return jsonRpcError(id, -32004, "Forbidden: vehicle not owned by this user");
          }
          const limit = Math.min(Number(args.limit) || 30, 100);

          const { data: sessions } = await db
            .from("sessions")
            .select("id")
            .eq("car_profile_id", vid)
            .eq("user_id", userId);

          if (!sessions?.length) {
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

          if (args.severity) query = query.eq("severity", args.severity as string);

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
