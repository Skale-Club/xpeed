-- Fix orphaned 2010 Prius profile: reassign to current skale.club@gmail.com account
-- and grant admin. The old user_id no longer exists in auth.users.
DO $$
DECLARE
  v_user_id UUID := '3938f132-37b3-484f-afd6-e068eb48ed6d'; -- skale.club@gmail.com
  v_car_id  UUID := 'b271dffd-ac89-440f-8940-62ed9f6d7939'; -- 2010 Prius
  v_rows    INT;
BEGIN
  UPDATE public.car_profiles
  SET user_id  = v_user_id,
      is_admin = true
  WHERE id = v_car_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'Updated % row(s): 2010 Prius now owned by skale.club@gmail.com with is_admin=true', v_rows;
END $$;
