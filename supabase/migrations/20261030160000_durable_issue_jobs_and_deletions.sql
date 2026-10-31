-- Derivative alerts must survive a closed app or an ambiguous network response.
CREATE TABLE public.session_issue_jobs (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  car_profile_id uuid NOT NULL REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  version uuid NOT NULL DEFAULT gen_random_uuid(),
  reprocessing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  retry_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.session_issue_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_issue_jobs ON public.session_issue_jobs FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY acknowledge_own_issue_jobs ON public.session_issue_jobs FOR DELETE TO authenticated USING (user_id = auth.uid());
REVOKE ALL ON public.session_issue_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE, UPDATE(retry_at) ON public.session_issue_jobs TO authenticated;
CREATE POLICY postpone_own_issue_jobs ON public.session_issue_jobs FOR UPDATE TO authenticated USING(user_id=auth.uid()) WITH CHECK(user_id=auth.uid());
CREATE INDEX session_issue_jobs_pending ON public.session_issue_jobs(user_id,retry_at,created_at);

CREATE FUNCTION public.queue_session_issues() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.car_profile_id IS NOT NULL AND NEW.processing_version IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.processing_version IS DISTINCT FROM NEW.processing_version
      OR OLD.summary->'summaries' IS DISTINCT FROM NEW.summary->'summaries'
      OR OLD.summary->'faultCodes' IS DISTINCT FROM NEW.summary->'faultCodes'
      OR OLD.active_dtcs IS DISTINCT FROM NEW.active_dtcs
      OR OLD.gemini_analysis IS DISTINCT FROM NEW.gemini_analysis) THEN
    INSERT INTO public.session_issue_jobs(session_id,user_id,car_profile_id,reprocessing)
      VALUES(NEW.id,NEW.user_id,NEW.car_profile_id,TG_OP = 'UPDATE' AND OLD.processing_version IS NOT NULL)
    ON CONFLICT(session_id) DO UPDATE SET version = gen_random_uuid(), reprocessing = EXCLUDED.reprocessing, retry_at = now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.queue_session_issues() FROM PUBLIC;
CREATE TRIGGER queue_session_issues AFTER INSERT OR UPDATE OF summary, active_dtcs, processing_version, gemini_analysis ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.queue_session_issues();
-- Existing trips are repaired without reopening problems already dismissed by the owner.
INSERT INTO public.session_issue_jobs(session_id,user_id,car_profile_id,reprocessing)
  SELECT id,user_id,car_profile_id,true FROM public.sessions
  WHERE user_id IS NOT NULL AND car_profile_id IS NOT NULL AND processing_version IS NOT NULL;

-- A deleted recording is an intentional decision, not a missing upload to recover.
CREATE TABLE public.session_deletions (
  recording_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  car_profile_id uuid REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.session_deletions ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_session_deletions ON public.session_deletions FOR SELECT TO authenticated USING(user_id = auth.uid());
REVOKE ALL ON public.session_deletions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.session_deletions TO authenticated;
CREATE FUNCTION public.remember_session_deletion() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(OLD.id::text, 0));
  IF OLD.user_id IS NOT NULL AND EXISTS(SELECT 1 FROM auth.users WHERE id = OLD.user_id)
    AND (OLD.car_profile_id IS NULL OR EXISTS(SELECT 1 FROM public.car_profiles WHERE id = OLD.car_profile_id)) THEN
    INSERT INTO public.session_deletions(recording_id,user_id,car_profile_id)
      VALUES(OLD.id,OLD.user_id,OLD.car_profile_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
CREATE FUNCTION public.reject_deleted_recording() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.id::text, 0));
  IF EXISTS(SELECT 1 FROM public.session_deletions WHERE recording_id = NEW.id) THEN
    RAISE EXCEPTION 'Recording intentionally deleted';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.remember_session_deletion(), public.reject_deleted_recording() FROM PUBLIC;
