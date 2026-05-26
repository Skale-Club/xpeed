-- Diagnóstico: o user skale.club@gmail.com loga e não vê os dados antigos.
-- Verifica: quantas contas existem com esse email, qual user_id está nos dados,
-- e se eles batem.
DO $$
DECLARE
  r RECORD;
BEGIN
  RAISE NOTICE '=== auth.users com email skale.club ===';
  FOR r IN
    SELECT id, email, created_at, last_sign_in_at, raw_app_meta_data->>'provider' AS provider
    FROM auth.users
    WHERE email ILIKE '%skale%'
    ORDER BY created_at
  LOOP
    RAISE NOTICE 'id=% | email=% | created=% | last_sign_in=% | provider=%',
      r.id, r.email, r.created_at, r.last_sign_in_at, r.provider;
  END LOOP;

  RAISE NOTICE '=== car_profiles ===';
  FOR r IN
    SELECT cp.id, cp.name, cp.user_id, cp.is_admin, u.email
    FROM public.car_profiles cp
    LEFT JOIN auth.users u ON u.id = cp.user_id
    ORDER BY cp.created_at
  LOOP
    RAISE NOTICE 'car=% | user_id=% | email=% | is_admin=%',
      r.name, r.user_id, COALESCE(r.email, '<orphaned>'), r.is_admin;
  END LOOP;

  RAISE NOTICE '=== sessions count por user ===';
  FOR r IN
    SELECT s.user_id, u.email, COUNT(*) AS cnt
    FROM public.sessions s
    LEFT JOIN auth.users u ON u.id = s.user_id
    GROUP BY s.user_id, u.email
  LOOP
    RAISE NOTICE 'user_id=% | email=% | sessions=%',
      r.user_id, COALESCE(r.email, '<orphaned>'), r.cnt;
  END LOOP;

  RAISE NOTICE '=== último login por conta ===';
  FOR r IN
    SELECT id, email, last_sign_in_at, created_at
    FROM auth.users
    WHERE email ILIKE '%skale%'
    ORDER BY last_sign_in_at DESC NULLS LAST
  LOOP
    RAISE NOTICE 'CURRENT-LOGIN: id=% | email=% | last_sign_in=%',
      r.id, r.email, r.last_sign_in_at;
  END LOOP;
END $$;
