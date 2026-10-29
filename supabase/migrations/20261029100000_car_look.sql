-- How each car is drawn in the app: its body shape and paint colour (a generic
-- silhouette), or the owner's own photo of it. Idempotent.

ALTER TABLE public.car_profiles ADD COLUMN IF NOT EXISTS body_type TEXT;
ALTER TABLE public.car_profiles ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE public.car_profiles ADD COLUMN IF NOT EXISTS photo_path TEXT;

ALTER TABLE public.car_profiles DROP CONSTRAINT IF EXISTS car_profiles_body_type_check;
ALTER TABLE public.car_profiles ADD CONSTRAINT car_profiles_body_type_check
  CHECK (body_type IS NULL OR body_type IN ('hatch', 'sedan', 'suv', 'pickup', 'wagon', 'minivan', 'coupe'));

ALTER TABLE public.car_profiles DROP CONSTRAINT IF EXISTS car_profiles_color_check;
ALTER TABLE public.car_profiles ADD CONSTRAINT car_profiles_color_check
  CHECK (color IS NULL OR color IN ('white', 'silver', 'gray', 'black', 'red', 'wine', 'blue', 'navy', 'green', 'beige', 'brown', 'yellow', 'orange'));

-- The owner's photo: a private bucket, files under <user id>/<car id>.<ext>.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('car-photos', 'car-photos', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS car_photos_select_own ON storage.objects;
DROP POLICY IF EXISTS car_photos_insert_own ON storage.objects;
DROP POLICY IF EXISTS car_photos_update_own ON storage.objects;
DROP POLICY IF EXISTS car_photos_delete_own ON storage.objects;

CREATE POLICY car_photos_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'car-photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE POLICY car_photos_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'car-photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE POLICY car_photos_update_own ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'car-photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'car-photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

CREATE POLICY car_photos_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'car-photos' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
