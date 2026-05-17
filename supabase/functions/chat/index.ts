// Supabase Edge Function: server-side Gemini chat
// Improvement D1: removes the need for users to manage their own Gemini API key.
//
// Auth: requires a Supabase JWT.
// Secrets: GEMINI_API_KEY
//
// Request body:
//   {
//     history: { role: 'user' | 'model'; parts: string }[];
//     message: string;
//     context: Record<string, unknown>;   // vehicle, trends, flags, etc.
//     model?: string;
//   }
// Response:
//   { reply: string }

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

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

function buildSystemPrompt(context: Record<string, unknown>): string {
  return `You are a friendly automotive diagnostic assistant. Use the following vehicle context to answer the user's question precisely. If the context doesn't contain enough information to answer, say so honestly and suggest what data would help.

Context:
${JSON.stringify(context, null, 2)}

Guidelines:
- Be concrete. Reference specific values from the context when relevant.
- Prefer practical next steps over generic advice.
- If you reference a DTC code, briefly explain what it means.
- Keep responses under 200 words unless the user explicitly asks for detail.`;
}

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

    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { history, message, context, model = "gemini-2.5-flash" } = (await req.json()) as ChatRequest;
    if (!message || typeof message !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing message" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const systemPrompt = buildSystemPrompt(context || {});
    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      { role: "model", parts: [{ text: "Got it. I'll keep my answers grounded in the context you provided." }] },
      ...(history || []).map(h => ({
        role: h.role,
        parts: [{ text: h.parts }],
      })),
      { role: "user", parts: [{ text: message }] },
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
      return new Response(
        JSON.stringify({ error: `Gemini error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data: GeminiResponse = await geminiRes.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return new Response(
      JSON.stringify({ reply }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
