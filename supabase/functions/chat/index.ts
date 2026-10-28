// Supabase Edge Function: the in-app car assistant (OpenRouter).
// - Key + model come from the admin panel (app_settings).
// - Per-user daily quota (30 msgs/day); a failed AI call gives its unit back.
// - The system prompt is built HERE from the database, scoped to the signed-in caller
//   (open problems, latest trips, trends, maintenance) plus how the app works. Whatever
//   "context" the browser sends is ignored, so it cannot inject instructions or inflate the
//   prompt; the prompt and the history are size-capped.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { z } from "npm:zod@3.23.8";
import { getOpenRouterApiKey, getDefaultModel } from "../_shared/admin-config.ts";
import { consumeQuota, getServiceClient, getUserIdFromAuth, refundQuota } from "../_shared/quota.ts";
import { buildSystemPrompt, clampHistory, MAX_USER_MESSAGE_CHARS } from "../_shared/chat-prompt.ts";
import { loadCarPromptData } from "../_shared/car-data.ts";

// S04: validate request shape and bound sizes before doing any work / spending
// quota. Caps prevent token/cost inflation via huge message or history payloads.
// The app sends its UI language so answers come back in it (older clients send nothing → English).
const LANGUAGE_NAMES = { "en": "English", "pt-BR": "Brazilian Portuguese", "es-ES": "Spanish" } as const;
const LanguageSchema = z.enum(["en", "pt-BR", "es-ES"]).optional();

const ChatBodySchema = z.object({
  language: LanguageSchema,
  message: z.string().min(1).max(MAX_USER_MESSAGE_CHARS),
  // Which of the caller's cars is selected. Verified server-side; anything else in "context" is ignored.
  carProfileId: z.string().uuid().optional(),
  context: z.record(z.unknown()).optional(),
  history: z
    // Old turns can be long (an answer is up to ~3000 chars): accept them, then clampHistory() keeps
    // only the newest turns that fit the budget and clips each one.
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

/** Only used to pick one of the caller's own cars when no id was sent (older app versions). */
function carHintFrom(body: z.infer<typeof ChatBodySchema>) {
  const vehicle = (body.context as any)?.vehicle;
  return {
    carProfileId: body.carProfileId ?? null,
    vin: typeof vehicle?.vin === "string" ? vehicle.vin.slice(0, 17) : null,
    name: typeof vehicle?.name === "string" ? vehicle.name.slice(0, 120) : null,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let userId: string | null = null;
  let quotaSpent = false;

  try {
    // 1. Authenticate
    userId = await getUserIdFromAuth(req.headers.get("Authorization"));
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

    // 4. Quota, only once an answer is possible. A failed AI call below gives it back.
    let quotaInfo: { remaining: number; limit: number } | undefined;
    try {
      quotaInfo = await consumeQuota(userId, "chat_messages");
      quotaSpent = true;
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

    // 5. The car's state, read from the database for THIS user.
    const carData = await loadCarPromptData(getServiceClient(), userId, carHintFrom(body));
    const systemPrompt = buildSystemPrompt(carData, LANGUAGE_NAMES[body.language ?? "en"]);

    // OpenAI-compatible chat messages (OpenRouter). role "model" -> "assistant".
    const messages = [
      { role: "system", content: systemPrompt },
      ...clampHistory(body.history).map((h) => ({
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
      await refundQuota(userId, "chat_messages");
      quotaSpent = false;
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: OpenRouterResponse = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content ?? "";
    if (!reply.trim()) {
      await refundQuota(userId, "chat_messages");
      quotaSpent = false;
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    return jsonResponse({ reply, quota: quotaInfo });
  } catch (err: any) {
    // S09-2: log detail server-side only; never echo internal/DB messages to the client.
    console.error("chat error:", err);
    if (userId && quotaSpent) await refundQuota(userId, "chat_messages");
    return jsonResponse({ error: "Internal error" }, 500);
  }
});
