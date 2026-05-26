// Vercel Edge Function — thin proxy to the xpeed-mcp Supabase edge function.
// Exposes the MCP server at <app-origin>/api/mcp so clients always use the
// app's own domain instead of raw Supabase infrastructure URLs.
//
// Env var: VITE_SUPABASE_URL — already present in Vercel from frontend config.

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type',
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
  for (const key of ['authorization', 'x-api-key', 'content-type']) {
    const val = req.headers.get(key);
    if (val) forwarded.set(key, val);
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers: forwarded,
    body: req.body,
    // @ts-ignore — duplex is required for streaming request bodies in the Edge runtime
    duplex: 'half',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      ...CORS_HEADERS,
    },
  });
}
