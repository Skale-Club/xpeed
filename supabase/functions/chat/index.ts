// Supabase Edge Function: the in-app car assistant (OpenRouter).
// - Key + model come from the admin panel (app_settings).
// - Per-user daily quota (30 msgs/day), spent only when an answer is possible.
// - Builds a structured, human-readable system prompt from the car's state as
//   the app shows it (open problems, latest trips, trends, maintenance), plus
//   how the app itself works so it can help with the adapter and recording.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { getOpenRouterApiKey, getDefaultModel } from "../_shared/admin-config.ts";
import { consumeQuota, getUserIdFromAuth } from "../_shared/quota.ts";

// S04: validate request shape and bound sizes before doing any work / spending
// quota. Caps prevent token/cost inflation via huge message or history payloads.
// The app sends its UI language so answers come back in it (older clients send nothing → English).
const LANGUAGE_NAMES = { "en": "English", "pt-BR": "Brazilian Portuguese", "es-ES": "Spanish" } as const;
const LanguageSchema = z.enum(["en", "pt-BR", "es-ES"]).optional();

const ChatBodySchema = z.object({
  language: LanguageSchema,
  message: z.string().min(1).max(8000),
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

interface OpenRouterResponse { choices?: { message?: { content?: string } }[] }

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

interface Problem { title: string; meaning: string; action: string; code: string; severity: string; cameBack: number; lastSeen: string }
interface Trip { date: string; minutes: number | null; km: number | null; avgSpeedKmh: number | null; faultCodes: string[]; summary: string | null }
interface MaintenanceItem { type: string; date: string; odometer?: number | null }

// What the assistant needs to know about the app to help with setup questions.
const APP_GUIDE = `HOW THE XPEED APP WORKS (use this to answer questions about the app itself):
- The car is read through a small OBD2 adapter plugged in under the steering wheel. Only "Bluetooth LE"/"BLE" adapters work (e.g. Veepeak OBDCheck BLE, Vgate iCar Pro BLE); classic "Bluetooth 2.0" or Wi-Fi adapters do not.
- It works in the Xpeed Android app, or in Chrome/Edge on Android or a computer. iPhone/Safari cannot connect to the adapter.
- To start: turn the car on, open Home and tap "Start trip"; the first time, pick the adapter from the list. The app remembers it.
- "Always on" mode: leave the app open in the car; it reconnects by itself, records every trip automatically and rests while the car is off. Very short trips are not kept.
- If it can't connect: only one app can use the adapter at a time (close Car Scanner, Torque or similar), make sure the car is on, then try again.
- Each trip is checked automatically: the car's fault codes are read and anything unusual becomes a problem on the Problems page, with what to do. "Send to mechanic" on a trip creates a report link.`;

function fmtVehicle(v: Vehicle | null | undefined): string {
  if (!v) return "Unknown vehicle";
  const parts: string[] = [];
  if (v.year && v.make && v.model) parts.push(`${v.year} ${v.make} ${v.model}`);
  else if (v.name) parts.push(v.name);
  if (v.engine_type) parts.push(`(${v.engine_type})`);
  if (v.notes) parts.push(`Notes: ${v.notes}`);
  return parts.join(" ");
}

function buildSystemPrompt(context: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push("You are the car assistant inside the Xpeed app. You help an owner with no mechanical knowledge understand their car, using only the data below. If the data doesn't answer the question, say so honestly.");
  lines.push("");

  const vehicle = context.vehicle as Vehicle | null | undefined;
  lines.push(`CAR: ${fmtVehicle(vehicle)}`);
  lines.push(`TRIPS RECORDED: ${(context.sessionCount as number) ?? 0}`);

  // Open problems: exactly what the Problems page shows the user.
  const problems = (context.openProblems as Problem[]) || [];
  lines.push("");
  if (problems.length === 0) {
    lines.push("OPEN PROBLEMS: none (the app shows the car as OK).");
  } else {
    lines.push(`OPEN PROBLEMS (${problems.length}, as shown on the Problems page):`);
    for (const p of problems.slice(0, 10)) {
      const back = p.cameBack > 0 ? `, came back ${p.cameBack}x after being fixed` : "";
      lines.push(`  - [${p.severity}] ${p.title} (code ${p.code}${back}; last seen ${String(p.lastSeen).slice(0, 10)}): ${p.meaning} What to do: ${p.action}`);
    }
  }

  const trips = (context.lastTrips as Trip[]) || [];
  if (trips.length > 0) {
    lines.push("");
    lines.push("LATEST TRIPS (newest first):");
    for (const t of trips) {
      const facts = [
        t.minutes != null ? `${t.minutes} min` : null,
        t.km != null ? `${t.km} km` : null,
        t.avgSpeedKmh != null ? `avg ${t.avgSpeedKmh} km/h` : null,
        t.faultCodes?.length ? `fault codes ${t.faultCodes.join(", ")}` : null,
      ].filter(Boolean).join(", ");
      lines.push(`  - ${String(t.date).slice(0, 16).replace("T", " ")}: ${facts || "no details"}${t.summary ? ` (summary: ${t.summary})` : ""}`);
    }
  }

  // Trends: is something slowly getting worse?
  const trends = (context.trends as Trend[]) || [];
  const significant = trends.filter(t => Math.abs(t.delta_pct) >= 5).slice(0, 5);
  if (significant.length > 0) {
    lines.push("");
    lines.push("TRENDS (last 5 trips vs the 20 before):");
    for (const t of significant) {
      const direction = t.delta_pct > 0 ? "up" : "down";
      lines.push(`  - ${t.label || t.canonical_key} ${direction} ${Math.abs(t.delta_pct).toFixed(1)}% (now ${t.current_avg} vs before ${t.historic_avg}), ${t.trend}`);
    }
  }

  const maintenance = (context.maintenance as MaintenanceItem[]) || [];
  if (maintenance.length > 0) {
    lines.push("");
    lines.push(`SERVICES IN THE LAST 12 MONTHS (${maintenance.length}):`);
    for (const m of maintenance.slice(0, 5)) {
      const odo = m.odometer ? ` at ${m.odometer.toLocaleString()} km` : "";
      lines.push(`  - ${m.date}: ${m.type}${odo}`);
    }
  }

  lines.push("");
  lines.push(APP_GUIDE);
  lines.push("");
  lines.push("GUIDELINES:");
  lines.push("- Be concrete: refer to the problems and trips above when relevant, by their plain names.");
  lines.push("- Safety first: if there is a critical problem (e.g. engine running hot) or the user describes warning lights, smoke, smells, strange noises or overheating, tell them to stop somewhere safe and get help before anything else.");
  lines.push("- Never invent readings, causes or prices. You give hints from data, not a diagnosis; suggest a mechanic for anything uncertain.");
  if (String(vehicle?.engine_type ?? "").toLowerCase() === "hybrid") {
    lines.push("- This car is a hybrid: the engine stopping while driving (engine speed 0) is normal electric mode.");
  }
  lines.push("- Keep answers under 150 words unless the user asks for detail.");

  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Authenticate
    const userId = await getUserIdFromAuth(req.headers.get("Authorization"));
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    // 2. Parse + validate body (S04)
    const parsed = ChatBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
    const body = parsed.data;

    // 3. Resolve API key (OpenRouter, configured in /admin)
    const apiKey = await getOpenRouterApiKey();
    if (!apiKey) {
      return jsonResponse(
        { error: "AI features are not configured. Ask an admin to set the OpenRouter API key in the Admin panel.", code: "not_configured" },
        503,
      );
    }

    // 4. Quota, only once an answer is possible
    let quotaInfo: { remaining: number; limit: number } | undefined;
    try {
      quotaInfo = await consumeQuota(userId, "chat_messages");
    } catch (err: any) {
      if (err?.status === 429) {
        return jsonResponse({
          error: "You have reached today's chat limit on the free tier. Try again tomorrow.",
          code: "limit_reached",
          remaining: 0,
          limit: err.limit,
        }, 429);
      }
      throw err;
    }

    const languageName = LANGUAGE_NAMES[body.language ?? "en"];
    const systemPrompt = buildSystemPrompt(body.context || {}) +
      `\n\nAlways reply in ${languageName}, in plain everyday words; briefly explain any technical term you have to use.`;

    // OpenAI-compatible chat messages (OpenRouter). role "model" -> "assistant".
    const messages = [
      { role: "system", content: systemPrompt },
      ...(body.history || []).map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.parts,
      })),
      { role: "user", content: body.message },
    ];

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
        messages,
        temperature: 0.5,
        max_tokens: 800,
      }),
    });

    if (!aiRes.ok) {
      console.error("OpenRouter error:", await aiRes.text());
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: OpenRouterResponse = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content ?? "";

    return jsonResponse({ reply, quota: quotaInfo });
  } catch (err: any) {
    // S09-2: log detail server-side only; never echo internal/DB messages to the client.
    console.error("chat error:", err);
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
