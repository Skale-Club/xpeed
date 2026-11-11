-- Deleting a trip is meant to leave a mark (session_deletions) so that the phone's saved recording is not uploaded
-- again. The trigger only wrote the mark when the owner existed in auth.users. Since sign-in moved to Google
-- (20261103140000) accounts live in public.app_accounts, and people who signed up that way, or the whole app on
-- the own database where auth.users is empty, never got a mark: a deleted trip could come back from the phone.
-- The owner is now looked up in app_accounts, which every account is in (legacy accounts were copied there).
CREATE OR REPLACE FUNCTION public.remember_session_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.id::text, 0));
  IF OLD.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.app_accounts WHERE id = OLD.user_id)
    AND (OLD.car_profile_id IS NULL OR EXISTS(SELECT 1 FROM public.car_profiles WHERE id = OLD.car_profile_id)) THEN
    INSERT INTO public.session_deletions(recording_id,user_id,car_profile_id)
      VALUES(OLD.id,OLD.user_id,OLD.car_profile_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
