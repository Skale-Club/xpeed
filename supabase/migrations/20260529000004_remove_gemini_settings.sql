-- Migrate AI provider off Gemini → OpenRouter. AI config lives in the admin
-- panel (app_settings), not env. Remove the now-unused Gemini setting rows and
-- the dead/NOT VALID constraint that referenced the old key name.
--
-- New keys (created when the admin saves them in /admin):
--   admin_secret_openrouter_api_key  — OpenRouter API key (secret)
--   admin_openrouter_model           — default model id (e.g. openai/gpt-4o-mini)

DELETE FROM public.app_settings
WHERE setting_key IN (
  'admin_secret_gemini_api_key',
  'admin_gemini_model',
  'gemini_model'
);

-- Drop the leftover constraint that only ever targeted the old key name.
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS chk_gemini_key_encrypted;
