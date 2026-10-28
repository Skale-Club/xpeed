// API-key token rules for xpeed-mcp. No imports: unit-tested from src/ and used unchanged in Deno.

export interface McpTokenRow {
  revoked_at?: string | null;
  expires_at?: string | null;
}

/** A token works while it is not revoked and not past its expiry. A missing expiry never expires (old tokens). */
export function isMcpTokenUsable(row: McpTokenRow | null | undefined, now: number = Date.now()): boolean {
  if (!row || row.revoked_at) return false;
  if (row.expires_at) {
    const expires = new Date(row.expires_at).getTime();
    if (Number.isNaN(expires) || expires <= now) return false;
  }
  return true;
}

/**
 * The API key sent with a request: X-API-Key or "Authorization: Bearer". Never the URL query
 * string (URLs end up in logs, history and referrers).
 */
export function tokenFromHeaders(headers: Pick<Headers, "get">): string | null {
  const bearer = headers.get("Authorization") || "";
  const bearerToken = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
  return headers.get("X-API-Key") || bearerToken || null;
}
