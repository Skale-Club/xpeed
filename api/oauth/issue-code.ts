// Proxy: <app>/api/oauth/issue-code → Supabase xpeed-oauth/issue-code
// Called by our SPA after the user approves consent on /oauth/authorize.
// Requires Authorization: Bearer <supabase-jwt>.

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
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

  const forwarded = new Headers();
  const auth = req.headers.get('authorization');
  const ct = req.headers.get('content-type');
  if (auth) forwarded.set('authorization', auth);
  forwarded.set('content-type', ct ?? 'application/json');

  const upstream = await fetch(`${supabaseUrl}/functions/v1/xpeed-oauth/issue-code`, {
    method: req.method,
    headers: forwarded,
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
