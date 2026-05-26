-- Fix sessions (and related data) that have user_id = NULL,
-- linking them to the current skale.club@gmail.com account.
DO $$
DECLARE
  v_user_id UUID := '3938f132-37b3-484f-afd6-e068eb48ed6d'; -- skale.club@gmail.com
  v_rows    INT;
BEGIN
  -- sessions with NULL user_id that belong to cars owned by this user
  UPDATE public.sessions s
  SET user_id = v_user_id
  FROM public.car_profiles cp
  WHERE s.car_profile_id = cp.id
    AND cp.user_id       = v_user_id
    AND s.user_id        IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'sessions fixed: %', v_rows;

  -- shared_reports
  UPDATE public.shared_reports sr
  SET user_id = v_user_id
  FROM public.sessions s
  WHERE sr.session_id = s.id
    AND s.user_id     = v_user_id
    AND sr.user_id    IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'shared_reports fixed: %', v_rows;

  -- chat_conversations
  UPDATE public.chat_conversations
  SET user_id = v_user_id
  WHERE user_id IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'chat_conversations fixed: %', v_rows;

  -- user_quotas
  UPDATE public.user_quotas
  SET user_id = v_user_id
  WHERE user_id IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'user_quotas fixed: %', v_rows;

  RAISE NOTICE 'Done.';
END $$;
