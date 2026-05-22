import { Hono } from "npm:hono@^4.9.7";
import { cors } from "npm:hono@^4.9.7/cors";
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

const app = new Hono();

app.use("/*", cors({
  origin: "*",
  allowHeaders: ["authorization", "content-type"],
  allowMethods: ["POST", "GET", "OPTIONS"],
  exposeHeaders: ["content-type"],
}));

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

function jsonRpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", result, id };
}

app.get("/health", (c) => c.json({ status: "ok", tools: TOOLS.length }));

const MAX_BODY_BYTES = 1024 * 100;

app.post("/", async (c) => {
  try {
    const authHeader = c.req.header("authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(jsonRpcError(null, -32000, "Missing or invalid Authorization header. Use: Authorization: Bearer <token>"), 401);
    }

    const bearerToken = authHeader.slice(7);
    const { auth: { userId }, client } = await authenticate(bearerToken);

    const body = await c.req.json();
    if (!body || body.jsonrpc !== "2.0") {
      return c.json(jsonRpcError(body?.id ?? null, -32600, "Invalid JSON-RPC request"), 400);
    }

    const { method, id, params } = body;

    if (method === "tools/list") {
      const tools = TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      return c.json(jsonRpcResult(id, { tools }));
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        return c.json(jsonRpcError(id, -32602, `Unknown tool: ${toolName}. Available tools: ${TOOLS.map((t) => t.name).join(", ")}`), 404);
      }
      try {
        const result = await tool.handler(client, args, userId);
        return c.json(jsonRpcResult(id, { content: result.content, isError: result.isError ?? false }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json(jsonRpcResult(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        }));
      }
    }

    if (method === "resources/list") {
      return c.json(jsonRpcResult(id, { resources: [] }));
    }

    if (method === "prompts/list") {
      return c.json(jsonRpcResult(id, { prompts: [] }));
    }

    return c.json(jsonRpcError(id, -32601, `Method not found: ${method}. Supported: tools/list, tools/call, resources/list, prompts/list`), 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    const status = message.includes("Authorization") || message.includes("token") || message.includes("Invalid") ? 401 : 500;
    return c.json(jsonRpcError(null, -32000, message), status);
  }
});

app.onError((err, c) => {
  return c.json(jsonRpcError(null, -32000, "Internal server error"), 500);
});

Deno.serve(app.fetch);
