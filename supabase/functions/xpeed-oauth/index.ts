// xpeed-oauth — OAuth 2.1 server for Claude.ai Custom Connectors + any MCP client.
//
// Routes (internal sub-paths):
//   POST /register   — Dynamic Client Registration (RFC 7591). Public.
//   POST /issue-code — Called by our SPA after user consent (requires Supabase JWT).
//   POST /token      — Exchange code for tokens, or refresh token rotation. Public.
//
// Access tokens are HS256 JWTs signed with XPEED_OAUTH_JWT_SECRET.
// Refresh tokens are opaque 48-byte random strings, SHA-256 hashed at rest, rotated on use.
// PKCE (S256) required for the authorization_code grant.
//
// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ACCESS_TOKEN_TTL = 60 * 60;             // 1 hour
const REFRESH_TOKEN_TTL = 60 * 60 * 24 * 30;  // 30 days
const CODE_TTL = 60 * 10;                      // 10 minutes

// --- Encoding helpers ---

function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64url(arr);
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = await sha256(input);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signJWT(payload: object, secret: string): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return `${data}.${b64url(sig)}`;
}

async function verifyPKCE(verifier: string, challenge: string): Promise<boolean> {
  const hash = await sha256(verifier);
  return b64url(hash) === challenge;
}

// --- Response helpers ---

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function oauthError(code: string, description: string, status = 400): Response {
  return json({ error: code, error_description: description }, status);
}

// --- Security helpers (S09-3 audit log, S11-2 rate limit) ---

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  return (xff ? xff.split(",")[0] : "").trim() || req.headers.get("x-real-ip") || "unknown";
}

// Fire-and-forget security event log. Never throws into the request path.
async function logSecurityEvent(
  db: any,
  eventType: string,
  detail: Record<string, unknown>,
  userId: string | null = null,
  ip: string | null = null,
): Promise<void> {
  try {
    await db.from("security_events").insert({ event_type: eventType, user_id: userId, ip, detail });
  } catch (e) {
    console.error("security_events insert failed:", (e as any)?.message ?? e);
  }
}

// Returns true if ALLOWED, false if the per-IP window limit is exceeded.
async function rateLimitOk(db: any, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("check_rate_limit", {
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      // Fail open on limiter error so a DB blip can't lock out the OAuth flow.
      console.error("rate limit check failed:", error.message);
      return true;
    }
    return data !== false;
  } catch (e) {
    console.error("rate limit check threw:", (e as any)?.message ?? e);
    return true;
  }
}

// --- Route handlers ---

async function handleRegister(req: Request, db: any): Promise<Response> {
  let metadata: any;
  try {
    metadata = await req.json();
  } catch {
    return oauthError("invalid_request", "Body must be valid JSON", 400);
  }

  const redirect_uris = metadata.redirect_uris;
  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    return oauthError("invalid_redirect_uri", "redirect_uris is required and must be a non-empty array", 400);
  }
  for (const uri of redirect_uris) {
    if (typeof uri !== "string" || !/^https?:\/\//.test(uri)) {
      return oauthError("invalid_redirect_uri", `Invalid redirect_uri: ${uri}`, 400);
    }
  }

  const client_id = crypto.randomUUID();
  const client_name = metadata.client_name || "Unnamed MCP Client";
  const grant_types = metadata.grant_types || ["authorization_code", "refresh_token"];
  const token_endpoint_auth_method = metadata.token_endpoint_auth_method || "none";

  const { error: dbErr } = await db.from("oauth_clients").insert({
    client_id,
    client_name,
    redirect_uris,
    grant_types,
    token_endpoint_auth_method,
    client_metadata: metadata,
  });
  if (dbErr) { console.error("oauth register dbErr:", dbErr.message); return oauthError("server_error", "Registration failed", 500); }

  return json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name,
    redirect_uris,
    grant_types,
    token_endpoint_auth_method,
    response_types: ["code"],
  }, 201);
}

