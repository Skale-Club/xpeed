-- One-time: grant admin to skale.club@gmail.com
UPDATE public.car_profiles
SET is_admin = true
WHERE user_id = (
  SELECT id FROM auth.users
  WHERE email = 'skale.club@gmail.com'
  LIMIT 1
);
