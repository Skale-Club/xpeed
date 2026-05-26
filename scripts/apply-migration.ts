import { createClient } from '@supabase/supabase-js';

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const client = createClient(url, serviceKey, { auth: { persistSession: false } });

const sql = `create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  token_hash text not null,
  token_prefix text not null,
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists idx_mcp_tokens_token_hash on public.mcp_tokens(token_hash);
create index if not exists idx_mcp_tokens_user_id on public.mcp_tokens(user_id);
alter table public.mcp_tokens enable row level security;

create policy if not exists "Users can view own MCP tokens"
  on public.mcp_tokens for select
  using (auth.uid() = user_id);

create policy if not exists "Users can insert own MCP tokens"
  on public.mcp_tokens for insert
  with check (auth.uid() = user_id);

create policy if not exists "Users can update own MCP tokens"
  on public.mcp_tokens for update
  using (auth.uid() = user_id);

create policy if not exists "Users can delete own MCP tokens"
  on public.mcp_tokens for delete
  using (auth.uid() = user_id);`;

async function run() {
  console.log('Applying migration via REST API...');
  
  const response = await fetch(`${url}/rest/v1/rpc/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  console.log('Response status:', response.status);
  const text = await response.text();
  if (response.ok) {
    console.log('Migration applied successfully!');
  } else {
    console.error('Migration failed:', text);
    // Try direct SQL endpoint
    console.log('\nTrying direct approach...');
    const mgmtResponse = await fetch(`https://api.supabase.com/v1/projects/drqmrddxlrlbqnydumjm/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ query: sql }),
    });
    const mgmtText = await mgmtResponse.text();
    console.log('MGMT Response:', mgmtResponse.status, mgmtText);
  }
}

run().catch(console.error);