CREATE TRIGGER remember_session_deletion BEFORE DELETE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.remember_session_deletion();
CREATE TRIGGER reject_deleted_recording BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_recording();

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
  SELECT session_id INTO v_session_id
  FROM public.shared_reports
  WHERE id = p_id AND (expires_at IS NULL OR expires_at > now());

  IF v_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.shared_reports SET view_count = view_count + 1 WHERE id = p_id;

  SELECT json_build_object(
    'session', json_build_object(
      'source_filename', s.source_filename,
      'session_start',   s.session_start,
      'uploaded_at',     s.uploaded_at,
      'duration_seconds', s.duration_seconds,
      'summary', json_build_object('faultCodes', s.summary->'faultCodes')
    ),
    'car', CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object(
      'name',  c.name,
      'year',  c.year,
      'make',  c.make,
      'model', c.model,
      'trim',  c.trim,
      'vin',   c.vin
    ) END,
    'flags', COALESCE((
      SELECT json_agg(json_build_object(
        'severity',      f.severity,
        'canonical_key', f.canonical_key,
        'parameter_key', f.parameter_key,
        'message',       f.message,
        'evidence',      jsonb_strip_nulls(jsonb_build_object(
                           'max', f.evidence -> 'max',
                           'avg', f.evidence -> 'avg',
                           'min', f.evidence -> 'min'))
      ))
      FROM public.session_flags f WHERE f.session_id = s.id
    ), '[]'::json),
    'active_dtcs', COALESCE(s.active_dtcs, '[]'::jsonb)
  ) INTO v_result
  FROM public.sessions s
  LEFT JOIN public.car_profiles c ON c.id = s.car_profile_id
  WHERE s.id = v_session_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_shared_report(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_report(UUID) TO anon, authenticated;

-- List pages and calendar counts are computed in the database, with the caller's RLS.
CREATE FUNCTION public.trip_page(p_car uuid, p_page integer DEFAULT 1, p_size integer DEFAULT 20, p_day text DEFAULT NULL, p_zone text DEFAULT 'UTC') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF p_page < 1 OR p_size < 1 OR p_size > 100 OR (p_day IS NOT NULL AND p_day !~ '^\d{4}-\d{2}-\d{2}$') THEN RAISE EXCEPTION 'Invalid page'; END IF;
  WITH matching AS (
    SELECT s.* FROM public.sessions s WHERE s.car_profile_id = p_car
      AND (p_day IS NULL OR (COALESCE(s.session_start,s.uploaded_at) AT TIME ZONE p_zone)::date = p_day::date)
  ), page AS (
    SELECT * FROM matching ORDER BY COALESCE(session_start,uploaded_at) DESC,id DESC LIMIT p_size OFFSET (p_page::bigint-1)*p_size
  ) SELECT jsonb_build_object('total',(SELECT count(*) FROM matching),'items',COALESCE((SELECT jsonb_agg(to_jsonb(page)-'source_csv'-'gemini_analysis'-'analysis_report' ORDER BY COALESCE(session_start,uploaded_at) DESC,id DESC) FROM page),'[]'::jsonb)) INTO result;
  RETURN result;
END $$;
CREATE FUNCTION public.trip_calendar(p_car uuid, p_month text, p_zone text DEFAULT 'UTC') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE result jsonb;
BEGIN
  IF p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Invalid month'; END IF;
  SELECT COALESCE(jsonb_object_agg(day,total),'{}'::jsonb) INTO result FROM (
    SELECT to_char(COALESCE(session_start,uploaded_at) AT TIME ZONE p_zone,'YYYY-MM-DD') AS day,count(*) AS total
    FROM public.sessions WHERE car_profile_id=p_car AND to_char(COALESCE(session_start,uploaded_at) AT TIME ZONE p_zone,'YYYY-MM')=p_month GROUP BY 1
  ) counts;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.trip_page(uuid,integer,integer,text,text), public.trip_calendar(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trip_page(uuid,integer,integer,text,text), public.trip_calendar(uuid,text,text) TO authenticated;
CREATE INDEX IF NOT EXISTS sessions_car_trip_date ON public.sessions(car_profile_id,(COALESCE(session_start,uploaded_at)) DESC,id DESC);

CREATE FUNCTION public.refresh_session_analysis_marker() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.gemini_analysis IS DISTINCT FROM OLD.gemini_analysis THEN
    NEW.summary = COALESCE(NEW.summary,'{}'::jsonb) - 'analysis_outdated';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.refresh_session_analysis_marker() FROM PUBLIC;
CREATE TRIGGER refresh_session_analysis_marker BEFORE UPDATE OF gemini_analysis ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.refresh_session_analysis_marker();
