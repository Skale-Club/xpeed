-- One-time: grant admin to skale.club@gmail.com (idempotent, trigger-safe).
--
-- Reconciliation note: this migration predates the is_admin UPDATE-lock trigger
-- (car_profiles_lock_is_admin, added 20260527000001). When applied out of order
-- against a DB that already has the lock, a true<-false change would trip the
-- trigger. We briefly disable the lock for this maintenance UPDATE, guarded so
-- it is a no-op if the trigger does not exist yet (fresh replay). If the admin
-- grant already happened via later migrations, the UPDATE is a harmless no-op.
DO $$
BEGIN
  BEGIN
    EXECUTE 'ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin';
  EXCEPTION WHEN undefined_object THEN NULL;
  END;

  UPDATE public.car_profiles
  SET is_admin = true
  WHERE user_id = (
    SELECT id FROM auth.users WHERE email = 'skale.club@gmail.com' LIMIT 1
  );

  BEGIN
    EXECUTE 'ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin';
  EXCEPTION WHEN undefined_object THEN NULL;
  END;
END $$;
