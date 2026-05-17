-- Migration: Critical security fixes
-- Phase 03: Critical Security & Bug Fixes
-- Created: 2026-05-17

-- 1. Ensure set_user_id() exists. It was originally created in
--    20260209104400_multi_car_support.sql but the remote DB shows it missing
--    (likely dropped manually or never installed). Defensively recreate it
--    here using CREATE OR REPLACE — idempotent.
CREATE OR REPLACE FUNCTION public.set_user_id()
RETURNS TRIGGER AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Add trigger for chat_conversations to auto-set user_id on INSERT
DROP TRIGGER IF EXISTS set_chat_conversations_user_id ON public.chat_conversations;
CREATE TRIGGER set_chat_conversations_user_id
  BEFORE INSERT ON public.chat_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

-- 2a. Also reattach the triggers that the original migration declared,
--     in case they were dropped too.
DROP TRIGGER IF EXISTS set_car_profiles_user_id ON public.car_profiles;
CREATE TRIGGER set_car_profiles_user_id
  BEFORE INSERT ON public.car_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

DROP TRIGGER IF EXISTS set_sessions_user_id ON public.sessions;
CREATE TRIGGER set_sessions_user_id
  BEFORE INSERT ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

-- 2. Enforce encrypted=true for future gemini_api_key rows
--    NOT VALID: doesn't retroactively check existing plaintext rows
--    (old rows will be re-encrypted on next user save)
ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS chk_gemini_key_encrypted;
ALTER TABLE public.app_settings
  ADD CONSTRAINT chk_gemini_key_encrypted
    CHECK (
      setting_key != 'gemini_api_key'
      OR (encrypted = true)
    ) NOT VALID;

-- 3. Backfill session_start to uploaded_at where NULL
UPDATE public.sessions
SET session_start = uploaded_at
WHERE session_start IS NULL;

-- 4. Make session_start non-null with default
ALTER TABLE public.sessions
  ALTER COLUMN session_start SET DEFAULT now();

-- Note: NOT NULL constraint deferred to after backfill verification
-- Run manually after confirming no NULL values remain:
-- ALTER TABLE public.sessions ALTER COLUMN session_start SET NOT NULL;

-- 5. Index on session_start for date range queries (improves filtered dashboard)
CREATE INDEX IF NOT EXISTS idx_sessions_session_start
  ON public.sessions(car_profile_id, session_start DESC);
