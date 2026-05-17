// Shared helper: read admin-configured secrets from the database using the
// service role (bypasses RLS). 60-second in-memory cache to avoid hitting
// the DB on every Edge Function invocation — keeps us well inside Supabase's
// free-tier read budget.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface CacheEntry { value: string | null; expiresAt: number }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

let adminClient: ReturnType<typeof createClient> | null = null;
function getAdminClient() {
  if (adminClient) return adminClient;
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Edge runtime");
  }
  adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  return adminClient;
}

export async function getAdminSetting(settingKey: string): Promise<string | null> {
  const cached = cache.get(settingKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const client = getAdminClient();
    const { data, error } = await (client as any)
      .from("app_settings")
      .select("setting_value")
      .is("user_id", null)
      .eq("setting_key", settingKey)
      .maybeSingle();
    if (error) {
      console.warn("getAdminSetting query failed:", error.message);
      return cached?.value ?? null;
    }
    const value = (data?.setting_value as string | null) ?? null;
    cache.set(settingKey, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch (err) {
    console.warn("getAdminSetting threw:", err);
    return cached?.value ?? null;
  }
}

/**
 * Resolve the Gemini API key: DB-configured value first, env fallback.
 */
export async function getGeminiApiKey(): Promise<string | null> {
  const fromDb = await getAdminSetting("admin_secret_gemini_api_key");
  if (fromDb && fromDb.trim()) return fromDb.trim();
  return Deno.env.get("GEMINI_API_KEY") ?? null;
}

/**
 * Resolve the default Gemini model: DB value first, env, then fixed default.
 */
export async function getDefaultGeminiModel(): Promise<string> {
  const fromDb = await getAdminSetting("admin_gemini_model");
  if (fromDb && fromDb.trim()) return fromDb.trim();
  return Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
}
