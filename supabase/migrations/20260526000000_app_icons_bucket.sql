-- Migration: Public storage bucket for app-wide icons
-- Admin uploads a single icon; the system generates 192/512/180 sizes automatically.
-- All authenticated (and anon) users can read; only admins can write.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'app-icons',
  'app-icons',
  true,
  2097152,   -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "app_icons_public_read" ON storage.objects;
CREATE POLICY "app_icons_public_read" ON storage.objects
  FOR SELECT USING (bucket_id = 'app-icons');

DROP POLICY IF EXISTS "app_icons_admin_insert" ON storage.objects;
CREATE POLICY "app_icons_admin_insert" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'app-icons' AND public.is_admin_user());

DROP POLICY IF EXISTS "app_icons_admin_update" ON storage.objects;
CREATE POLICY "app_icons_admin_update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'app-icons' AND public.is_admin_user());

DROP POLICY IF EXISTS "app_icons_admin_delete" ON storage.objects;
CREATE POLICY "app_icons_admin_delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'app-icons' AND public.is_admin_user());

-- Seed the setting row so the admin UI can surface it immediately
INSERT INTO public.app_settings (setting_key, setting_value, encrypted, user_id)
VALUES ('admin_app_icon_url', NULL, false, NULL)
ON CONFLICT DO NOTHING;
