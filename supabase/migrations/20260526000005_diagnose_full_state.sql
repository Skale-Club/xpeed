-- Full diagnostic: sessions, user_id cross-check
DO $$
DECLARE
  r RECORD;
  v_new UUID := '3938f132-37b3-484f-afd6-e068eb48ed6d';
  v_car UUID := 'b271dffd-ac89-440f-8940-62ed9f6d7939';
BEGIN
  RAISE NOTICE '=== SESSIONS for Prius ===';
  FOR r IN
    SELECT s.id, s.source_filename, s.user_id,
           (s.user_id = v_new) AS is_current_user,
           u.email
    FROM public.sessions s
    LEFT JOIN auth.users u ON u.id = s.user_id
    WHERE s.car_profile_id = v_car
    ORDER BY s.uploaded_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE 'session=% | file=% | user_email=% | is_current=%',
      r.id, r.source_filename, r.email, r.is_current_user;
  END LOOP;

  RAISE NOTICE '=== ALL DISTINCT user_ids in sessions ===';
  FOR r IN
    SELECT DISTINCT s.user_id, u.email, COUNT(*) AS cnt
    FROM public.sessions s
    LEFT JOIN auth.users u ON u.id = s.user_id
    GROUP BY s.user_id, u.email
  LOOP
    RAISE NOTICE 'user_id=% | email=% | sessions=%', r.user_id, r.email, r.cnt;
  END LOOP;

  RAISE NOTICE '=== car_profiles current state ===';
  FOR r IN
    SELECT cp.id, cp.name, cp.user_id, cp.is_admin, u.email
    FROM public.car_profiles cp
    LEFT JOIN auth.users u ON u.id = cp.user_id
  LOOP
    RAISE NOTICE 'car=% | user_email=% | is_admin=%', r.name, r.email, r.is_admin;
  END LOOP;
END $$;
