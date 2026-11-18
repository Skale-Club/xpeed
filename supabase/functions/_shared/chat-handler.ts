// Shared in-app Real-car assistant and optional Virtual session coach (OpenRouter).
// - Credentials/model/billing are resolved on the server, managed only by super admin.
// - Platform-funded requests use the daily quota; failed calls return its unit.
// - The system prompt is built HERE from the database, scoped to the signed-in caller
//   (open problems, latest trips, trends, maintenance) plus how the app works. Whatever
//   "context" the browser sends is ignored, so it cannot inject instructions or inflate the
//   prompt; the prompt and the history are size-capped.
//
// deno-lint-ignore-file no-explicit-any
import { z } from "npm:zod@3.23.8";
import { AiProviderError, personalProviderFailure, resolveAiProvider } from "./ai-provider.ts";
import { consumeQuota, getServiceClient, getUserIdFromAuth, refundQuota } from "./quota.ts";
import { buildSystemPrompt, clampHistory, MAX_USER_MESSAGE_CHARS } from "./chat-prompt.ts";
import { loadCarPromptData } from "./car-data.ts";
import { buildVirtualCoachPrompt, loadVirtualCoachContext, VirtualCoachError, type CoachContext } from "./virtual-coach.ts";

// S04: validate request shape and bound sizes before doing any work / spending
// quota. Caps prevent token/cost inflation via huge message or history payloads.
// The app sends its UI language so answers come back in it (older clients send nothing → English).
const LANGUAGE_NAMES = { "en": "English", "pt-BR": "Brazilian Portuguese", "es-ES": "Spanish" } as const;
const LanguageSchema = z.enum(["en", "pt-BR", "es-ES"]).optional();

const ChatBodySchema = z.object({
  language: LanguageSchema,
  accountId: z.string().uuid().optional(),
  mode: z.enum(["real", "virtual"]).optional(),
  sessionId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  messageId: z.string().uuid().optional(),
  message: z.string().min(1).max(MAX_USER_MESSAGE_CHARS),
  // Which of the caller's cars is selected. Verified server-side; anything else in "context" is ignored.
  carProfileId: z.string().uuid().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  history: z
    // Old turns can be long (an answer is up to ~3000 chars): accept them, then clampHistory() keeps
    // only the newest turns that fit the budget and clips each one.
    .array(z.object({ role: z.enum(["user", "model"]), parts: z.string().max(8000) }))
    .max(50)
    .optional(),
}).superRefine((body, ctx) => {
  if (body.mode === "virtual") {
    if (!body.sessionId || !body.conversationId || !body.messageId || body.carProfileId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "A Virtual session, conversation and saved question are required" });
    }
  } else if (body.sessionId || body.conversationId || body.messageId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Virtual context requires Virtual mode" });
  }
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

// Web chat uses Google authentication. The first-party Companion bridge can
// supply a server-owned resolver only after authenticating the device, checking
// its explicit permission and pinning a saved Virtual question. No HTTP input
// can provide this resolver or impersonate an account.
export function createChatHandler(authenticate = getUserIdFromAuth) {
 return async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let userId: string | null = null;
  let quotaSpent = false;

  try {
    // 1. Authenticate
    userId = await authenticate(req.headers.get("Authorization"));
    if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

    // 2. Parse + validate body (S04)
    const parsed = ChatBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
    const body = parsed.data;
    if (body.accountId && body.accountId !== userId) return jsonResponse({ code: "unauthorized" }, 401);

    // Virtual context is explicit, owner-verified and fixed to the persisted
    // conversation. Fail before spending quota or contacting the provider.
    let coach: CoachContext | null = null;
    if (body.mode === "virtual") {
      // The retired Supabase project and local servers are development. Paid
      // coaching stays off there; tests use a simulated production provider.
      if (Deno.env.get("NODE_ENV") !== "production") {
        return jsonResponse({ error: "Coaching AI is disabled in development", code: "development_disabled" }, 503);
      }
      coach = await loadVirtualCoachContext(getServiceClient(), userId, {
        sessionId: body.sessionId!, conversationId: body.conversationId!, messageId: body.messageId!, message: body.message,
      });
    } else if (body.carProfileId) {
      const car = await getServiceClient().from("car_profiles").select("id").eq("id", body.carProfileId).eq("user_id", userId).maybeSingle();
      if (car.error) throw new AiProviderError("ai_preferences_unavailable");
      if (!car.data) return jsonResponse({ code: "context_not_found" }, 404);
    }

    // The caller's explicit billing choice is resolved only on the server.
    const provider = await resolveAiProvider(getServiceClient(), userId);
    if (provider.source === "personal" && Deno.env.get("NODE_ENV") !== "production") {
      return jsonResponse({ code: "development_disabled" }, 503);
    }

    // 4. Quota, only once an answer is possible. A failed AI call below gives it back.
    let quotaInfo: { remaining: number; limit: number } | undefined;
    if (provider.source === "global") try {
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
    const language = LANGUAGE_NAMES[body.language ?? "en"];
    const systemPrompt = coach
      ? buildVirtualCoachPrompt(coach.evidence, language)
      : buildSystemPrompt(await loadCarPromptData(getServiceClient(), userId, carHintFrom(body)), language);

    // OpenAI-compatible chat messages (OpenRouter). role "model" -> "assistant".
    const messages = [
      { role: "system", content: systemPrompt },
      ...clampHistory(coach ? coach.history : body.history).map((h) => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.parts,
      })),
      { role: "user", content: body.message },
    ];

    const aiRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: AbortSignal.timeout(45_000),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${provider.apiKey}`,
        "HTTP-Referer": "https://xpeed.skale.club",
        "X-Title": "Xpeed",
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.5,
        max_tokens: 800,
      }),
    });

    if (!aiRes.ok) {
      console.error("OpenRouter request failed", aiRes.status);
      if (quotaSpent) await refundQuota(userId, "chat_messages");
      quotaSpent = false;
      if (provider.source === "personal") {
        const failure = personalProviderFailure(aiRes.status);
        return jsonResponse({ error: failure.code, code: failure.code }, failure.status);
      }
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    const data: OpenRouterResponse = await aiRes.json();
    const reply = data.choices?.[0]?.message?.content ?? "";
    if (!reply.trim()) {
      if (quotaSpent) await refundQuota(userId, "chat_messages");
      quotaSpent = false;
      return jsonResponse({ error: "Upstream AI error" }, 502);
    }

    return jsonResponse({ reply, quota: quotaInfo });
  } catch (err: any) {
    if (err instanceof VirtualCoachError) return jsonResponse({ error: err.code, code: err.code, retryable: err.status === 503 }, err.status);
    if (err instanceof AiProviderError) return jsonResponse({ error: err.code, code: err.code }, err.status);
    // S09-2: log detail server-side only; never echo internal/DB messages to the client.
    console.error("chat error:", err);
    if (userId && quotaSpent) await refundQuota(userId, "chat_messages");
    return jsonResponse({ error: "Internal error" }, 500);
  }
 };
}
