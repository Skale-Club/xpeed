import { supabase } from '@/integrations/supabase/client';

export interface McpToken {
  id: string;
  name: string;
  last_used_at: string | null;
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
  // Base64url for URL-safe transport (used in ?key= query param).
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function listMcpTokens(): Promise<McpToken[]> {
  const { data, error } = await supabase
    .from('mcp_tokens' as never)
    .select('id, name, last_used_at, created_at, revoked_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as unknown as McpToken[];
}

export async function createMcpToken(name: string): Promise<{ token: string; row: McpToken }> {
  const raw = generateRawToken();
  const hash = await sha256Hex(raw);

  const { data, error } = await supabase
    .from('mcp_tokens' as never)
    .insert({ name, token_hash: hash } as never)
    .select('id, name, last_used_at, created_at, revoked_at')
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
