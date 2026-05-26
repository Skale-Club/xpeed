-- Public storage bucket for brand assets uploaded via the super-admin panel.
-- Anyone can read (so favicons / OG images work for logged-out users and
-- crawlers). Only admins can write/update/delete — gated by is_admin on
-- car_profiles, matching the rest of the admin-only surfaces in the app.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'brand-assets',
  'brand-assets',
  true,                                                              -- public read
  2097152,                                                           -- 2 MB per file (raster variants are <100KB each)
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Helper: is the current user an admin?
-- An admin has at least one car_profile flagged is_admin = true.
-- (Existing pattern — see useAdminStatus and admin RLS in earlier migrations.)
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.car_profiles
    WHERE user_id = auth.uid()
      AND is_admin = TRUE
  );
$$;

-- Public read (anonymous browsers, crawlers, PWA manifest fetcher)
DROP POLICY IF EXISTS "brand_assets_read_public" ON storage.objects;
CREATE POLICY "brand_assets_read_public" ON storage.objects
  FOR SELECT USING (bucket_id = 'brand-assets');

-- Admin write
DROP POLICY IF EXISTS "brand_assets_insert_admin" ON storage.objects;
CREATE POLICY "brand_assets_insert_admin" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'brand-assets' AND public.is_current_user_admin()
  );

DROP POLICY IF EXISTS "brand_assets_update_admin" ON storage.objects;
CREATE POLICY "brand_assets_update_admin" ON storage.objects
  FOR UPDATE USING (
    bucket_id = 'brand-assets' AND public.is_current_user_admin()
  );

DROP POLICY IF EXISTS "brand_assets_delete_admin" ON storage.objects;
CREATE POLICY "brand_assets_delete_admin" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'brand-assets' AND public.is_current_user_admin()
  );

-- Make the brand_config setting readable by everyone (not just admins),
-- since the runtime serves the manifest + logos to all users including
-- logged-out visitors. Existing policy only allows reading non-admin_secret_*
-- keys for authenticated users — we need a permissive read for brand_config
-- specifically so anon clients can fetch it via the api/brand/manifest route.

DROP POLICY IF EXISTS "Authenticated read public system settings" ON public.app_settings;
CREATE POLICY "Public read non-secret system settings" ON public.app_settings
  FOR SELECT USING (
    user_id IS NULL
    AND setting_key NOT LIKE 'admin_secret_%'
  );
