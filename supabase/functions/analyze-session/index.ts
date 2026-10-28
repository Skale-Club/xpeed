// Supabase Edge Function: plain-language summary of one trip (OpenRouter).
// - Reads the structured trip report stored on the session (sessions.report),
//   plus the car's open problems, so the summary can say what is new, what
//   came back and what didn't show up this time.
// - Key + model come from the admin panel (app_settings).
// - Per-user daily quota, spent only once the request can actually be served.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { getOpenRouterApiKey, getDefaultModel } from "../_shared/admin-config.ts";
import { consumeQuota, getUserIdFromAuth } from "../_shared/quota.ts";

// The app sends its UI language so answers come back in it (older clients send nothing → English).
const LANGUAGE_NAMES = { "en": "English", "pt-BR": "Brazilian Portuguese", "es-ES": "Spanish" } as const;

const AnalyzeBodySchema = z.object({
  sessionId: z.string().uuid(),
  language: z.enum(["en", "pt-BR", "es-ES"]).optional(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface OpenRouterResponse { choices?: { message?: { content?: string } }[] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

const num = (v: unknown, digits = 1) => Number(v).toFixed(digits);

/** The stored trip report as a compact text block. */
function formatReport(report: Record<string, any>): string {
  const v = report.vehicle ?? {};
  const s = report.session ?? {};
  const d = report.diagnostics ?? {};
  const params: any[] = report.parameters ?? [];
  const flags: any[] = d.flags ?? [];

  const vehicle = [v.year, v.make, v.model].filter(Boolean).join(" ") || "Unknown vehicle";
  const lines: string[] = [
    `Vehicle: ${vehicle}${v.engine_type ? ` (${v.engine_type})` : ""}`,
    `Trip: ${s.duration_seconds ? `${Math.round(s.duration_seconds / 60)} min` : "unknown duration"}${s.session_start ? `, started ${s.session_start}` : ""}`,
    "",
    d.active_dtcs?.length ? `Fault codes stored by the car: ${(d.active_dtcs as string[]).join(", ")}` : "Fault codes stored by the car: none",
  ];

  for (const [severity, title] of [["critical", "CRITICAL READINGS"], ["attention", "READINGS TO WATCH"]] as const) {
    const list = flags.filter((f) => f.severity === severity);
    if (list.length === 0) continue;
    lines.push("", `${title}:`);
    for (const f of list) {
      lines.push(`  - ${f.message} (${num(f.pct_out_of_range, 0)}% of the trip out of range, longest ${num(f.longest_streak_s)} s)`);
    }
  }

  // Flagged parameters first, then the ones that moved the most.
  const flagged = new Set(flags.map((f) => f.canonical_key));
  const sorted = [...params].sort((a, b) =>
    (flagged.has(b.canonical_key) ? 1 : 0) - (flagged.has(a.canonical_key) ? 1 : 0) || (b.max - b.min) - (a.max - a.min)
  );
  lines.push("", `READINGS (${params.length} recorded, top ${Math.min(15, sorted.length)}):`);
  for (const p of sorted.slice(0, 15)) {
    const unit = p.unit ? ` ${p.unit}` : "";
    lines.push(`  ${p.label || p.canonical_key}: avg ${num(p.avg)}${unit}, min ${num(p.min)}, max ${num(p.max)}`);
  }
  return lines.join("\n").trim();
}

/** The car's open problems (Problems page), marking the ones seen in this trip. */
function formatOpenProblems(issues: any[], sessionId: string): string {
  if (issues.length === 0) return "OPEN PROBLEMS ON THIS CAR: none";
  const lines = ["OPEN PROBLEMS ON THIS CAR (from earlier trips and this one):"];
  for (const i of issues.slice(0, 10)) {
    const seenNow = i.last_session_id === sessionId;
    const isNew = i.first_session_id === sessionId;
    const tags = [
      i.severity,
      isNew ? "NEW in this trip" : seenNow ? "seen again in this trip" : "not seen in this trip",
      i.status === "recurred" ? `came back after being fixed (${i.recurrence_count}x)` : null,
    ].filter(Boolean).join(", ");
    lines.push(`  - ${i.canonical_key.startsWith("dtc:") ? `fault code ${i.canonical_key.slice(4)}` : i.title} — ${tags}`);
  }
  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Who is asking, and is the request well formed? (Before spending quota.)
    const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    const parsedBody = AnalyzeBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) return jsonResponse({ error: "Invalid request body" }, 400);
    const body = parsedBody.data;

    // 2. AI configured at all?
    const apiKey = await getOpenRouterApiKey();
    if (!apiKey) {
      return jsonResponse({ error: "AI features are not configured. Ask an admin to set the OpenRouter API key in the Admin panel.", code: "not_configured" }, 503);
    }

    // 3. The trip and its car's open problems. Service role bypasses RLS, so every
    //    query is scoped to the caller (S13-1).
    const db = getServiceClient();
    const { data: sessionRow, error: dbErr } = await (db as any)
      .from("sessions")
      .select("report, car_profile_id")
      .eq("id", body.sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (dbErr) console.warn("Could not fetch session report:", dbErr.message);
    if (!sessionRow?.report) return jsonResponse({ error: "Session report not found" }, 404);

    const { data: issues } = await (db as any)
      .from("vehicle_issues")
      .select("canonical_key, title, severity, status, recurrence_count, first_session_id, last_session_id")
      .eq("car_profile_id", sessionRow.car_profile_id)
      .eq("user_id", userId)
      .in("status", ["active", "recurred"])
      .order("last_seen_at", { ascending: false });

    // 4. Quota, now that the call will really happen.
    try {
      await consumeQuota(userId, "analysis");
    } catch (err: any) {
      if (err?.status === 429) {
        return jsonResponse({ error: err.message, code: "limit_reached", remaining: err.remaining, limit: err.limit }, 429);
      }
      throw err;
    }

    const report = sessionRow.report as Record<string, any>;
    const hybrid = String(report.vehicle?.engine_type ?? "").toLowerCase() === "hybrid";
    const languageName = LANGUAGE_NAMES[body.language ?? "en"];
    const prompt = `You explain a car trip to its owner, who has no mechanical knowledge. The trip was recorded automatically by the app from the car's diagnostic port.

Reply with JSON only, with three fields:
- summary: 2-3 sentences in plain, everyday words (no sensor names, units jargon or codes).
- key_findings: 0-4 short strings, only things that matter to the owner. Say whether a known problem showed up again or was not seen this time. Empty array if nothing stands out.
- recommended_action: one short sentence. If there is a CRITICAL reading (for example the engine running hot) or a severe fault code, tell them clearly to stop somewhere safe or not to drive far, and to see a mechanic. If nothing is wrong, say no action is needed.

Rules:
- Use only the data below; never invent readings or causes. If the data is too thin to judge, say so.
- Do not repeat raw numbers unless they help (e.g. "the engine reached 118 °C").
${hybrid ? "- This is a hybrid: engine speed at 0 while moving is normal (electric mode), and the engine starting and stopping is expected.\n" : ""}- Write every text value in ${languageName}. Keep the JSON field names in English.

${formatReport(report)}

${formatOpenProblems(issues ?? [], body.sessionId)}`;

    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://xpeed.skale.club",
        "X-Title": "Xpeed",
      },
      body: JSON.stringify({
        model: await getDefaultModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
    });

    if (!aiRes.ok) {
      console.error("OpenRouter error:", await aiRes.text());
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: OpenRouterResponse = await aiRes.json();
    const rawText = data.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { summary: rawText, key_findings: [], recommended_action: "" };
    }
    if (!Array.isArray(parsed.key_findings)) parsed.key_findings = [];

    return jsonResponse({ analysis: parsed });
  } catch (err: any) {
    // S09-2: log detail server-side only; never echo internal/DB messages to the client.
    console.error("analyze-session error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
