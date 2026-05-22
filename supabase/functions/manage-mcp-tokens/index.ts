import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getClient(authHeader: string) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
}

async function getUserId(authHeader: string): Promise<string> {
  const client = getClient(authHeader);
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Unauthorized");
  return user.id;
}

function generateToken(): { raw: string; hash: string; prefix: string } {
  const raw = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  const hashBytes = new TextEncoder().encode(raw);
  const hash = Array.from(new Uint8Array(hashBytes))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return { raw, hash, prefix: raw.slice(0, 12) };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse(null, 204);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

    const userId = await getUserId(authHeader);
    const client = getClient(authHeader);
    const { action, name, token_id } = await req.json().catch(() => ({}));

    if (action === "list") {
      const { data, error } = await client
        .from("mcp_tokens")
        .select("id, name, token_prefix, expires_at, last_used_at, created_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return jsonResponse({ tokens: data ?? [] });
    }

    if (action === "create") {
      const { raw, hash, prefix } = generateToken();
      const { error } = await client
        .from("mcp_tokens")
        .insert({
          user_id: userId,
          name: name || `MCP Token ${new Date().toLocaleDateString()}`,
          token_hash: hash,
          token_prefix: prefix,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        });
      if (error) throw error;
      return jsonResponse({ token: raw, prefix, message: "Save this token — it will not be shown again." }, 201);
    }

    if (action === "revoke") {
      if (!token_id) return jsonResponse({ error: "Missing token_id" }, 400);
      const { error } = await client
        .from("mcp_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", token_id)
        .eq("user_id", userId);
      if (error) throw error;
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: `Unknown action: ${action}. Supported: list, create, revoke` }, 400);
  } catch (err) {
    console.error("manage-mcp-tokens error:", err);
    const message = err instanceof Error ? err.message : "Internal error";
    return jsonResponse({ error: message }, message === "Unauthorized" ? 401 : 500);
  }
});
