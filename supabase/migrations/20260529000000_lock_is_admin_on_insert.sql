-- SECURITY FIX S07-1 (Critical) — close the admin self-promotion hole.
--
-- The original `car_profiles_lock_is_admin` trigger only fired BEFORE UPDATE,
-- so any authenticated user could INSERT a car_profiles row with
-- `is_admin = true` (RLS WITH CHECK only verifies user_id = auth.uid(), never
-- is_admin). That granted them admin SELECT over every user's sessions and
-- write access to global app_settings (including the Gemini API key).
--
-- Fix: on INSERT, force is_admin to FALSE. Promotion remains an explicit,
-- privileged operation: disable this trigger in the SQL editor (or run as a
-- migration), set is_admin, re-enable — same convention as the UPDATE lock.

-- Default the column to false so the intent is explicit at the schema level.
ALTER TABLE public.car_profiles
  ALTER COLUMN is_admin SET DEFAULT false;

CREATE OR REPLACE FUNCTION public.force_is_admin_false_on_insert()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- Never honor a client-supplied is_admin on INSERT.
  NEW.is_admin := false;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS car_profiles_lock_is_admin_insert ON public.car_profiles;
CREATE TRIGGER car_profiles_lock_is_admin_insert
  BEFORE INSERT ON public.car_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.force_is_admin_false_on_insert();

-- Defense in depth: also pin search_path on the existing UPDATE-lock function.
CREATE OR REPLACE FUNCTION public.prevent_is_admin_change()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'is_admin cannot be modified via UPDATE. Disable trigger car_profiles_lock_is_admin to change it.';
  END IF;
  RETURN NEW;
END $$;
