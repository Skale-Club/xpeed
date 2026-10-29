-- Additive upgrade: preserve issue IDs/history, and publish a reprocessed trip atomically.
-- Apply to staging and verify RLS before production. Never reset the remote database.

ALTER TABLE public.vehicle_issues ADD COLUMN IF NOT EXISTS details jsonb;
ALTER TABLE public.vehicle_issues ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Some live schemas predate the versioned TEXT column and used INTEGER DEFAULT 1.
-- Preserve the old values/default and nullability while accepting composite pipeline versions.
DO $$
DECLARE v_type text; v_default text;
BEGIN
  SELECT data_type, column_default INTO v_type, v_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions' AND column_name = 'processing_version';
  IF v_type IN ('smallint', 'integer', 'bigint') THEN
    ALTER TABLE public.sessions ALTER COLUMN processing_version DROP DEFAULT;
    ALTER TABLE public.sessions ALTER COLUMN processing_version TYPE text USING processing_version::text;
    IF v_default IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.sessions ALTER COLUMN processing_version SET DEFAULT ((%s)::text)', v_default);
    END IF;
  ELSIF v_type IS NULL OR v_type NOT IN ('text', 'character varying') THEN
    RAISE EXCEPTION 'Unexpected processing_version type: %', v_type;
  END IF;
END $$;

-- Legacy permissive policies would otherwise be OR-ed with the current owner checks.
DROP POLICY IF EXISTS users_own_issues ON public.vehicle_issues;
DROP POLICY IF EXISTS users_own_issue_occurrences ON public.vehicle_issue_occurrences;

CREATE OR REPLACE FUNCTION public.reprocess_session(p_session_id uuid, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_resolved jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  -- Ownership is checked explicitly even for admins with SELECT access to other users.
  PERFORM 1 FROM public.sessions
    WHERE id = p_session_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trip not found or not owned'; END IF;

  IF jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'flags') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'summary') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'report') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid processing payload';
  END IF;
  IF jsonb_array_length(p_payload->'rows') > 2000
     OR jsonb_array_length(p_payload->'flags') > 500 THEN
    RAISE EXCEPTION 'Processing payload too large';
  END IF;

  SELECT coalesce(jsonb_object_agg(canonical_key, resolved), '{}'::jsonb) INTO v_resolved
  FROM (SELECT canonical_key, bool_or(coalesce(resolved, false)) AS resolved
        FROM public.session_flags WHERE session_id = p_session_id GROUP BY canonical_key) previous;

  UPDATE public.sessions SET
    summary = (p_payload->'summary') || jsonb_strip_nulls(jsonb_build_object(
      'recording_checksum', summary->'recording_checksum', 'recording_complete', summary->'recording_complete')),
    report = p_payload->'report',
    columns = p_payload->'columns',
    row_count = (p_payload->>'row_count')::integer,
    duration_seconds = (p_payload->>'duration_seconds')::integer,
    active_dtcs = p_payload->'active_dtcs',
    ruleset_id = p_payload->>'ruleset_id',
    ruleset_matched_via = p_payload->>'ruleset_matched_via',
    report_version = (p_payload->>'report_version')::integer,
    processing_version = p_payload->>'processing_version'
  WHERE id = p_session_id;

  DELETE FROM public.session_rows WHERE session_id = p_session_id;
  INSERT INTO public.session_rows (session_id, t_seconds, t_timestamp, data)
  SELECT p_session_id, r.t_seconds, r.t_timestamp, r.data
  FROM jsonb_to_recordset(p_payload->'rows') AS r(t_seconds double precision, t_timestamp timestamptz, data jsonb);

  DELETE FROM public.session_flags WHERE session_id = p_session_id;
  INSERT INTO public.session_flags (session_id, severity, canonical_key, parameter_key, message, evidence, resolved)
  SELECT p_session_id, f.severity, f.canonical_key, f.parameter_key, f.message, f.evidence,
    coalesce((v_resolved->>f.canonical_key)::boolean, false)
  FROM jsonb_to_recordset(p_payload->'flags') AS f(severity text, canonical_key text, parameter_key text, message text, evidence jsonb);
END $$;

REVOKE ALL ON FUNCTION public.reprocess_session(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reprocess_session(uuid, jsonb) TO authenticated;

-- No pending session becomes visible: its original + all derivatives commit together.
CREATE OR REPLACE FUNCTION public.store_recorded_session(
  p_session_id uuid, p_user_id uuid, p_car_id uuid, p_checksum text,
  p_filename text, p_start timestamptz, p_source_path text, p_source_csv text, p_payload jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE v_existing public.sessions%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'Recording owner mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.car_profiles WHERE id = p_car_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Car not owned';
  END IF;
  IF p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$'
     OR (p_source_path IS NULL AND nullif(p_source_csv, '') IS NULL) THEN
    RAISE EXCEPTION 'Recording original/checksum required';
  END IF;
  -- Serializes competing tabs before the first INSERT, including an ambiguous network retry.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_session_id::text, 0));
  SELECT * INTO v_existing FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM auth.uid() OR v_existing.car_profile_id IS DISTINCT FROM p_car_id
       OR v_existing.summary->>'recording_checksum' IS DISTINCT FROM p_checksum
       OR v_existing.summary->>'recording_complete' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Recording conflicts with existing trip';
    END IF;
    RETURN false;
  END IF;
  INSERT INTO public.sessions(id, user_id, car_profile_id, source_filename, session_start, source_file_path, source_csv)
    VALUES(p_session_id, auth.uid(), p_car_id, p_filename, p_start, p_source_path, p_source_csv);
  PERFORM public.reprocess_session(p_session_id, p_payload);
  UPDATE public.sessions SET summary = summary || jsonb_build_object('recording_checksum', p_checksum, 'recording_complete', true)
    WHERE id = p_session_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.store_recorded_session(uuid, uuid, uuid, text, text, timestamptz, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.store_recorded_session(uuid, uuid, uuid, text, text, timestamptz, text, text, jsonb) TO authenticated;
