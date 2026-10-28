import { supabase } from '@/integrations/supabase/client';

export interface McpToken {
  id: string;
  name: string;
  token_prefix: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url so the token is safe in a header or a config file.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Tokens stop working after this long; the MCP server rejects them afterwards. */
export const MCP_TOKEN_LIFETIME_DAYS = 365;

const TOKEN_COLUMNS = 'id, name, token_prefix, last_used_at, expires_at, created_at, revoked_at';

export async function listMcpTokens(): Promise<McpToken[]> {
  const { data, error } = await supabase
    .from('mcp_tokens' as never)
    .select(TOKEN_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as McpToken[];
}

export async function createMcpToken(name: string): Promise<{ token: string; row: McpToken }> {
  const raw = generateRawToken();
  const hash = await sha256Hex(raw);
  const prefix = raw.slice(0, 8);
  const expiresAt = new Date(Date.now() + MCP_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('mcp_tokens' as never)
    .insert({ name, token_hash: hash, token_prefix: prefix, expires_at: expiresAt } as never)
    .select(TOKEN_COLUMNS)
    .single();

  if (error) throw error;
  return { token: raw, row: data as unknown as McpToken };
}

export async function revokeMcpToken(id: string): Promise<void> {
  const { error } = await supabase
    .from('mcp_tokens' as never)
    .update({ revoked_at: new Date().toISOString() } as never)
    .eq('id', id);
  if (error) throw error;
}
