// Super-admin management of an account's OpenRouter billing choice. Ordinary
// users cannot read even metadata or change a source. Secrets are write-only.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { getServiceClient, getUserIdFromAuth } from "../_shared/quota.ts";
import { aiPreferenceStatus, AiProviderError, encryptPersonalKey, readAiPreference } from "../_shared/ai-provider.ts";

const schema = z.object({
  accountId: z.string().uuid(),
  action: z.enum(["accounts", "status", "save", "delete"]),
  targetAccountId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  mode: z.enum(["global", "personal"]).optional(),
  apiKey: z.string().trim().regex(/^[!-~]{16,512}$/).optional(),
  model: z.string().trim().regex(/^[a-z0-9][a-z0-9._:/-]{1,199}$/i).optional(),
});
const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return reply({ code: "method_not_allowed" }, 405);
  try {
    const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
    if (!userId) return reply({ code: "unauthorized" }, 401);
    const db = getServiceClient();
    // Same protected role as the existing Super-Admin Panel and global key
    // validator. Authorization is server-side, before parsing a key or reading
    // target accounts, metadata or credentials.
    const admin = await db.from("car_profiles").select("id").eq("user_id", userId).eq("is_admin", true).limit(1).maybeSingle();
    if (admin.error) throw new AiProviderError("ai_preferences_unavailable");
    if (!admin.data) return reply({ code: "forbidden" }, 403);
    // The HTTP server also limits function bodies. Bound this endpoint when
    // invoked directly, so an accidental pasted file is never parsed/stored.
    const text = await req.text();
    if (text.length > 4096) return reply({ code: "invalid_request" }, 400);
    let input: unknown;
    try { input = JSON.parse(text); } catch { return reply({ code: "invalid_request" }, 400); }
    const parsed = schema.safeParse(input);
    if (!parsed.success) return reply({ code: "invalid_request" }, 400);
    const body = parsed.data;
    if (body.accountId !== userId) return reply({ code: "unauthorized" }, 401);
    if (body.action === "accounts") {
      let query = db.from("app_accounts").select("id,full_name,email").order("id", { ascending: true }).limit(101);
      if (body.cursor) query = query.gt("id", body.cursor);
      const result = await query;
      if (result.error) throw new AiProviderError("ai_preferences_unavailable");
      const rows = result.data ?? [];
      const accounts = rows.slice(0, 100).map((row: { id: string; full_name: string | null; email: string | null }) => ({
        id: row.id, name: row.full_name?.slice(0, 120) ?? null, email: row.email?.slice(0, 254) ?? null,
      }));
      return reply({ accounts, nextCursor: rows.length > 100 ? accounts[accounts.length - 1].id : null });
    }
    const targetId = body.targetAccountId;
    if (!targetId) return reply({ code: "invalid_request" }, 400);
    const target = await db.from("app_accounts").select("id").eq("id", targetId).maybeSingle();
    if (target.error) throw new AiProviderError("ai_preferences_unavailable");
    if (!target.data) return reply({ code: "account_not_found" }, 404);
    if (body.action === "delete") {
      const result = await db.from("user_ai_preferences").delete().eq("user_id", targetId);
      if (result.error) throw new AiProviderError("ai_preferences_unavailable");
    } else if (body.action === "save") {
      if (!body.mode || (body.mode === "global" && body.apiKey)) return reply({ code: "invalid_request" }, 400);
      const old = await readAiPreference(db, targetId);
      let ciphertext = old?.api_key_ciphertext ?? null, iv = old?.api_key_iv ?? null, last4 = old?.key_last4 ?? null;
      if (body.apiKey) {
        const encrypted = await encryptPersonalKey(targetId, body.apiKey);
        ciphertext = encrypted.ciphertext; iv = encrypted.iv; last4 = body.apiKey.slice(-4);
      }
      if (body.mode === "personal" && (!ciphertext || !body.model)) return reply({ code: "personal_key_required" }, 400);
      const result = await db.from("user_ai_preferences").upsert({ user_id: targetId, mode: body.mode,
        api_key_ciphertext: ciphertext, api_key_iv: iv, key_last4: last4, model: body.model ?? old?.model ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      if (result.error) throw new AiProviderError("ai_preferences_unavailable");
    }
    return reply(await aiPreferenceStatus(db, targetId));
  } catch (error) {
    if (error instanceof AiProviderError) return reply({ code: error.code }, error.status);
    // Never log a request, database row, key, nonce, ciphertext or provider body.
    return reply({ code: "ai_preferences_unavailable" }, 503);
  }
});
