// ai-health — validate the OpenRouter API key + model from the admin panel.
//
// Why a dedicated function instead of reusing /chat:
//  - tests the EXACT values typed in the form (before they're saved)
//  - reads the stored key FRESH (no 60s admin-config cache)
//  - consumes NO quota
//  - returns the REAL failure reason (status + provider message)
//
// Admin-only. Never returns the key value back to the client.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "openai/gpt-4o-mini";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getAdmin() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);

  const admin = getAdmin();

  // 1. Authenticate + require admin (the key-validity signal is admin-only).
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return json({ ok: false, reason: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userErr || !userId) return json({ ok: false, reason: "unauthorized" }, 401);

  const { data: prof } = await admin
    .from("car_profiles")
    .select("is_admin")
    .eq("user_id", userId)
    .eq("is_admin", true)
    .limit(1)
    .maybeSingle();
  if (!prof) return json({ ok: false, reason: "forbidden" }, 403);

  // 2. Resolve what to test: form values from the body first, else the stored
  //    settings read FRESH (no cache).
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  let apiKey: string | null = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : null;
  let model: string | null = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;

  if (!apiKey) {
    const { data } = await admin
      .from("app_settings")
      .select("setting_value")
      .is("user_id", null)
      .eq("setting_key", "admin_secret_openrouter_api_key")
      .maybeSingle();
    apiKey = (data?.setting_value as string | null)?.trim() || null;
  }
  if (!model) {
    const { data } = await admin
      .from("app_settings")
      .select("setting_value")
      .is("user_id", null)
      .eq("setting_key", "admin_openrouter_model")
      .maybeSingle();
    model = (data?.setting_value as string | null)?.trim() || DEFAULT_MODEL;
  }

  if (!apiKey) return json({ ok: false, reason: "no_key", message: "No OpenRouter API key set. Enter or save a key first." }, 200);

  // 3. Minimal real call: 1-token completion validates key + model + routing.
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://xpeed.skale.club",
        "X-Title": "Xpeed",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
  } catch (e) {
    return json({ ok: false, reason: "network_error", model, message: String((e as any)?.message ?? e) }, 200);
  }

  if (res.ok) {
    return json({ ok: true, model, message: `Key valid. Model "${model}" responded.` }, 200);
  }

  // 4. Surface the provider's real reason.
  let providerMsg = "";
  try {
    const errBody = await res.json();
    providerMsg = errBody?.error?.message || errBody?.message || JSON.stringify(errBody);
  } catch {
    providerMsg = await res.text().catch(() => "");
  }

  const reason =
    res.status === 401 ? "invalid_key" :
    res.status === 402 ? "insufficient_credits" :
    res.status === 404 ? "model_not_found" :
    res.status === 429 ? "rate_limited" :
    "provider_error";

  return json({ ok: false, reason, status: res.status, model, message: providerMsg.slice(0, 300) }, 200);
});
