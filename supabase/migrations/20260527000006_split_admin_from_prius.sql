-- O Prius foi marcado is_admin=true na migration 20260526000003 para promover
-- skale.club a admin. Mas getUserCars() filtra is_admin=true (eles são profiles
-- placeholder, não carros reais), então o Prius sumiu da lista. Resultado:
-- usuário cai no onboarding wizard porque cars.length === 0.
--
-- Fix: criar um Admin Profile placeholder separado, depois desmarcar o Prius.

DO $$
DECLARE
  v_user UUID := '3938f132-37b3-484f-afd6-e068eb48ed6d';
  v_prius UUID := 'b271dffd-ac89-440f-8940-62ed9f6d7939';
BEGIN
  -- 1. Criar admin placeholder se ainda não existir.
  -- set_car_profiles_user_id trigger sobrescreve user_id com auth.uid() (NULL aqui),
  -- então desabilita temporariamente.
  IF NOT EXISTS (
    SELECT 1 FROM public.car_profiles
    WHERE user_id = v_user AND is_admin = true AND id <> v_prius
  ) THEN
    ALTER TABLE public.car_profiles DISABLE TRIGGER set_car_profiles_user_id;
    INSERT INTO public.car_profiles (user_id, name, is_admin)
    VALUES (v_user, 'Admin Profile', true);
    ALTER TABLE public.car_profiles ENABLE TRIGGER set_car_profiles_user_id;
    RAISE NOTICE 'Admin placeholder created for skale.club';
  END IF;

  -- 2. Desmarcar admin do Prius (trigger 20260527000001 bloqueia, desabilita)
  ALTER TABLE public.car_profiles DISABLE TRIGGER car_profiles_lock_is_admin;
  UPDATE public.car_profiles SET is_admin = false WHERE id = v_prius;
  ALTER TABLE public.car_profiles ENABLE TRIGGER car_profiles_lock_is_admin;
  RAISE NOTICE 'Prius is_admin set to false';
END $$;
