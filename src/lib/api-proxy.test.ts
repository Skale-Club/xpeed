import { afterEach, expect, it, vi } from 'vitest';
import handler from '../../api/mcp';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('preserves the upstream OAuth challenge at the public MCP endpoint', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  const fetch = vi.fn(async () => new Response('{}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://example.test/metadata"' } }));
  vi.stubGlobal('fetch', fetch);
  const response = await handler(new Request('https://example.test/api/mcp', { method: 'POST', body: '{}', headers: { 'MCP-Protocol-Version': '2025-03-26' } }));
  expect(response.status).toBe(401);
  expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate');
  const headers = fetch.mock.calls[0] as unknown as [string, { headers: Headers }];
  expect(headers[1].headers.get('MCP-Protocol-Version')).toBe('2025-03-26');
});
it('accepts preflight protocol headers without contacting the upstream', async () => {
  const response = await handler(new Request('https://example.test/api/mcp', { method: 'OPTIONS' }));
  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Headers')).toContain('mcp-protocol-version');
});
