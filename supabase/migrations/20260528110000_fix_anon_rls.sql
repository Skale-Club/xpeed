-- Fix: RLS policies that call is_admin_user() / is_current_user_admin() fail for
-- anon users because both functions lost EXECUTE for anon in the security hardening
-- migration (20260528100000). The functions are SECURITY DEFINER and always return
-- false for anon (auth.uid() IS NULL), so granting anon EXECUTE is safe.

-- Re-grant anon EXECUTE so RLS policy expressions can evaluate them
GRANT EXECUTE ON FUNCTION public.is_admin_user()         TO anon;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO anon;

-- Fix "Admins manage system settings": change FROM ALL TO write-only (INSERT/UPDATE/DELETE).
-- Reading global non-secret settings is already handled by "Public read non-secret system
-- settings" which covers anon too. Keeping FOR ALL on this policy caused anon SELECT on
-- app_settings to fail (is_admin_user() was being evaluated for every SELECT row).
DROP POLICY IF EXISTS "Admins manage system settings" ON public.app_settings;

CREATE POLICY "Admins manage system settings" ON public.app_settings
  FOR INSERT
  WITH CHECK (user_id IS NULL AND public.is_admin_user());

CREATE POLICY "Admins update system settings" ON public.app_settings
  FOR UPDATE
  USING (user_id IS NULL AND public.is_admin_user())
  WITH CHECK (user_id IS NULL AND public.is_admin_user());

CREATE POLICY "Admins delete system settings" ON public.app_settings
  FOR DELETE
  USING (user_id IS NULL AND public.is_admin_user());
