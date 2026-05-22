-- MCP tokens table for long-lived auth tokens used by MCP clients
-- Each user can have multiple active tokens (one per MCP client)

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  token_hash text not null,
  token_prefix text not null, -- first 8 chars for display
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Index for fast token lookup
create index if not exists idx_mcp_tokens_token_hash on public.mcp_tokens(token_hash);
create index if not exists idx_mcp_tokens_user_id on public.mcp_tokens(user_id);

-- Only the owning user can see their tokens
alter table public.mcp_tokens enable row level security;

create policy "Users can view own MCP tokens"
  on public.mcp_tokens for select
  using (auth.uid() = user_id);

create policy "Users can insert own MCP tokens"
  on public.mcp_tokens for insert
  with check (auth.uid() = user_id);

create policy "Users can update own MCP tokens"
  on public.mcp_tokens for update
  using (auth.uid() = user_id);

create policy "Users can delete own MCP tokens"
  on public.mcp_tokens for delete
  using (auth.uid() = user_id);
