// RETIRED: mcp-server.
//
// Its tokens were stored as reversible hex and it rejected the tokens the app creates (SHA-256).
// The one MCP server is `xpeed-mcp` (reachable at <app>/api/mcp). It checks token expiry and
// revocation, accepts the token in a header only, and is what the app's "MCP Server" settings
// create tokens for. This function now only answers 410 Gone so old clients get a clear pointer
// instead of stale behaviour. The rest of this folder is no longer served.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve((req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  return new Response(
    JSON.stringify({
      error: "gone",
      message: "mcp-server has been retired. Use the xpeed-mcp server (<app>/api/mcp) with a token created in Settings.",
      replacement: "xpeed-mcp",
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
