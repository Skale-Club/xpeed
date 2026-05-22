import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface AuthInfo {
  userId: string;
}

function createUserClient(jwt: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

function createAdminClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

function hashToken(raw: string): string {
  const bytes = new TextEncoder().encode(raw);
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authenticate(bearerToken: string): Promise<{ auth: AuthInfo; client: ReturnType<typeof createUserClient | typeof createAdminClient>; authMethod: "jwt" | "mcp_token" }> {
  // Try JWT auth first
  try {
    const client = createUserClient(bearerToken);
    const { data: { user }, error } = await client.auth.getUser();
    if (!error && user) {
      return { auth: { userId: user.id }, client, authMethod: "jwt" };
    }
  } catch {
    // Fall through to MCP token
  }

  // Try MCP token auth
  try {
    const admin = createAdminClient();
    const hash = hashToken(bearerToken);
    const { data, error } = await admin
      .from("mcp_tokens")
      .select("user_id, expires_at, revoked_at")
      .eq("token_hash", hash)
      .maybeSingle();

    if (error || !data) throw new Error("Invalid token");
    if (data.revoked_at) throw new Error("Token has been revoked");
    if (data.expires_at && new Date(data.expires_at) < new Date()) throw new Error("Token has expired");

    await admin.from("mcp_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", hash);

    return { auth: { userId: data.user_id }, client: admin, authMethod: "mcp_token" };
  } catch (err) {
    if (err instanceof Error && (err.message.includes("revoked") || err.message.includes("expired"))) throw err;
    throw new Error("Invalid authentication token. Use a valid Supabase JWT or MCP token.");
  }
}
