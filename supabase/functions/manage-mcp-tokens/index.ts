// RETIRED: manage-mcp-tokens.
//
// It stored tokens as the hex of the raw token (reversible, not a hash). The app creates, lists
// and revokes tokens itself now (Settings > MCP Server, src/lib/mcp-tokens.ts: SHA-256 hashed,
// one-year expiry) and the one MCP server is `xpeed-mcp` (reachable at <app>/api/mcp).
// This function now only answers 410 Gone so old clients get a clear pointer.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  return new Response(
    JSON.stringify({
      error: "gone",
      message: "manage-mcp-tokens has been retired. Create and revoke tokens in the app (Settings > MCP Server).",
      replacement: "xpeed-mcp",
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
