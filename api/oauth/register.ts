// Proxy: <app>/api/oauth/register → Supabase xpeed-oauth/register
// Public endpoint for OAuth 2.1 Dynamic Client Registration (RFC 7591).


const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * The HTTP server normalizes these headers from the trusted proxy before invoking a route.
 * Forward the resulting caller address so the Edge Function can rate-limit each caller.
 */
function forwardClientIp(req: Request, headers: Headers): void {
  const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim();
  if (!ip) return;
  headers.set('x-forwarded-for', ip);
  headers.set('x-real-ip', ip);
}

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

  const forwarded = new Headers({ 'Content-Type': req.headers.get('Content-Type') ?? 'application/json' });
  forwardClientIp(req, forwarded);

  const init = {
    method: req.method,
    headers: forwarded,
    body: req.body,
    duplex: 'half',
  };
  const upstream = await fetch(`${supabaseUrl}/functions/v1/xpeed-oauth/register`, init);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
      ...CORS_HEADERS,
    },
  });
}
