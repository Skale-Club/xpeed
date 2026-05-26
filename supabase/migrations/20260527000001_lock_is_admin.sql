-- Impede que `is_admin` seja modificado via UPDATE em car_profiles.
-- Para promover/rebaixar admins: usar `ALTER TABLE car_profiles DISABLE TRIGGER car_profiles_lock_is_admin`
-- temporariamente no SQL Editor, fazer o UPDATE, e re-habilitar.

CREATE OR REPLACE FUNCTION public.prevent_is_admin_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'is_admin cannot be modified via UPDATE. Disable trigger car_profiles_lock_is_admin to change it.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS car_profiles_lock_is_admin ON public.car_profiles;
CREATE TRIGGER car_profiles_lock_is_admin
  BEFORE UPDATE ON public.car_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_is_admin_change();
