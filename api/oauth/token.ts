// Proxy: <app>/api/oauth/token → Supabase xpeed-oauth/token
// OAuth 2.1 token endpoint — authorization_code and refresh_token grants.

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  if (!supabaseUrl) {
    return new Response(
      JSON.stringify({ error: 'server_error', error_description: 'VITE_SUPABASE_URL not set' }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } },
    );
  }

  const upstream = await fetch(`${supabaseUrl}/functions/v1/xpeed-oauth/token`, {
    method: req.method,
    headers: { 'Content-Type': req.headers.get('Content-Type') ?? 'application/json' },
    body: req.body,
    // @ts-ignore
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
