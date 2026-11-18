// Resolve the account's explicit billing choice. Personal credentials are
// service-only ciphertext; a lookup/decryption failure never falls back to the
// platform key or another account. Nothing here calls the provider.
import { getDefaultModel, getOpenRouterApiKey } from "./admin-config.ts";

export class AiProviderError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 503) { super(code); this.code = code; this.status = status; }
}

export interface AiPreference {
  user_id: string;
  mode: "global" | "personal";
  api_key_ciphertext: string | null;
  api_key_iv: string | null;
  key_last4: string | null;
  model: string | null;
}
export interface AiProvider { source: "global" | "personal"; apiKey: string; model: string }

const encoder = new TextEncoder();
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function secretBytes(): Uint8Array {
  try {
    const secret = Deno.env.get("AI_CREDENTIAL_ENCRYPTION_KEY") ?? "";
    const bytes = fromBase64(secret);
    if (bytes.length === 32) return bytes;
  } catch { /* Never include a credential or environment value in an error. */ }
  throw new AiProviderError("credential_storage_unavailable");
}
export function personalKeyStorageAvailable(): boolean {
  try { secretBytes(); return true; } catch { return false; }
}

export async function encryptPersonalKey(userId: string, key: string): Promise<{ ciphertext: string; iv: string }> {
  const cryptoKey = await crypto.subtle.importKey("raw", secretBytes() as BufferSource, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(`xpeed:openrouter:v1:${userId}`) }, cryptoKey, encoder.encode(key));
  return { ciphertext: toBase64(new Uint8Array(encrypted)), iv: toBase64(iv) };
}

export async function decryptPersonalKey(row: AiPreference): Promise<string> {
  const secret = secretBytes();
  try {
    if (!row.api_key_ciphertext || !row.api_key_iv) throw new Error();
    const iv = fromBase64(row.api_key_iv);
    if (iv.length !== 12) throw new Error();
    const cryptoKey = await crypto.subtle.importKey("raw", secret as BufferSource, "AES-GCM", false, ["decrypt"]);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource,
      additionalData: encoder.encode(`xpeed:openrouter:v1:${row.user_id}`) }, cryptoKey, fromBase64(row.api_key_ciphertext) as BufferSource);
    return new TextDecoder().decode(bytes);
  } catch { throw new AiProviderError("personal_key_unavailable"); }
}

// deno-lint-ignore no-explicit-any
export async function readAiPreference(db: any, userId: string): Promise<AiPreference | null> {
  const result = await db.from("user_ai_preferences")
    .select("user_id,mode,api_key_ciphertext,api_key_iv,key_last4,model").eq("user_id", userId).maybeSingle();
  if (result.error) throw new AiProviderError("ai_preferences_unavailable");
  return result.data;
}

// deno-lint-ignore no-explicit-any
export async function resolveAiProvider(db: any, userId: string): Promise<AiProvider> {
  if (Deno.env.get("NODE_ENV") !== "production") throw new AiProviderError("development_disabled");
  const row = await readAiPreference(db, userId);
  if (row?.mode === "personal") {
    if (!row.model) throw new AiProviderError("personal_key_unavailable");
    return { source: "personal", apiKey: await decryptPersonalKey(row), model: row.model };
  }
  if (row && row.mode !== "global") throw new AiProviderError("ai_preferences_unavailable");
  const apiKey = await getOpenRouterApiKey();
  if (!apiKey) throw new AiProviderError("not_configured");
  return { source: "global", apiKey, model: await getDefaultModel() };
}

/** Safe metadata only: no plaintext, ciphertext, nonce or other user's row. */
// deno-lint-ignore no-explicit-any
export async function aiPreferenceStatus(db: any, userId: string) {
  const row = await readAiPreference(db, userId);
  return {
    mode: row?.mode ?? "global", keyConfigured: !!row?.api_key_ciphertext,
    keyLast4: row?.key_last4 ?? null, model: row?.model ?? null,
    canSaveKey: personalKeyStorageAvailable(), globalConfigured: !!await getOpenRouterApiKey(), globalModel: await getDefaultModel(),
  };
}

export function personalProviderFailure(status: number): { code: string; status: number } {
  if (status === 401 || status === 403) return { code: "invalid_personal_key", status: 422 };
  if (status === 402) return { code: "personal_credits_exhausted", status: 402 };
  if (status === 404) return { code: "personal_model_unavailable", status: 422 };
  if (status === 429) return { code: "provider_rate_limited", status: 429 };
  return { code: "provider_unavailable", status: 502 };
}
