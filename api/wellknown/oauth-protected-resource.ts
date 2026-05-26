// /.well-known/oauth-protected-resource (RFC 9728)
// Tells Claude.ai (and other MCP clients) which authorization server can issue
// tokens for our MCP endpoint, so they can discover the OAuth flow.

export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'xpeed-skaleclub.vercel.app';
  const origin = `${proto}://${host}`;

  return new Response(
    JSON.stringify({
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
      resource_documentation: `${origin}/`,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}
