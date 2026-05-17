// Supabase Edge Function: server-side Gemini analysis
// Improvement D1: removes the need for users to manage their own Gemini API key.
//
// Auth: requires a Supabase JWT (forwarded automatically by supabase-js).
// Secrets: GEMINI_API_KEY (set via `supabase secrets set GEMINI_API_KEY=...`)
//
// Request body:
//   {
//     sessionSummary: string;   // pre-formatted summary the client built
//     model?: string;           // gemini model id, default gemini-2.5-flash
//   }
// Response:
//   { analysis: { summary: string; key_findings: string[]; recommended_action: string } }

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "Server is missing GEMINI_API_KEY" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Require an authenticated Supabase user — even though we don't query the DB
    // directly here, this prevents anonymous abuse of the Gemini quota.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { sessionSummary, model = "gemini-2.5-flash" } = (await req.json()) as AnalyzeRequest;
    if (!sessionSummary || typeof sessionSummary !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid sessionSummary" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const prompt = `You are an automotive diagnostic assistant. Given the OBD2 session data below, produce a JSON response with three fields:
- summary: a 2-3 sentence plain-English overview of the session
- key_findings: an array of 1-4 short bullet strings (most notable observations)
- recommended_action: one short sentence telling the driver what (if anything) to do next

Output ONLY valid JSON, no prose around it.

Session data:
${sessionSummary}`;

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
      return new Response(
        JSON.stringify({ error: `Gemini error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data: GeminiResponse = await geminiRes.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { summary: rawText, key_findings: [], recommended_action: "" };
    }

    return new Response(
      JSON.stringify({ analysis: parsed }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
