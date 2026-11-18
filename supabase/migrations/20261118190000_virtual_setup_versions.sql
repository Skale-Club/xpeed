-- Private, driver-entered setup snapshots. Versions are immutable through the
-- public API. Deleting a session keeps the library; erasing the Virtual profile
-- (all racing data) or account cascades to versions and their associations.
CREATE TABLE IF NOT EXISTS public.sim_setup_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.sim_profiles(user_id) ON DELETE CASCADE,
  game text NOT NULL,
  track_id uuid NOT NULL,
  car_id uuid NOT NULL,
  parent_id uuid REFERENCES public.sim_setup_versions(id) ON DELETE SET NULL,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'array' AND jsonb_array_length(parameters) BETWEEN 1 AND 32
    AND octet_length(parameters::text) <= 16384),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sim_setup_versions_context ON public.sim_setup_versions(user_id, game, track_id, car_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.sim_session_setups (
  session_id uuid PRIMARY KEY REFERENCES public.sim_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.sim_profiles(user_id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.sim_setup_versions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sim_session_setups_version ON public.sim_session_setups(version_id, user_id);
ALTER TABLE public.sim_setup_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_session_setups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sim_setup_versions, public.sim_session_setups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sim_setup_versions, public.sim_session_setups TO service_role;

CREATE OR REPLACE FUNCTION public.sim_setup_json(p_user_id uuid, p_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', v.id, 'label', v.label, 'notes', v.notes, 'parameters', v.parameters,
    'parentId', v.parent_id, 'createdAt', v.created_at,
    'runs', coalesce((SELECT jsonb_agg(public.sim_coach_measurement(p_user_id, r.id, 'best_lap_ms') ORDER BY r.started_at DESC, r.id DESC)
      FROM (SELECT s.id, s.started_at FROM public.sim_session_setups a
        JOIN public.sim_sessions s ON s.id = a.session_id AND s.user_id = p_user_id
        WHERE a.user_id = p_user_id AND a.version_id = v.id
        ORDER BY s.started_at DESC, s.id DESC LIMIT 3) r), '[]'::jsonb))
  FROM public.sim_setup_versions v WHERE v.id = p_id AND v.user_id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.sim_setup_context(p_user_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('version', public.sim_setup_json(p_user_id, a.version_id),
    'parent', public.sim_setup_json(p_user_id, v.parent_id))
  FROM public.sim_sessions s
  LEFT JOIN public.sim_session_setups a ON a.session_id = s.id AND a.user_id = p_user_id
  LEFT JOIN public.sim_setup_versions v ON v.id = a.version_id AND v.user_id = p_user_id
  WHERE s.id = p_session_id AND s.user_id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.sim_setup_versions(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); session public.sim_sessions%ROWTYPE; versions jsonb;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO session FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001'; END IF;
  SELECT coalesce(jsonb_agg(public.sim_setup_json(owner, v.id) ORDER BY v.created_at DESC, v.id DESC), '[]'::jsonb)
    INTO versions FROM public.sim_setup_versions v
    WHERE v.user_id = owner AND v.game = session.game AND v.track_id = session.track_id AND v.car_id = session.car_id;
  RETURN jsonb_build_object('versions', versions, 'limit', 20,
    'selectedVersionId', (SELECT a.version_id FROM public.sim_session_setups a WHERE a.session_id = session.id AND a.user_id = owner));
END $$;

CREATE OR REPLACE FUNCTION public.sim_setup_create(
  p_session_id uuid, p_label text, p_notes text, p_parameters jsonb, p_parent_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); session public.sim_sessions%ROWTYPE;
  parameter jsonb; normalized jsonb := '[]'::jsonb; names text[] := '{}'; name text; value text; unit text; version_id uuid;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  -- Serialize with full racing-data erasure before reading the baseline/profile.
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || owner::text, 0));
  SELECT * INTO session FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 1 AND 120 OR p_label ~ '[\x01-\x1f\x7f-\x9f]'
    OR char_length(coalesce(p_notes, '')) > 1000
    OR jsonb_typeof(p_parameters) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
  IF jsonb_array_length(p_parameters) NOT BETWEEN 1 AND 32 OR octet_length(p_parameters::text) > 16384 THEN
    RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
  FOR parameter IN SELECT * FROM jsonb_array_elements(p_parameters) LOOP
    IF jsonb_typeof(parameter) IS DISTINCT FROM 'object'
      OR jsonb_typeof(parameter->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(parameter->'value') IS DISTINCT FROM 'string'
      OR jsonb_typeof(parameter->'unit') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
    name := btrim(parameter->>'name'); value := btrim(parameter->>'value'); unit := btrim(parameter->>'unit');
    IF char_length(name) NOT BETWEEN 1 AND 60 OR char_length(value) NOT BETWEEN 1 AND 80 OR char_length(unit) > 20
      OR (name || value || unit) ~ '[\x01-\x1f\x7f-\x9f]' OR lower(name) = ANY(names) THEN
      RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
    names := array_append(names, lower(name));
    normalized := normalized || jsonb_build_array(jsonb_build_object('name', name, 'value', value, 'unit', unit));
  END LOOP;
  IF p_parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.sim_setup_versions v WHERE v.id = p_parent_id AND v.user_id = owner
      AND v.game = session.game AND v.track_id = session.track_id AND v.car_id = session.car_id
  ) THEN RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM public.sim_setup_versions v WHERE v.user_id = owner) >= 100
    OR (SELECT count(*) FROM public.sim_setup_versions v WHERE v.user_id = owner AND v.game = session.game
      AND v.track_id = session.track_id AND v.car_id = session.car_id) >= 20 THEN
    RAISE EXCEPTION 'setup_limit' USING ERRCODE = 'P0001'; END IF;
  PERFORM public.sim_ensure_profile(owner);
  INSERT INTO public.sim_setup_versions(user_id, game, track_id, car_id, parent_id, label, notes, parameters)
    VALUES(owner, session.game, session.track_id, session.car_id, p_parent_id, btrim(p_label), coalesce(p_notes, ''), normalized)
    RETURNING id INTO version_id;
  RETURN version_id;
END $$;

CREATE OR REPLACE FUNCTION public.sim_setup_attach(p_session_id uuid, p_version_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); session public.sim_sessions%ROWTYPE;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || owner::text, 0));
  SELECT * INTO session FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_version_id IS NULL THEN
    DELETE FROM public.sim_session_setups WHERE session_id = p_session_id AND user_id = owner;
    RETURN true;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sim_setup_versions v WHERE v.id = p_version_id AND v.user_id = owner
    AND v.game = session.game AND v.track_id = session.track_id AND v.car_id = session.car_id)
  THEN RAISE EXCEPTION 'invalid_setup' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.sim_session_setups(session_id, user_id, version_id) VALUES(p_session_id, owner, p_version_id)
    ON CONFLICT (session_id) DO UPDATE SET version_id = EXCLUDED.version_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.sim_setup_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); changed integer;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.sim_setup_versions WHERE id = p_id AND user_id = owner;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;

REVOKE ALL ON FUNCTION public.sim_setup_json(uuid,uuid), public.sim_setup_context(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_setup_context(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.sim_setup_versions(uuid), public.sim_setup_create(uuid,text,text,jsonb,uuid),
  public.sim_setup_attach(uuid,uuid), public.sim_setup_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sim_setup_versions(uuid), public.sim_setup_create(uuid,text,text,jsonb,uuid),
  public.sim_setup_attach(uuid,uuid), public.sim_setup_delete(uuid) TO authenticated;
