-- Diagnostic: list all car_profiles with their user_id and is_admin
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT cp.id, cp.name, cp.user_id, cp.is_admin, u.email
    FROM public.car_profiles cp
    LEFT JOIN auth.users u ON u.id = cp.user_id
    ORDER BY cp.created_at
  LOOP
    RAISE NOTICE 'id=% | name=% | email=% | is_admin=%', r.id, r.name, r.email, r.is_admin;
  END LOOP;
END $$;
