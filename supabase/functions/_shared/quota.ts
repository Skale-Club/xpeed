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

  // S11-1: atomic check+insert via SECURITY DEFINER RPC with an advisory lock,
  // so concurrent requests cannot race past the cap. Returns remaining allowance,
  // or raises 'quota_exceeded' (Postgres code P0001) when the limit is reached.
  const { data: remaining, error } = await (client as any).rpc("consume_quota", {
    p_user_id: userId,
    p_kind: kind,
    p_limit: limit,
  });

  if (error) {
    const msg = String(error.message ?? "");
    if (msg.includes("quota_exceeded")) {
      const err = new Error(`Daily limit reached: ${limit}/${limit} ${kind}`);
      (err as any).status = 429;
      (err as any).remaining = 0;
      (err as any).limit = limit;
      throw err;
    }
    // S09-4: fail CLOSED for the costly path; the quota exists to cap paid spend,
    // so a tracking failure must not lift the cap silently.
    console.error("Quota RPC failed, denying request:", msg);
    // S09-3: record the failure so repeated quota-service errors are visible.
    try {
      await (client as any).from("security_events").insert({
        event_type: "quota_service_failure",
        user_id: userId,
        detail: { kind, error: msg },
      });
    } catch { /* never block on logging */ }
    const err = new Error("Quota service unavailable");
    (err as any).status = 429;
    (err as any).remaining = 0;
    (err as any).limit = limit;
    throw err;
  }

  return { remaining: typeof remaining === "number" ? remaining : limit - 1, limit };
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
