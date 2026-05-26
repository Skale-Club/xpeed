-- Reconciliar schema da mcp_tokens (criada em tentativa anterior sem UNIQUE
-- e sem DEFAULT auth.uid()), depois seedar o token do skale.club@gmail.com.

-- Adiciona UNIQUE em token_hash se faltar
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_tokens_token_hash_key'
  ) THEN
    ALTER TABLE public.mcp_tokens ADD CONSTRAINT mcp_tokens_token_hash_key UNIQUE (token_hash);
  END IF;
END $$;

-- DEFAULT auth.uid() em user_id (para que o INSERT do client respeite RLS sem precisar passar)
ALTER TABLE public.mcp_tokens ALTER COLUMN user_id SET DEFAULT auth.uid();

-- Seed: token "Claude.ai" para skale.club@gmail.com
-- Raw token foi gerado localmente; só o hash + prefix (display) vão no banco.
INSERT INTO public.mcp_tokens (user_id, token_hash, token_prefix, name)
SELECT
  '3938f132-37b3-484f-afd6-e068eb48ed6d'::uuid,
  '98737376eb8cd11afe3982b7e3a744d029d007be465967b9b8171ccd3ca24fc3',
  'nWQNl_nN',
  'Claude.ai'
WHERE NOT EXISTS (
  SELECT 1 FROM public.mcp_tokens
  WHERE token_hash = '98737376eb8cd11afe3982b7e3a744d029d007be465967b9b8171ccd3ca24fc3'
);
