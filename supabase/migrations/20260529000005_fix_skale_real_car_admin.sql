-- HOTFIX: the orphaned grant-admin migration (re-applied as 20260529000002 during
-- drift reconciliation) ran `UPDATE car_profiles SET is_admin=true` for ALL of
-- skale.club's rows — including the real car (Prius). getUserCars() hides
-- is_admin=true rows (they're admin placeholders, not cars), so the real car
-- vanished from the list and the dashboard bounced the user into onboarding.
--
-- Correct model (from 20260527000006): admin authority lives on a dedicated
-- "Admin Profile" placeholder row; real cars must have is_admin=false.
-- This migration restores that: ensure the placeholder exists, then clear
-- is_admin on every other row for the user. Admin status is preserved via the
-- placeholder.

DO $$
DECLARE
  v_user UUID;
BEGIN
  SELECT id INTO v_user FROM auth.users WHERE email = 'skale.club@gmail.com' LIMIT 1;
  IF v_user IS NULL THEN
    RAISE NOTICE 'skale.club user not found — skipping';
    RETURN;
  END IF;

  -- 1. Ensure a dedicated admin placeholder exists (so step 2 can't strip all admin).
  IF NOT EXISTS (
    SELECT 1 FROM public.car_profiles
    WHERE user_id = v_user AND is_admin = true AND name = 'Admin Profile'
  ) THEN
    ALTER TABLE public.car_profiles DISABLE TRIGGER set_car_profiles_user_id;
    ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin_insert;
    INSERT INTO public.car_profiles (user_id, name, is_admin)
    VALUES (v_user, 'Admin Profile', true);
    ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin_insert;
    ALTER TABLE public.car_profiles ENABLE TRIGGER set_car_profiles_user_id;
    RAISE NOTICE 'Admin placeholder created for skale.club';
  END IF;

  -- 2. Real cars must NOT be admin (otherwise getUserCars hides them).
  ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin;
  UPDATE public.car_profiles
    SET is_admin = false
    WHERE user_id = v_user AND name <> 'Admin Profile';
  ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin;
  RAISE NOTICE 'Cleared is_admin on real cars for skale.club';
END $$;
