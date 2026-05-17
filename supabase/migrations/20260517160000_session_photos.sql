-- Migration: Session photos (dashboard, scanner screens, engine bay)
-- Phase 03+: Improvement C3

CREATE TABLE IF NOT EXISTS public.session_photos (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,
  caption     TEXT,
  photo_type  TEXT CHECK (photo_type IN ('dashboard', 'scanner', 'engine_bay', 'other')),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_session_photos_session
  ON public.session_photos(session_id);

ALTER TABLE public.session_photos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own photos" ON public.session_photos;
CREATE POLICY "Users can view own photos" ON public.session_photos
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own photos" ON public.session_photos;
CREATE POLICY "Users can create own photos" ON public.session_photos
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own photos" ON public.session_photos;
CREATE POLICY "Users can delete own photos" ON public.session_photos
  FOR DELETE USING (auth.uid() = user_id);

DROP TRIGGER IF EXISTS set_session_photos_user_id ON public.session_photos;
CREATE TRIGGER set_session_photos_user_id
  BEFORE INSERT ON public.session_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

-- Storage bucket for photos. Created idempotently; bucket policies must be
-- configured in the Supabase Dashboard or via the storage API since SQL
-- has limited bucket control.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'session-photos',
  'session-photos',
  false,
  10485760,           -- 10 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;

-- Bucket access policy: users can read/write their own folder
DROP POLICY IF EXISTS "session_photos_read_own" ON storage.objects;
CREATE POLICY "session_photos_read_own" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'session-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "session_photos_insert_own" ON storage.objects;
CREATE POLICY "session_photos_insert_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'session-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "session_photos_delete_own" ON storage.objects;
CREATE POLICY "session_photos_delete_own" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'session-photos'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
