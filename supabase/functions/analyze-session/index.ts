// Supabase Edge Function: server-side Gemini session analysis.
// - Reads Gemini API key from app_settings (DB), falls back to env var.
// - Enforces per-user daily quota (10 analyses/day free tier).
// - Returns structured analysis JSON.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { getGeminiApiKey, getDefaultGeminiModel } from "../_shared/admin-config.ts";
import { consumeQuota, getUserIdFromAuth } from "../_shared/quota.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface AnalyzeRequest {
  sessionSummary: string;
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
        return jsonResponse({
          error: err.message,
          remaining: err.remaining,
          limit: err.limit,
        }, 429);
      }
      throw err;
    }

    // 3. Resolve Gemini key (DB first, env fallback)
    const apiKey = await getGeminiApiKey();
    if (!apiKey) {
      return jsonResponse(
        { error: "AI features are not configured. Ask an admin to set the Gemini API key in the Admin panel." },
        503,
      );
    }

    // 4. Parse body
    const body = (await req.json()) as AnalyzeRequest;
    if (!body.sessionSummary || typeof body.sessionSummary !== "string") {
      return jsonResponse({ error: "Missing sessionSummary" }, 400);
    }

    const model = body.model || await getDefaultGeminiModel();
    const prompt = `You are an automotive diagnostic assistant. Given the OBD2 session data below, produce a JSON response with three fields:
- summary: a 2-3 sentence plain-English overview of the session
- key_findings: an array of 1-4 short bullet strings (most notable observations)
- recommended_action: one short sentence telling the driver what (if anything) to do next

Output ONLY valid JSON, no prose around it.

Session data:
${body.sessionSummary}`;

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
      return jsonResponse({ error: `Upstream AI error` }, 502);
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
