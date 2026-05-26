-- Reassign all data from the orphaned user_id to the current skale.club@gmail.com UUID.
-- The old UUID is discovered dynamically from sessions linked to the 2010 Prius car profile.
DO $$
DECLARE
  v_new_user_id UUID := '3938f132-37b3-484f-afd6-e068eb48ed6d'; -- skale.club@gmail.com
  v_car_id      UUID := 'b271dffd-ac89-440f-8940-62ed9f6d7939'; -- 2010 Prius
  v_old_user_id UUID;
  v_rows        INT;
BEGIN
  -- Find the old orphaned UUID from sessions linked to this car
  SELECT DISTINCT user_id INTO v_old_user_id
  FROM public.sessions
  WHERE car_profile_id = v_car_id
    AND user_id IS DISTINCT FROM v_new_user_id
  LIMIT 1;

  IF v_old_user_id IS NULL THEN
    RAISE NOTICE 'No orphaned sessions found — nothing to migrate.';
    RETURN;
  END IF;

  RAISE NOTICE 'Migrating data from old UUID % to new UUID %', v_old_user_id, v_new_user_id;

  -- sessions
  UPDATE public.sessions SET user_id = v_new_user_id WHERE user_id = v_old_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'sessions updated: %', v_rows;

  -- parameter_baselines
  UPDATE public.parameter_baselines SET car_profile_id = v_car_id
  WHERE car_profile_id IN (
    SELECT id FROM public.car_profiles WHERE user_id = v_old_user_id
  );

  -- shared_reports
  UPDATE public.shared_reports SET user_id = v_new_user_id WHERE user_id = v_old_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'shared_reports updated: %', v_rows;

  -- chat_conversations
  UPDATE public.chat_conversations SET user_id = v_new_user_id WHERE user_id = v_old_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'chat_conversations updated: %', v_rows;

  -- user_quotas
  UPDATE public.user_quotas SET user_id = v_new_user_id WHERE user_id = v_old_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'user_quotas updated: %', v_rows;

  -- maintenance_events
  UPDATE public.maintenance_events SET car_profile_id = v_car_id
  WHERE car_profile_id IN (
    SELECT id FROM public.car_profiles WHERE user_id = v_old_user_id
  );

  -- any remaining orphaned car_profiles from old user
  UPDATE public.car_profiles SET user_id = v_new_user_id
  WHERE user_id = v_old_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'other car_profiles updated: %', v_rows;

  RAISE NOTICE 'Migration complete.';
END $$;
