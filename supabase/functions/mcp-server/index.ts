import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate } from "./auth.ts";
import { listCarsTool, getCarTool } from "./tools/cars.ts";
import { listSessionsTool, getSessionTool, getSessionFlagsTool, getSessionRowsTool } from "./tools/sessions.ts";
import { getDtcInfoTool, searchDtcsTool } from "./tools/dtc.ts";
import { listMaintenanceTool } from "./tools/maintenance.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (client: SupabaseClient, args: Record<string, unknown>, userId?: string) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
}

const TOOLS: ToolDefinition[] = [
  listCarsTool, getCarTool,
  listSessionsTool, getSessionTool, getSessionFlagsTool, getSessionRowsTool,
  getDtcInfoTool, searchDtcsTool,
  listMaintenanceTool,
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return jsonResponse({ jsonrpc: "2.0", error: { code, message }, id }, code >= -32000 ? 400 : 500);
}

function jsonRpcResult(id: unknown, result: unknown) {
  return jsonResponse({ jsonrpc: "2.0", result, id });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return jsonResponse(null, 204);

  const url = new URL(req.url);

  if (req.method === "GET") {
    return jsonResponse({ status: "ok", tools: TOOLS.length, endpoints: ["POST / (JSON-RPC)"] });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse(jsonRpcError(null, -32000, "Missing or invalid Authorization header. Use: Authorization: Bearer <token>"), 401);
    }

    const bearerToken = authHeader.slice(7);
    const { auth: { userId }, client } = await authenticate(bearerToken);

    const body = await req.json();
    if (!body || body.jsonrpc !== "2.0") {
      return jsonResponse(jsonRpcError(body?.id ?? null, -32600, "Invalid JSON-RPC request"), 400);
    }

    const { method, id, params } = body;

    if (method === "tools/list") {
      const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      return jsonRpcResult(id, { tools });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return jsonResponse(jsonRpcError(id, -32602, `Unknown tool: ${toolName}. Available: ${TOOLS.map((t) => t.name).join(", ")}`), 404);
      }
      try {
        const result = await tool.handler(client, args, userId);
        return jsonRpcResult(id, { content: result.content, isError: result.isError ?? false });
      } catch (err) {
        return jsonRpcResult(id, { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true });
      }
    }

    if (method === "resources/list") return jsonRpcResult(id, { resources: [] });
    if (method === "prompts/list") return jsonRpcResult(id, { prompts: [] });

    return jsonResponse(jsonRpcError(id, -32601, `Method not found: ${method}. Supported: tools/list, tools/call, resources/list, prompts/list`), 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("Authorization") || message.includes("token") || message.includes("Invalid") ? 401 : 500;
    return jsonResponse(jsonRpcError(null, -32000, message), status);
  }
}

serve(handleRequest);
