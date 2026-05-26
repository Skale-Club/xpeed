// Supabase Edge Function: server-side Gemini session analysis.
// - Reads the structured session report from the DB (sessions.report).
// - Falls back to a raw sessionSummary string if no report is stored.
// - Reads Gemini API key from app_settings (DB), falls back to env var.
// - Enforces per-user daily quota (10 analyses/day free tier).
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGeminiApiKey, getDefaultGeminiModel } from "../_shared/admin-config.ts";
import { consumeQuota, getUserIdFromAuth } from "../_shared/quota.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AnalyzeRequest {
  sessionId?: string;
  sessionSummary?: string;
  model?: string;
}

interface GeminiPart { text: string }
interface GeminiCandidate { content?: { parts?: GeminiPart[] } }
interface GeminiResponse { candidates?: GeminiCandidate[] }

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

/**
 * Format a stored SessionReport into a compact AI-readable text block.
 * Mirrors formatReportForAI() from the client-side report-generator.ts.
 */
function formatReport(report: Record<string, any>): string {
  const v = report.vehicle ?? {};
  const s = report.session ?? {};
  const d = report.diagnostics ?? {};
  const params: any[] = report.parameters ?? [];

  const vehicleStr = [v.year, v.make, v.model].filter(Boolean).join(" ") || "Unknown vehicle";
  const engineStr = v.engine_type ? ` (${v.engine_type})` : "";
  const durationStr = s.duration_seconds
    ? `${Math.round(s.duration_seconds / 60)} min`
    : "unknown duration";

  const lines: string[] = [
    `Vehicle: ${vehicleStr}${engineStr}`,
    `Session: ${s.filename ?? "unknown"}, ${s.row_count ?? "?"} rows, ${durationStr}`,
    s.session_start ? `Recorded: ${s.session_start}` : "",
    "",
    "--- DIAGNOSTICS ---",
    d.active_dtcs?.length
      ? `Active DTCs: ${(d.active_dtcs as string[]).join(", ")}`
      : "Active DTCs: none",
    `Flags: ${d.flag_count ?? 0} total — ${d.critical_count ?? 0} critical, ${d.attention_count ?? 0} attention`,
  ];

  const flags: any[] = d.flags ?? [];
  const critical = flags.filter((f: any) => f.severity === "critical");
  if (critical.length > 0) {
    lines.push("", "CRITICAL:");
    critical.forEach((f: any) => {
      lines.push(
        `  - ${f.message} (${Number(f.pct_out_of_range).toFixed(0)}% out of range, ${Number(f.longest_streak_s).toFixed(1)}s streak)`
      );
    });
  }

  const attention = flags.filter((f: any) => f.severity === "attention");
  if (attention.length > 0) {
    lines.push("", "ATTENTION:");
    attention.forEach((f: any) => {
      lines.push(
        `  - ${f.message} (${Number(f.pct_out_of_range).toFixed(0)}% out of range, ${Number(f.longest_streak_s).toFixed(1)}s streak)`
      );
    });
  }

  // Top 15 params — flagged ones first, then by range
  const flaggedKeys = new Set(flags.map((f: any) => f.canonical_key));
  const sorted = [...params].sort((a: any, b: any) => {
    const aF = flaggedKeys.has(a.canonical_key) ? 1 : 0;
    const bF = flaggedKeys.has(b.canonical_key) ? 1 : 0;
    if (aF !== bF) return bF - aF;
    return (b.max - b.min) - (a.max - a.min);
  });

  lines.push("", `--- PARAMETERS (${params.length} total, showing top ${Math.min(15, sorted.length)}) ---`);
  sorted.slice(0, 15).forEach((p: any) => {
    const unitStr = p.unit ? ` ${p.unit}` : "";
    lines.push(
      `  ${p.label || p.canonical_key}: avg=${Number(p.avg).toFixed(1)}${unitStr}, min=${Number(p.min).toFixed(1)}, max=${Number(p.max).toFixed(1)}`
    );
  });

  return lines.filter(Boolean).join("\n").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Authenticate
    const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    // 2. Quota check
    try {
      await consumeQuota(userId, "analysis");
    } catch (err: any) {
      if (err?.status === 429) {
        return jsonResponse({ error: err.message, remaining: err.remaining, limit: err.limit }, 429);
      }
      throw err;
    }

    // 3. Resolve Gemini key
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return jsonResponse(
        { error: "AI features are not configured. Ask an admin to set the Gemini API key in the Admin panel." },
        503,
      );
    }

    // 4. Parse body
    const body = (await req.json()) as AnalyzeRequest;
    const model = body.model || await getDefaultGeminiModel();

    // 5. Build the session context — prefer structured report from DB
    let sessionContext: string;

    if (body.sessionId) {
      const db = getServiceClient();
      const { data: sessionRow, error: dbErr } = await (db as any)
        .from("sessions")
        .select("report")
        .eq("id", body.sessionId)
        .maybeSingle();

      if (dbErr) {
        console.warn("Could not fetch session report:", dbErr.message);
      }

      if (sessionRow?.report) {
        sessionContext = formatReport(sessionRow.report as Record<string, any>);
      } else if (body.sessionSummary) {
        // Fallback: report not yet stored, use legacy summary string
        sessionContext = body.sessionSummary;
      } else {
        return jsonResponse({ error: "Session report not found" }, 404);
      }
    } else if (body.sessionSummary && typeof body.sessionSummary === "string") {
      // Legacy path: caller passes a pre-formatted string
      sessionContext = body.sessionSummary;
    } else {
      return jsonResponse({ error: "Provide sessionId or sessionSummary" }, 400);
    }

    // 6. Build prompt and call Gemini
    const prompt = `You are an automotive diagnostic assistant. Given the OBD2 session data below, produce a JSON response with three fields:
- summary: a 2-3 sentence plain-English overview of the session
- key_findings: an array of 1-4 short bullet strings (most notable observations)
- recommended_action: one short sentence telling the driver what (if anything) to do next

Output ONLY valid JSON, no prose around it.

Session data:
${sessionContext}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 600,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: GeminiResponse = await geminiRes.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { summary: rawText, key_findings: [], recommended_action: "" };
    }

    return jsonResponse({ analysis: parsed });
  } catch (err: any) {
    console.error("analyze-session error:", err);
    return jsonResponse({ error: err?.message || String(err) }, 500);
  }
});
