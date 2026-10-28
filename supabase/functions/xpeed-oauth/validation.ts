// Pure checks for xpeed-oauth. No imports: unit-tested from src/ and used unchanged in Deno.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Redirect URIs a dynamically registered client may use (RFC 8252 / OAuth 2.1):
 * https anywhere, or http only on a loopback host (native apps listening on localhost).
 * No credentials in the URL and no fragment.
 */
export function isAllowedRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

const IP_SHAPE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The caller's IP as forwarded by our Vercel proxy (api/oauth/*): the first x-forwarded-for entry,
 * else x-real-ip. Anything that is not shaped like an IP is treated as unknown, so the rate-limit
 * bucket key cannot be stuffed with arbitrary text.
 */
export function clientIpFrom(headers: Pick<Headers, "get">): string {
  const forwarded = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const candidate = forwarded || (headers.get("x-real-ip") ?? "").trim();
  return IP_SHAPE.test(candidate) ? candidate : "unknown";
}