async function handleIssueCode(
  req: Request,
  db: any,
  supabaseUrl: string,
  anonKey: string,
): Promise<Response> {
  const bearer = req.headers.get("Authorization") || "";
  const userJwt = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
  if (!userJwt) return oauthError("unauthorized", "Missing user JWT", 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return oauthError("unauthorized", "Invalid user JWT", 401);

  let body: any;
  try { body = await req.json(); } catch { return oauthError("invalid_request", "Invalid JSON", 400); }

  const { client_id, redirect_uri, code_challenge, code_challenge_method, scope } = body;
  if (!client_id || !redirect_uri || !code_challenge) {
    return oauthError("invalid_request", "Missing client_id, redirect_uri, or code_challenge", 400);
  }
  if (code_challenge_method !== "S256") {
    return oauthError("invalid_request", "Only S256 PKCE is supported", 400);
  }

  const { data: client } = await db
    .from("oauth_clients")
    .select("redirect_uris, client_name")
    .eq("client_id", client_id)
    .maybeSingle();
  if (!client) return oauthError("invalid_client", "Unknown client_id", 400);
  if (!client.redirect_uris.includes(redirect_uri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client", 400);
  }

  const code = randomToken(32);
  const expires_at = new Date(Date.now() + CODE_TTL * 1000).toISOString();

  const { error: insErr } = await db.from("oauth_authorization_codes").insert({
    code,
    client_id,
    user_id: user.id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    scope: scope || "mcp",
    expires_at,
  });
  if (insErr) { console.error("oauth issue-code insErr:", insErr.message); return oauthError("server_error", "Could not issue code", 500); }

  return json({ code });
}

async function issueTokens(
  db: any,
  issuer: string,
  jwtSecret: string,
  client_id: string,
  user_id: string,
  scope: string | null,
  previousRefreshHash: string | null,
): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const access_token = await signJWT({
    iss: issuer,
    sub: user_id,
    aud: `${issuer}/api/mcp`,
    exp: now + ACCESS_TOKEN_TTL,
    iat: now,
    client_id,
    scope: scope || "mcp",
    token_use: "access",
  }, jwtSecret);

  const refresh_token = randomToken(48);
  const refresh_hash = await sha256Hex(refresh_token);

  const { error: rtErr } = await db.from("oauth_refresh_tokens").insert({
    token_hash: refresh_hash,
    client_id,
    user_id,
    scope: scope || "mcp",
    expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString(),
    previous_token_hash: previousRefreshHash,
  });
  if (rtErr) { console.error("oauth refresh rtErr:", rtErr.message); return oauthError("server_error", "Token request failed", 500); }

  return json({
    access_token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token,
    scope: scope || "mcp",
  });
}

async function handleToken(
  req: Request,
  db: any,
  issuer: string,
  jwtSecret: string,
  ip: string = "unknown",
): Promise<Response> {
  let params: URLSearchParams;
  const contentType = req.headers.get("Content-Type") || "";
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      params = new URLSearchParams(await req.text());
    } else if (contentType.includes("application/json")) {
      const body = await req.json();
      params = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
    } else {
      return oauthError("invalid_request", "Content-Type must be application/x-www-form-urlencoded or application/json", 400);
    }
  } catch {
    return oauthError("invalid_request", "Invalid body", 400);
  }

  const grant_type = params.get("grant_type");

  // --- authorization_code grant ---
  if (grant_type === "authorization_code") {
    const code = params.get("code");
    const client_id = params.get("client_id");
    const redirect_uri = params.get("redirect_uri");
    const code_verifier = params.get("code_verifier");
    if (!code || !client_id || !redirect_uri || !code_verifier) {
      return oauthError("invalid_request", "Missing code, client_id, redirect_uri, or code_verifier", 400);
    }

    const { data: codeRow } = await db
      .from("oauth_authorization_codes")
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (!codeRow) return oauthError("invalid_grant", "Unknown authorization code", 400);
    if (codeRow.used_at) return oauthError("invalid_grant", "Code already used", 400);
    if (new Date(codeRow.expires_at) < new Date()) return oauthError("invalid_grant", "Code expired", 400);
    if (codeRow.client_id !== client_id) return oauthError("invalid_grant", "Client mismatch", 400);
    if (codeRow.redirect_uri !== redirect_uri) return oauthError("invalid_grant", "redirect_uri mismatch", 400);

    if (!(await verifyPKCE(code_verifier, codeRow.code_challenge))) {
      return oauthError("invalid_grant", "PKCE verification failed", 400);
    }

    await db.from("oauth_authorization_codes")
      .update({ used_at: new Date().toISOString() })
      .eq("code", code);

    return issueTokens(db, issuer, jwtSecret, codeRow.client_id, codeRow.user_id, codeRow.scope, null);
  }

  // --- refresh_token grant ---
  if (grant_type === "refresh_token") {
    const refresh_token = params.get("refresh_token");
    const client_id = params.get("client_id");
    if (!refresh_token || !client_id) {
      return oauthError("invalid_request", "Missing refresh_token or client_id", 400);
    }

    const tokenHash = await sha256Hex(refresh_token);
    const { data: rtRow } = await db
      .from("oauth_refresh_tokens")
      .select("*")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (!rtRow) return oauthError("invalid_grant", "Unknown refresh token", 400);

    if (rtRow.revoked_at) {
      // Reuse detected — revoke entire chain for this client+user
      await db.from("oauth_refresh_tokens")
        .update({ revoked_at: new Date().toISOString() })
        .eq("client_id", rtRow.client_id)
        .eq("user_id", rtRow.user_id)
        .is("revoked_at", null);
      // S09-3: this is a real attack signal — record it for alerting.
      await logSecurityEvent(db, "oauth_refresh_token_reuse", {
        client_id: rtRow.client_id,
      }, rtRow.user_id, ip);
      return oauthError("invalid_grant", "Refresh token reuse detected — all tokens revoked", 400);
    }

    if (new Date(rtRow.expires_at) < new Date()) return oauthError("invalid_grant", "Refresh token expired", 400);
    if (rtRow.client_id !== client_id) return oauthError("invalid_grant", "Client mismatch", 400);

    // Rotate
    await db.from("oauth_refresh_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", tokenHash);

    return issueTokens(db, issuer, jwtSecret, rtRow.client_id, rtRow.user_id, rtRow.scope, tokenHash);
  }

  return oauthError("unsupported_grant_type", `grant_type "${grant_type}" not supported`, 400);
}

