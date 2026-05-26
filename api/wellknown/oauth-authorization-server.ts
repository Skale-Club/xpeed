// /.well-known/oauth-authorization-server (RFC 8414)
// Advertises our OAuth 2.1 authorization server capabilities and endpoints
// so Claude.ai can perform Dynamic Client Registration + PKCE flow.

export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  const host = req.headers.get('host') ?? 'xpeed-skaleclub.vercel.app';
  const origin = `${proto}://${host}`;

  return new Response(
    JSON.stringify({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      service_documentation: `${origin}/`,
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
