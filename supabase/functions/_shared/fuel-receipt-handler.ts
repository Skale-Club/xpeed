import {
  MAX_RECEIPT_BYTES,
  parseFuelReceipt,
  RECEIPT_PROMPT,
  receiptSchema,
  validReceiptImage,
} from "./fuel-receipt.ts";

export interface ReceiptDependencies {
  authenticate: (authorization: string | null) => Promise<string | null>;
  ownsCar: (userId: string, carId: string) => Promise<boolean>;
  apiKey: () => Promise<string | null>;
  model: () => Promise<string>;
  consume: (userId: string) => Promise<unknown>;
  refund: (userId: string) => Promise<void>;
  fetch: typeof fetch;
}
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createReceiptHandler(deps: ReceiptDependencies) {
  let registry: {
    until: number;
    models: {
      id: string;
      architecture?: { input_modalities?: string[] };
      supported_parameters?: string[];
    }[];
  } | null = null;
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405);
    let user: string | null = null, spent = false;
    const refund = async () => {
      if (user && spent) {
        spent = false;
        try {
          await deps.refund(user);
        } catch { /* Quota refund is best effort. */ }
      }
    };
    try {
      user = await deps.authenticate(req.headers.get("Authorization"));
      if (!user) return json({ code: "unauthorized" }, 401);
      const limit = Math.ceil(MAX_RECEIPT_BYTES / 3) * 4 + 1024;
      if (Number(req.headers.get("content-length")) > limit) {
        return json({ code: "image_too_large" }, 413);
      }
      // Bound the actual body too, including chunked requests without Content-Length.
      const reader = req.body?.getReader();
      if (!reader) return json({ code: "invalid_image" }, 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return json({ code: "image_too_large" }, 413);
        }
        chunks.push(value);
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder().decode(all));
      } catch {
        return json({ code: "invalid_image" }, 400);
      }
      if (
        !body || !UUID.test(body.carId ?? "") || !validReceiptImage(body.image)
      ) return json({ code: "invalid_image" }, 400);
      if (!await deps.ownsCar(user, body.carId)) {
        return json({ code: "car_unavailable" }, 404);
      }
      const key = await deps.apiKey();
      if (!key) return json({ code: "not_configured" }, 503);
      const model = await deps.model();
      if (!registry || registry.until < Date.now()) {
        const response = await deps.fetch(
          "https://openrouter.ai/api/v1/models",
          { signal: AbortSignal.timeout(10000) },
        );
        if (!response.ok) return json({ code: "unavailable" }, 503);
        const catalog = await response.json();
        if (!Array.isArray(catalog.data)) {
          return json({ code: "unavailable" }, 503);
        }
        registry = { until: Date.now() + 60000, models: catalog.data };
      }
      const info = registry.models.find((item) => item.id === model);
      if (
        !info?.architecture?.input_modalities?.includes("image") ||
        !info.supported_parameters?.includes("structured_outputs")
      ) return json({ code: "vision_unavailable" }, 503);
      try {
        await deps.consume(user);
        spent = true;
      } catch (e) {
        return json(
          {
            code:
              e instanceof Error && e.message.startsWith("Daily limit reached")
                ? "limit_reached"
                : "unavailable",
          },
          e instanceof Error && e.message.startsWith("Daily limit reached")
            ? 429
            : 503,
        );
      }
      const response = await deps.fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(35000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
            "HTTP-Referer": "https://xpeed.skale.club",
            "X-Title": "Xpeed",
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            max_tokens: 300,
            provider: { require_parameters: true },
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "fuel_receipt",
                strict: true,
                schema: receiptSchema,
              },
            },
            messages: [{ role: "system", content: RECEIPT_PROMPT }, {
              role: "user",
              content: [{
                type: "text",
                text: "Read the fuel purchase values in this image.",
              }, { type: "image_url", image_url: { url: body.image } }],
            }],
          }),
        },
      );
      if (!response.ok) {
        await refund();
        return json({ code: "unavailable" }, 502);
      }
      const result = await response.json();
      const text = result?.choices?.[0]?.message?.content;
      let receipt = null;
      try {
        if (typeof text === "string" && text.length <= 4000) {
          receipt = parseFuelReceipt(JSON.parse(text));
        }
      } catch { /* Untrusted provider output. */ }
      if (!receipt) {
        await refund();
        return json({ code: "unreadable" }, 422);
      }
      return json({ receipt });
    } catch {
      await refund();
      return json({ code: "unavailable" }, 503);
    }
  };
}
