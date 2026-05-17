-- Migration: Shared diagnostic reports (public read-only links for mechanics)
-- Phase 03+: Improvement B3

CREATE TABLE IF NOT EXISTS public.shared_reports (
  id           UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at   TIMESTAMP WITH TIME ZONE,
  view_count   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shared_reports_session
  ON public.shared_reports(session_id);

ALTER TABLE public.shared_reports ENABLE ROW LEVEL SECURITY;

-- Owners can manage their share links
DROP POLICY IF EXISTS "Users manage own shared reports" ON public.shared_reports;
CREATE POLICY "Users manage own shared reports" ON public.shared_reports
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Anyone with the UUID can SELECT (the link is the secret).
-- We intentionally allow anon reads so a mechanic without an account can open it.
DROP POLICY IF EXISTS "Anyone with link can read" ON public.shared_reports;
CREATE POLICY "Anyone with link can read" ON public.shared_reports
  FOR SELECT TO anon, authenticated USING (
    expires_at IS NULL OR expires_at > now()
  );

DROP TRIGGER IF EXISTS set_shared_reports_user_id ON public.shared_reports;
CREATE TRIGGER set_shared_reports_user_id
  BEFORE INSERT ON public.shared_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

-- RPC to fetch a shared report payload by ID (anon-safe, includes session + flags)
CREATE OR REPLACE FUNCTION public.get_shared_report(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
  v_result JSON;
BEGIN
  -- Validate link exists and is not expired
  SELECT session_id INTO v_session_id
  FROM public.shared_reports
  WHERE id = p_id AND (expires_at IS NULL OR expires_at > now());

  IF v_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Increment view counter (best-effort, ignore failures)
  UPDATE public.shared_reports SET view_count = view_count + 1 WHERE id = p_id;

  -- Build the payload bypassing RLS (SECURITY DEFINER)
  SELECT json_build_object(
    'session', row_to_json(s),
    'car',     row_to_json(c),
    'flags',   COALESCE((SELECT json_agg(row_to_json(f)) FROM public.session_flags f WHERE f.session_id = s.id), '[]'::json),
    'active_dtcs', s.active_dtcs
  ) INTO v_result
  FROM public.sessions s
  LEFT JOIN public.car_profiles c ON c.id = s.car_profile_id
  WHERE s.id = v_session_id;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_shared_report(UUID) TO anon, authenticated;
