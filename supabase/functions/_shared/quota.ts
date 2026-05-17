// Per-user daily quota enforcement for Edge Functions.
// Counts rows in a quota table that resets implicitly (we filter by
// created_at::date = current_date). No pg_cron needed = stays free-tier friendly.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_LIMITS = {
  chat_messages: 30,        // chat msgs/user/day
  analysis: 10,             // session analyses/user/day
};

export type QuotaKind = keyof typeof DEFAULT_LIMITS;

interface RecordedUseRow { kind: string; created_at: string }

let adminClient: ReturnType<typeof createClient> | null = null;
function getAdminClient() {
  if (adminClient) return adminClient;
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Missing service role env");
  adminClient = createClient(url, serviceKey, { auth: { persistSession: false } });
  return adminClient;
}

/**
 * Throws if the user has exceeded their daily quota for the given kind.
 * Otherwise records one usage and returns the remaining count.
 */
export async function consumeQuota(userId: string, kind: QuotaKind): Promise<{ remaining: number; limit: number }> {
  const limit = DEFAULT_LIMITS[kind];
  const client = getAdminClient();

  // Count today's usage
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { data: usage, error: countErr } = await (client as any)
    .from("user_quotas")
    .select("id", { count: "exact" })
    .eq("user_id", userId)
    .eq("kind", kind)
    .gte("created_at", startOfDay.toISOString());

  if (countErr) {
    // Quota table might not exist or there's a DB blip — fail open
    // (don't block the user just because quota tracking is broken).
    console.warn("Quota count failed, allowing through:", countErr.message);
    return { remaining: limit, limit };
  }

  const used = Array.isArray(usage) ? usage.length : 0;
  if (used >= limit) {
    const err = new Error(`Daily limit reached: ${used}/${limit} ${kind}`);
    (err as any).status = 429;
    (err as any).remaining = 0;
    (err as any).limit = limit;
    throw err;
  }

  // Record the use
  await (client as any).from("user_quotas").insert({ user_id: userId, kind });
  return { remaining: limit - used - 1, limit };
}

/**
 * Extract a user_id from a Supabase JWT in the Authorization header.
 * Returns null if anything fails — caller should treat as unauthenticated.
 */
export async function getUserIdFromAuth(authHeader: string | null): Promise<string | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length);
  try {
    const client = getAdminClient();
    const { data, error } = await (client as any).auth.getUser(token);
    if (error) return null;
    return (data?.user?.id as string) ?? null;
  } catch {
    return null;
  }
}
