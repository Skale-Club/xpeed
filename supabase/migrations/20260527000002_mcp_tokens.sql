-- Tokens MCP por usuário. Cada usuário gera/revoga seus próprios tokens
-- para consumir o edge function car-insights-mcp. Tokens são armazenados
-- apenas como SHA-256 hash; o valor bruto é mostrado uma única vez ao gerar.

CREATE TABLE IF NOT EXISTS public.mcp_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);

ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mcp_tokens_owner ON public.mcp_tokens;
CREATE POLICY mcp_tokens_owner ON public.mcp_tokens
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS mcp_tokens_hash_idx ON public.mcp_tokens(token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON public.mcp_tokens(user_id);
