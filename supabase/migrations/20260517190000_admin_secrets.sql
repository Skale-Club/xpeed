-- Migration: Admin-managed system secrets (Gemini API key, etc.)
-- Phase 03+: Enables a super-admin UI to configure global secrets that the
-- Edge Functions read at runtime instead of relying on `supabase secrets set`.

-- ---------- is_admin_user() helper ----------
-- Returns true if the current auth.uid() owns any car_profile flagged admin.
CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.car_profiles
    WHERE user_id = auth.uid()
      AND COALESCE(is_admin, false) = true
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated;

-- ---------- app_settings: allow system-wide rows for admins ----------
-- A row with user_id IS NULL is "global" — only admins can manage it,
-- but anyone authenticated can read non-secret keys via select policy below.
-- Secret keys (admin_*) are read-only via the service role in Edge Functions.

-- Drop and recreate RLS policies (keep existing per-user policies untouched
-- if they exist; the new policies ADD admin capabilities for NULL-user rows).

DROP POLICY IF EXISTS "Admins manage system settings" ON public.app_settings;
CREATE POLICY "Admins manage system settings" ON public.app_settings
  FOR ALL
  USING (user_id IS NULL AND public.is_admin_user())
  WITH CHECK (user_id IS NULL AND public.is_admin_user());

-- Allow any authenticated user to read NON-secret system settings
-- (system settings whose key does NOT start with 'admin_secret_').
-- This lets you publish global feature flags without exposing API keys.
DROP POLICY IF EXISTS "Authenticated read public system settings" ON public.app_settings;
CREATE POLICY "Authenticated read public system settings" ON public.app_settings
  FOR SELECT
  USING (
    user_id IS NULL
    AND setting_key NOT LIKE 'admin_secret_%'
  );

-- ---------- Convenience: list of known admin secret keys (for the UI) ----------
COMMENT ON TABLE public.app_settings IS
  'Per-user settings plus system-wide secrets (rows where user_id IS NULL).
Admin secret keys use prefix admin_secret_*  and are readable only by service role
(used by Edge Functions). Non-secret system settings (e.g. feature flags) use
other prefixes and are readable by any authenticated user.';

-- ---------- Seed: placeholder rows for the admin UI to surface ----------
-- These are empty values that the admin UI will show with a "set value" form.
INSERT INTO public.app_settings (setting_key, setting_value, encrypted, user_id)
VALUES
  ('admin_secret_gemini_api_key', NULL, false, NULL),
  ('admin_gemini_model', 'gemini-2.5-flash', false, NULL)
ON CONFLICT DO NOTHING;
