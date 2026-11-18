-- Personal OpenRouter keys are encrypted with a server-held AES-GCM key.
-- No browser/database role may read or write even the ciphertext directly.
CREATE TABLE IF NOT EXISTS public.user_ai_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'global' CHECK (mode IN ('global', 'personal')),
  api_key_ciphertext text CHECK (char_length(api_key_ciphertext) <= 2048),
  api_key_iv text CHECK (char_length(api_key_iv) = 16),
  key_last4 text CHECK (char_length(key_last4) = 4),
  model text CHECK (char_length(model) BETWEEN 2 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((api_key_ciphertext IS NULL AND api_key_iv IS NULL AND key_last4 IS NULL)
      OR (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND key_last4 IS NOT NULL)),
  CHECK (mode <> 'personal' OR (api_key_ciphertext IS NOT NULL AND model IS NOT NULL))
);
ALTER TABLE public.user_ai_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_ai_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_ai_preferences TO service_role;
