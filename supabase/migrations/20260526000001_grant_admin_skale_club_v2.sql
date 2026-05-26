-- Grant admin to skale.club@gmail.com (v2 — uses DO block to verify)
DO $$
DECLARE
  v_user_id UUID;
  v_rows_updated INT;
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = 'skale.club@gmail.com'
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User skale.club@gmail.com not found in auth.users';
  END IF;

  UPDATE public.car_profiles
  SET is_admin = true
  WHERE user_id = v_user_id;

  GET DIAGNOSTICS v_rows_updated = ROW_COUNT;
  RAISE NOTICE 'Updated % car_profile row(s) for user_id %', v_rows_updated, v_user_id;
END $$;