// --- Entry point ---

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  // Strip everything up to and including the function name to get the sub-path
  const path = url.pathname.replace(/^.*\/xpeed-oauth/, "") || "/";

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const issuer = Deno.env.get("XPEED_APP_URL") || "https://xpeed-skaleclub.vercel.app";
  const jwtSecret = Deno.env.get("XPEED_OAUTH_JWT_SECRET");

  if (!jwtSecret) {
    return oauthError("server_error", "XPEED_OAUTH_JWT_SECRET not configured", 500);
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (req.method === "POST") {
    const ip = clientIp(req);
    // S11-2: per-IP rate limits on the public OAuth endpoints.
    if (path === "/register") {
      if (!(await rateLimitOk(db, `oauth_register:${ip}`, 10, 3600))) {
        await logSecurityEvent(db, "oauth_register_rate_limited", { path }, null, ip);
        return oauthError("temporarily_unavailable", "Too many registrations, try again later", 429);
      }
      return handleRegister(req, db);
    }
    if (path === "/issue-code") return handleIssueCode(req, db, supabaseUrl, anonKey);
    if (path === "/token") {
      if (!(await rateLimitOk(db, `oauth_token:${ip}`, 60, 60))) {
        await logSecurityEvent(db, "oauth_token_rate_limited", { path }, null, ip);
        return oauthError("temporarily_unavailable", "Too many token requests, slow down", 429);
      }
      return handleToken(req, db, issuer, jwtSecret, ip);
    }
  }

  return oauthError("not_found", `${req.method} ${path}`, 404);
});
