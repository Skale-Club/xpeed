// Supabase Edge Function: server-side Gemini chat with vehicle context.
// - Reads Gemini API key from app_settings (DB), falls back to env var.
// - Enforces per-user daily quota (30 chat msgs/day free tier).
// - Builds a STRUCTURED human-readable system prompt instead of dumping JSON.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { getGeminiApiKey, getDefaultGeminiModel } from "../_shared/admin-config.ts";
import { consumeQuota, getUserIdFromAuth } from "../_shared/quota.ts";

// S04: validate request shape and bound sizes before doing any work / spending
// quota. Caps prevent token/cost inflation via huge message or history payloads.
const ChatBodySchema = z.object({
  message: z.string().min(1).max(8000),
  model: z.string().regex(/^[a-zA-Z0-9.\-]{1,64}$/).optional(),
  context: z.record(z.unknown()).optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "model"]), parts: z.string().max(8000) }))
    .max(50)
    .optional(),
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ChatRequest {
  history: { role: "user" | "model"; parts: string }[];
  message: string;
  context: Record<string, unknown>;
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

interface Vehicle {
  name?: string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  vin?: string | null;
  engine_type?: string | null;
  notes?: string | null;
}

interface Trend {
  label?: string;
  canonical_key: string;
  current_avg: number;
  historic_avg: number;
  delta_pct: number;
  trend: string;
}

interface MaintenanceItem { type: string; date: string; odometer?: number | null }

function fmtVehicle(v: Vehicle | null | undefined): string {
  if (!v) return "Unknown vehicle";
  const parts: string[] = [];
  if (v.year && v.make && v.model) {
    parts.push(`${v.year} ${v.make} ${v.model}`);
  } else if (v.name) {
    parts.push(v.name);
  }
  if (v.engine_type) parts.push(`(${v.engine_type})`);
  if (v.vin) parts.push(`VIN: ${v.vin}`);
  if (v.notes) parts.push(`Notes: ${v.notes}`);
  return parts.join(" ");
}

function buildSystemPrompt(context: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("You are a friendly, concrete automotive diagnostic assistant. Use only the data below to answer the user's question. If the data is insufficient, say so honestly.");
  lines.push("");

  // Vehicle
  const vehicle = context.vehicle as Vehicle | null | undefined;
  lines.push(`VEHICLE: ${fmtVehicle(vehicle)}`);

  // Session stats
  const sessionCount = (context.sessionCount as number) ?? 0;
  lines.push(`SESSIONS RECORDED: ${sessionCount}`);

  // Recent sessions
  const recentSessions = (context.recentSessions as Array<{ date?: string; filename?: string; duration?: number | null }>) || [];
  if (recentSessions.length > 0) {
    lines.push("");
    lines.push(`RECENT SESSIONS (${recentSessions.length}):`);
    for (const s of recentSessions.slice(0, 5)) {
      const date = s.date ? new Date(s.date).toLocaleDateString() : "?";
      const dur = s.duration ? `${Math.round(s.duration / 60)} min` : "duration unknown";
      lines.push(`  - ${date} — ${s.filename || "session"} (${dur})`);
    }
  }

  // Active DTCs
  const dtcs = (context.activeDtcs as string[]) || [];
  if (dtcs.length > 0) {
    lines.push("");
    lines.push(`ACTIVE TROUBLE CODES (${dtcs.length}): ${dtcs.join(", ")}`);
  }

  // Trends — most actionable signal
  const trends = (context.trends as Trend[]) || [];
  const significant = trends.filter(t => Math.abs(t.delta_pct) >= 5).slice(0, 5);
  if (significant.length > 0) {
    lines.push("");
    lines.push("TRENDS (recent 5 vs prior 20 sessions):");
    for (const t of significant) {
      const direction = t.delta_pct > 0 ? "↑" : "↓";
      const label = t.label || t.canonical_key;
      lines.push(`  - ${label} ${direction} ${Math.abs(t.delta_pct).toFixed(1)}% (current ${t.current_avg} vs historic ${t.historic_avg}) — ${t.trend}`);
    }
  }

  // Maintenance
  const maintenance = (context.maintenance as MaintenanceItem[]) || [];
  if (maintenance.length > 0) {
    lines.push("");
    lines.push(`MAINTENANCE (last 12 months, ${maintenance.length} events):`);
    for (const m of maintenance.slice(0, 5)) {
      const odo = m.odometer ? ` @ ${m.odometer.toLocaleString()} km` : "";
      lines.push(`  - ${m.date}: ${m.type}${odo}`);
    }
  }

  lines.push("");
  lines.push("GUIDELINES:");
  lines.push("- Be concrete. Reference specific values from the context when relevant.");
  lines.push("- Prefer practical next steps over generic advice.");
  lines.push("- If you reference a DTC code, briefly explain what it means.");
  lines.push("- Keep responses under 200 words unless the user explicitly asks for detail.");

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Authenticate
    const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    // 2. Quota check
    let quotaInfo: { remaining: number; limit: number } | undefined;
    try {
      quotaInfo = await consumeQuota(userId, "chat_messages");
    } catch (err: any) {
      if (err?.status === 429) {
        return jsonResponse({
          error: "You have reached today's chat limit on the free tier. Try again tomorrow.",
          remaining: 0,
          limit: err.limit,
        }, 429);
      }
      throw err;
    }

    // 3. Resolve API key
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return jsonResponse(
        { error: "AI features are not configured. Ask an admin to set the Gemini API key in the Admin panel." },
        503,
      );
    }

    // 4. Parse + validate body (S04)
    const parsed = ChatBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
    const body = parsed.data;

    const model = body.model || await getDefaultGeminiModel();
    const systemPrompt = buildSystemPrompt(body.context || {});

    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "Got it — I'll keep my answers grounded in the data you provided." }] },
      ...(body.history || []).map(h => ({ role: h.role, parts: [{ text: h.parts }] })),
      { role: "user", parts: [{ text: body.message }] },
    ];

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.5, maxOutputTokens: 800 },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("Gemini error:", errText);
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: GeminiResponse = await geminiRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return jsonResponse({ reply, quota: quotaInfo });
  } catch (err: any) {
    // S09-2: log detail server-side only; never echo internal/DB messages to the client.
    console.error("chat error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
