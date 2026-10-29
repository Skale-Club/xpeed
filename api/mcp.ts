// Vercel Edge Function — thin proxy to the xpeed-mcp Supabase edge function.
// Exposes the MCP server at <app-origin>/api/mcp so clients always use the
// app's own domain instead of raw Supabase infrastructure URLs.
//
// Env var: VITE_SUPABASE_URL — already present in Vercel from frontend config.

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export default async function handler(req: Request): Promise<Response> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) {
    return new Response(
      JSON.stringify({ error: 'Server misconfiguration: VITE_SUPABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
    );
  }

  const target = `${supabaseUrl}/functions/v1/xpeed-mcp`;

  // Forward relevant auth + content headers
  const forwarded = new Headers();
  for (const key of ['authorization', 'x-api-key', 'content-type', 'mcp-protocol-version']) {
    const val = req.headers.get(key);
    if (val) forwarded.set(key, val);
  }

  const init = {
    method: req.method,
    headers: forwarded,
    body: req.body,
    duplex: 'half',
  };
  const upstream = await fetch(target, init);

  const responseHeaders = new Headers(CORS_HEADERS);
  responseHeaders.set('Content-Type', upstream.headers.get('Content-Type') ?? 'application/json');
  for (const key of ['WWW-Authenticate', 'MCP-Protocol-Version', 'Cache-Control']) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
