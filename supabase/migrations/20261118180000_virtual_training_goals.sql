-- Optional training goals. Only the owner-checked RPCs can mutate them; no AI
-- output can create, complete or delete a goal. Source-session deletion erases it.
CREATE TABLE IF NOT EXISTS public.sim_coach_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  source_session_id uuid NOT NULL REFERENCES public.sim_sessions(id) ON DELETE CASCADE,
  game text NOT NULL,
  track_id uuid NOT NULL,
  car_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 1000),
  metric text NOT NULL CHECK (metric IN ('best_lap_ms', 'consistency_ms', 'valid_lap_pct')),
  target numeric NOT NULL CHECK (target >= 0 AND target <= 3600000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((metric = 'best_lap_ms' AND target >= 1000 AND target = trunc(target))
    OR (metric = 'consistency_ms' AND target = trunc(target))
    OR (metric = 'valid_lap_pct' AND target <= 100))
);
CREATE INDEX IF NOT EXISTS sim_coach_goals_context
  ON public.sim_coach_goals(user_id, game, track_id, car_id, created_at DESC);
ALTER TABLE public.sim_coach_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sim_coach_goals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sim_coach_goals TO service_role;

-- Bounded metadata only, recomputed from the surviving owned laps. Invalid,
-- unverified and pit laps do not count as usable. Consistency is sample SD of
-- at least three usable laps within 7% of the best, like session insights.
CREATE OR REPLACE FUNCTION public.sim_coach_measurement(p_user_id uuid, p_session_id uuid, p_metric text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH session AS (
    SELECT s.* FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = p_user_id
  ), inspected AS MATERIALIZED (
    SELECT l.id, l.time_ms, l.valid, l.plausible, l.in_lap, l.out_lap,
      row_number() OVER (ORDER BY l.started_at, l.lap_number, l.id) AS ordinal
    FROM public.sim_laps l JOIN session s ON s.id = l.session_id
    WHERE l.user_id = p_user_id ORDER BY l.started_at, l.lap_number, l.id LIMIT 201
  ), laps AS MATERIALIZED (SELECT * FROM inspected WHERE ordinal <= 200),
  timed AS MATERIALIZED (
    SELECT * FROM laps WHERE time_ms > 0 AND in_lap IS NOT TRUE AND out_lap IS NOT TRUE
  ), usable AS MATERIALIZED (SELECT * FROM timed WHERE valid IS TRUE AND plausible IS TRUE),
  best AS (SELECT min(time_ms) AS ms FROM usable),
  clean AS MATERIALIZED (SELECT u.time_ms FROM usable u, best b WHERE u.time_ms <= b.ms * 1.07),
  counts AS (
    SELECT (SELECT count(*) FROM usable) AS used, (SELECT count(*) FROM clean) AS clean,
      (SELECT count(*) FROM timed) AS timed, (SELECT count(*) FROM laps) AS inspected
  )
  SELECT jsonb_build_object(
    'sessionId', s.id, 'startedAt', s.started_at, 'kind', s.kind,
    'weather', s.weather, 'airTempC', s.air_temp_c, 'trackTempC', s.track_temp_c,
    'value', CASE p_metric
      WHEN 'best_lap_ms' THEN (SELECT ms::numeric FROM best)
      WHEN 'consistency_ms' THEN CASE WHEN c.clean >= 3 THEN (SELECT round(stddev_samp(time_ms)::numeric) FROM clean) END
      WHEN 'valid_lap_pct' THEN CASE WHEN c.timed > 0 THEN round(c.used * 100.0 / c.timed, 1) END END,
    'lapsUsed', c.used, 'cleanLaps', c.clean, 'totalLaps', s.lap_count,
    'partial', (SELECT count(*) FROM inspected) > 200 OR s.lap_count > c.inspected
  ) FROM session s CROSS JOIN counts c
$$;

-- The latest evaluable session, within twenty subsequent sessions of the same
-- game/car/track/kind. Sessions started before goal creation never show progress.
CREATE OR REPLACE FUNCTION public.sim_coach_latest(
  p_user_id uuid, p_game text, p_track_id uuid, p_car_id uuid, p_kind text,
  p_after timestamptz, p_metric text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE candidate record; measurement jsonb;
BEGIN
  FOR candidate IN SELECT s.id FROM public.sim_sessions s
    WHERE s.user_id = p_user_id AND s.game = p_game AND s.track_id = p_track_id
      AND s.car_id = p_car_id AND s.kind = p_kind AND s.started_at > p_after
    ORDER BY s.started_at DESC, s.id DESC LIMIT 20
  LOOP
    measurement := public.sim_coach_measurement(p_user_id, candidate.id, p_metric);
    IF measurement->>'value' IS NOT NULL THEN RETURN measurement; END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- Service-only context for the coach, and a private implementation for the
-- authenticated list RPC. Every session and goal is explicitly owner-scoped.
CREATE OR REPLACE FUNCTION public.sim_coach_context(p_user_id uuid, p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE session public.sim_sessions%ROWTYPE; goal record; baseline jsonb; latest jsonb;
  goals jsonb := '[]'::jsonb; seen integer := 0;
BEGIN
  SELECT * INTO session FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = p_user_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  FOR goal IN SELECT g.*, s.kind AS source_kind FROM public.sim_coach_goals g
    JOIN public.sim_sessions s ON s.id = g.source_session_id AND s.user_id = p_user_id
    WHERE g.user_id = p_user_id AND g.game = session.game AND g.track_id = session.track_id AND g.car_id = session.car_id
    ORDER BY (g.status = 'active') DESC, g.created_at DESC, g.id DESC LIMIT 21
  LOOP
    seen := seen + 1;
    IF seen > 20 THEN EXIT; END IF;
    baseline := public.sim_coach_measurement(p_user_id, goal.source_session_id, goal.metric);
    latest := public.sim_coach_latest(p_user_id, goal.game, goal.track_id, goal.car_id, goal.source_kind,
      greatest(goal.created_at, (baseline->>'startedAt')::timestamptz), goal.metric);
    goals := goals || jsonb_build_array(jsonb_build_object(
      'id', goal.id, 'title', goal.title, 'notes', goal.notes, 'metric', goal.metric,
      'target', goal.target, 'status', goal.status, 'createdAt', goal.created_at,
      'baselineSessionId', goal.source_session_id, 'baseline', baseline, 'latest', latest,
      'reached', CASE WHEN latest IS NULL THEN NULL WHEN goal.metric = 'valid_lap_pct'
        THEN (latest->>'value')::numeric >= goal.target ELSE (latest->>'value')::numeric <= goal.target END,
      'delta', (latest->>'value')::numeric - (baseline->>'value')::numeric
    ));
  END LOOP;
  RETURN jsonb_build_object('goals', goals, 'limit', 20, 'truncated', seen > 20);
END $$;

CREATE OR REPLACE FUNCTION public.sim_coach_goals(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); answer jsonb;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  answer := public.sim_coach_context(owner, p_session_id);
  IF answer IS NULL THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001'; END IF;
  RETURN answer;
END $$;

CREATE OR REPLACE FUNCTION public.sim_coach_goal_create(
  p_session_id uuid, p_title text, p_metric text, p_target numeric, p_notes text DEFAULT ''
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); session public.sim_sessions%ROWTYPE;
  measurement jsonb; goal_id uuid;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  SELECT * INTO session FROM public.sim_sessions s WHERE s.id = p_session_id AND s.user_id = owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'session_not_found' USING ERRCODE = 'P0001'; END IF;
  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 120 OR char_length(coalesce(p_notes, '')) > 1000
    OR p_metric IS NULL OR p_metric NOT IN ('best_lap_ms', 'consistency_ms', 'valid_lap_pct')
    OR p_target IS NULL OR NOT (p_target >= 0 AND p_target <= 3600000)
    OR (p_metric = 'best_lap_ms' AND (p_target < 1000 OR p_target <> trunc(p_target)))
    OR (p_metric = 'consistency_ms' AND p_target <> trunc(p_target))
    OR (p_metric = 'valid_lap_pct' AND p_target > 100)
  THEN RAISE EXCEPTION 'invalid_goal' USING ERRCODE = 'P0001'; END IF;
  measurement := public.sim_coach_measurement(owner, p_session_id, p_metric);
  IF measurement->>'value' IS NULL THEN RAISE EXCEPTION 'insufficient_laps' USING ERRCODE = 'P0001'; END IF;
  -- Serialize this owner's creations so concurrent submissions cannot exceed limits.
  PERFORM pg_advisory_xact_lock(hashtextextended('sim-coach-goals:' || owner::text, 0));
  IF (SELECT count(*) FROM public.sim_coach_goals g WHERE g.user_id = owner) >= 100
    OR (SELECT count(*) FROM public.sim_coach_goals g WHERE g.user_id = owner AND g.game = session.game
      AND g.track_id = session.track_id AND g.car_id = session.car_id) >= 20
  THEN RAISE EXCEPTION 'goal_limit' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO public.sim_coach_goals(user_id, source_session_id, game, track_id, car_id, title, notes, metric, target)
    VALUES (owner, session.id, session.game, session.track_id, session.car_id, btrim(p_title), coalesce(p_notes, ''), p_metric, p_target)
    RETURNING id INTO goal_id;
  RETURN goal_id;
END $$;

CREATE OR REPLACE FUNCTION public.sim_coach_goal_status(p_id uuid, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); changed integer;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'completed', 'archived') THEN
    RAISE EXCEPTION 'invalid_goal' USING ERRCODE = 'P0001'; END IF;
  UPDATE public.sim_coach_goals SET status = p_status WHERE id = p_id AND user_id = owner;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;

CREATE OR REPLACE FUNCTION public.sim_coach_goal_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE owner uuid := public.current_app_user_id(); changed integer;
BEGIN
  IF owner IS NULL THEN RAISE EXCEPTION 'unauthorized' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.sim_coach_goals WHERE id = p_id AND user_id = owner;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;

REVOKE ALL ON FUNCTION public.sim_coach_measurement(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sim_coach_latest(uuid,text,uuid,uuid,text,timestamptz,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sim_coach_context(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_coach_context(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.sim_coach_goals(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sim_coach_goal_create(uuid,text,text,numeric,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sim_coach_goal_status(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sim_coach_goal_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sim_coach_goals(uuid), public.sim_coach_goal_create(uuid,text,text,numeric,text),
  public.sim_coach_goal_status(uuid,text), public.sim_coach_goal_delete(uuid) TO authenticated;
