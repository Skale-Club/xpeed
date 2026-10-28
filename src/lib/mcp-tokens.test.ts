import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        h.inserted.push(row);
        return {
          select: () => ({
            single: async () => ({ data: { id: 't1', name: row.name, token_prefix: row.token_prefix, expires_at: row.expires_at }, error: null }),
          }),
        };
      },
    }),
  },
}));

import { createMcpToken, MCP_TOKEN_LIFETIME_DAYS } from './mcp-tokens';

describe('createMcpToken', () => {
  it('stores only a SHA-256 hash and gives the token a one-year expiry', async () => {
    const before = Date.now();
    const { token, row } = await createMcpToken('Claude.ai');

    expect(MCP_TOKEN_LIFETIME_DAYS).toBe(365);
    const stored = h.inserted[0];
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    const expires = new Date(String(stored.expires_at)).getTime();
    const year = 365 * 24 * 60 * 60 * 1000;
    expect(expires).toBeGreaterThanOrEqual(before + year - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + year + 1000);
    expect(row.expires_at).toBe(stored.expires_at);
  });
});
