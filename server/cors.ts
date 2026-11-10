// CORS for routes that carry a bearer token (never cookies). The app is served from its own
// origin; the offline Android build runs from the Capacitor WebView and local dev from localhost.
const APP_ORIGINS = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);

export function corsHeaders(request: Request, methods = 'POST, OPTIONS', extraOrigins: string[] = []): Record<string, string> {
  const origin = request.headers.get('origin');
  const allowed = origin && (APP_ORIGINS.has(origin) || extraOrigins.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin));
  return allowed
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': methods, 'Access-Control-Max-Age': '600', Vary: 'Origin' }
    : { Vary: 'Origin' };
}
