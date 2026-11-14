-- The Overview dashboard (docs/platform/API-V1.md, GET /api/sim/v1/stats): what a person drove in a period, against the period before
-- it, worked out in one statement from sim_laps, sim_sessions and the catalogs. No lap file is read.
-- Additive and idempotent: two new functions (CREATE OR REPLACE) and one new index (IF NOT EXISTS). Nothing existing changes.
-- Days are UTC dates, as everywhere in API v1. Hidden laps are counted, as in the person's own laps, sessions and bests.

-- Serves the "laps in a window" read and the running-best window below: the person's valid laps of one track and car in time order.
CREATE INDEX IF NOT EXISTS sim_laps_user_pair_time ON public.sim_laps(user_id, track_id, car_id, started_at, id)
  WHERE valid AND time_ms > 0;

-- ---------------------------------------------------------------- personal-best improvements

-- Every valid lap that beat the best the person had on that track and car before it (the first valid lap on a pair counts, with
-- prev_ms NULL). "Before" is the order of started_at, then id, over the whole history, so a period is judged against what came
-- earlier, not against itself. Laps that are not valid, have no time or no linked track and car never count.
CREATE OR REPLACE FUNCTION public.sim_stats_improvements(p_user uuid)
RETURNS TABLE(lap_id uuid, track_id uuid, car_id uuid, time_ms integer, prev_ms integer, started_at timestamptz)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT x.id, x.track_id, x.car_id, x.time_ms, x.prev_ms, x.started_at
  FROM (
    SELECT l.id, l.track_id, l.car_id, l.time_ms, l.started_at,
      min(l.time_ms) OVER (PARTITION BY l.track_id, l.car_id ORDER BY l.started_at, l.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_ms
    FROM public.sim_laps l
    WHERE l.user_id = p_user AND l.valid AND l.time_ms > 0 AND l.track_id IS NOT NULL AND l.car_id IS NOT NULL
  ) x
  WHERE x.prev_ms IS NULL OR x.time_ms < x.prev_ms
$$;

-- ---------------------------------------------------------------- the dashboard

-- p_from / p_to: the period, [p_from, p_to) (p_to is the start of tomorrow, UTC); p_from NULL means from the person's first lap.
-- p_prev_from: the start of the period before it, of the same length, up to p_from (NULL: no previous period, the totals are zeros).
-- p_heat_from: the start of the calendar heatmap window (NULL: no heatmap). A lap belongs to a day by started_at in UTC.
CREATE OR REPLACE FUNCTION public.sim_v1_stats(p_from timestamptz, p_to timestamptz, p_prev_from timestamptz DEFAULT NULL, p_heat_from timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  v_user uuid := public.current_app_user_id();
  v_from timestamptz := p_from;
  v_today date := ((p_to - interval '1 second') AT TIME ZONE 'UTC')::date;
  v_zero jsonb := jsonb_build_object('laps', 0, 'validLaps', 0, 'sessions', 0, 'timeMs', 0, 'distanceM', 0, 'tracks', 0, 'cars', 0, 'games', 0);
  v_result jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF v_from IS NULL THEN
    SELECT (date_trunc('day', min(l.started_at) AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC' INTO v_from FROM public.sim_laps l WHERE l.user_id = v_user AND l.started_at < p_to;
    v_from := coalesce(v_from, p_to - interval '1 day');
  END IF;

  WITH base AS MATERIALIZED (
    SELECT l.id, l.started_at, (l.started_at AT TIME ZONE 'UTC')::date AS d, l.session_id, l.track_id, l.car_id, l.game, l.time_ms,
           (l.valid AND l.time_ms > 0) AS ok, l.in_lap, l.out_lap, t.length_m, t.name AS track_name, c.name AS car_name,
           CASE WHEN l.started_at >= v_from THEN 'cur' WHEN p_prev_from IS NOT NULL AND l.started_at >= p_prev_from THEN 'prev' ELSE 'heat' END AS win
    FROM public.sim_laps l
    LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id
    LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
    WHERE l.user_id = v_user AND l.started_at < p_to
      AND l.started_at >= least(v_from, coalesce(p_prev_from, v_from), coalesce(p_heat_from, v_from))
  ), imp AS MATERIALIZED (
    SELECT i.lap_id, i.track_id, i.car_id, i.time_ms, i.prev_ms, i.started_at, (i.started_at AT TIME ZONE 'UTC')::date AS d, t.game, t.name AS track_name, c.name AS car_name
    FROM public.sim_stats_improvements(v_user) i
    JOIN public.sim_track_catalog t ON t.id = i.track_id JOIN public.sim_car_catalog c ON c.id = i.car_id
    WHERE i.started_at < p_to AND i.started_at >= least(v_from, coalesce(p_prev_from, v_from))
  ), tot AS (
    SELECT b.win, jsonb_build_object(
        'laps', count(*), 'validLaps', count(*) FILTER (WHERE b.ok), 'sessions', count(DISTINCT b.session_id),
        'timeMs', coalesce(sum(b.time_ms) FILTER (WHERE b.time_ms > 0), 0),
        'distanceM', coalesce(round(sum(b.length_m) FILTER (WHERE b.time_ms > 0))::bigint, 0),
        'tracks', count(DISTINCT b.track_id), 'cars', count(DISTINCT b.car_id), 'games', count(DISTINCT b.game)) AS j
    FROM base b WHERE b.win IN ('cur', 'prev') GROUP BY b.win
  ), days AS (
    SELECT b.d, count(*) AS laps, count(*) FILTER (WHERE b.ok) AS valid, coalesce(sum(b.time_ms) FILTER (WHERE b.time_ms > 0), 0) AS ms,
           coalesce(round(sum(b.length_m) FILTER (WHERE b.time_ms > 0))::bigint, 0) AS dist, count(DISTINCT b.session_id) AS sessions,
           count(DISTINCT b.track_id) AS tracks, count(DISTINCT b.car_id) AS cars
    FROM base b WHERE b.win = 'cur' GROUP BY b.d
  ), pbdays AS (
    SELECT i.d, count(*) AS n FROM imp i WHERE i.started_at >= v_from GROUP BY i.d
  ), alldays AS (
    SELECT DISTINCT (l.started_at AT TIME ZONE 'UTC')::date AS d FROM public.sim_laps l WHERE l.user_id = v_user AND l.started_at < p_to
  ), runs AS (
    SELECT min(x.d) AS s, max(x.d) AS e, count(*)::int AS n FROM (SELECT a.d, a.d - (row_number() OVER (ORDER BY a.d))::int AS g FROM alldays a) x GROUP BY x.g
  ), pairs AS (
    SELECT b.track_id, b.car_id, b.game, b.track_name, b.car_name, count(*) AS laps
    FROM base b WHERE b.win = 'cur' AND b.track_id IS NOT NULL AND b.car_id IS NOT NULL
    GROUP BY b.track_id, b.car_id, b.game, b.track_name, b.car_name
    ORDER BY count(*) DESC, b.track_name, b.car_name, b.track_id, b.car_id LIMIT 4
  ), pair_days AS (
    SELECT b.track_id, b.car_id, b.d, min(b.time_ms) AS best
    FROM base b JOIN pairs p ON p.track_id = b.track_id AND p.car_id = b.car_id
    WHERE b.win = 'cur' AND b.ok GROUP BY b.track_id, b.car_id, b.d
  ), latest AS (
    -- Consistency is a trend: the person's latest 8 sessions, whatever the range (a week with one session still has a trend to show).
    SELECT s.id, s.started_at FROM public.sim_sessions s WHERE s.user_id = v_user AND s.started_at < p_to ORDER BY s.started_at DESC, s.id DESC LIMIT 8
  ), sess AS (
    SELECT s.id, s.started_at,
           count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid,
           count(*) FILTER (WHERE l.valid AND l.time_ms > 0 AND l.in_lap IS NOT TRUE AND l.out_lap IS NOT TRUE) AS clean,
           count(*) AS laps,
           stddev_samp(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0 AND l.in_lap IS NOT TRUE AND l.out_lap IS NOT TRUE) AS spread
    FROM latest s JOIN public.sim_laps l ON l.session_id = s.id AND l.user_id = v_user
    GROUP BY s.id, s.started_at
  )
  SELECT jsonb_build_object(
    'range', jsonb_build_object('from', to_char((v_from AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD'), 'to', to_char(v_today, 'YYYY-MM-DD'),
                                'days', (v_today - (v_from AT TIME ZONE 'UTC')::date) + 1),
    'totals', coalesce((SELECT t.j FROM tot t WHERE t.win = 'cur'), v_zero)
      || jsonb_build_object('personalBests', (SELECT count(*) FROM imp i WHERE i.started_at >= v_from)),
    'previous', coalesce((SELECT t.j FROM tot t WHERE t.win = 'prev'), v_zero)
      || jsonb_build_object('personalBests', (SELECT count(*) FROM imp i WHERE p_prev_from IS NOT NULL AND i.started_at >= p_prev_from AND i.started_at < v_from)),
    'perDay', coalesce((SELECT jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'laps', g.laps, 'validLaps', g.valid, 'timeMs', g.ms,
        'distanceM', g.dist, 'sessions', g.sessions, 'personalBests', coalesce(pd.n, 0), 'tracks', g.tracks, 'cars', g.cars) ORDER BY g.d)
      FROM days g LEFT JOIN pbdays pd ON pd.d = g.d), '[]'::jsonb),
    'heatmapDays', CASE WHEN p_heat_from IS NULL THEN NULL ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('day', to_char(h.d, 'YYYY-MM-DD'), 'laps', h.laps) ORDER BY h.d)
      FROM (SELECT b.d, count(*) AS laps FROM base b WHERE b.started_at >= p_heat_from GROUP BY b.d) h), '[]'::jsonb) END,
    'streak', jsonb_build_object(
      'current', coalesce((SELECT r.n FROM runs r WHERE r.e >= v_today - 1 ORDER BY r.e DESC LIMIT 1), 0),
      'best', coalesce((SELECT max(r.n) FROM runs r), 0),
      'bestDay', (SELECT jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'laps', g.laps) FROM days g ORDER BY g.laps DESC, g.d DESC LIMIT 1)),
    'improvements', coalesce((SELECT jsonb_agg(jsonb_build_object('lapId', x.lap_id, 'trackId', x.track_id, 'trackName', x.track_name, 'carId', x.car_id, 'carName', x.car_name,
        'game', x.game, 'timeMs', x.time_ms, 'previousBestMs', x.prev_ms, 'savedMs', x.prev_ms - x.time_ms, 'achievedAt', public.sim_iso(x.started_at))
        ORDER BY x.started_at DESC, x.lap_id DESC)
      FROM (SELECT * FROM imp i WHERE i.started_at >= v_from ORDER BY i.started_at DESC, i.lap_id DESC LIMIT 10) x), '[]'::jsonb),
    'pairs', coalesce((SELECT jsonb_agg(jsonb_build_object('trackId', p.track_id, 'trackName', p.track_name, 'carId', p.car_id, 'carName', p.car_name, 'game', p.game, 'laps', p.laps,
        'bestPerDay', coalesce((SELECT jsonb_agg(jsonb_build_object('day', to_char(pd.d, 'YYYY-MM-DD'), 'bestMs', pd.best) ORDER BY pd.d)
          FROM pair_days pd WHERE pd.track_id = p.track_id AND pd.car_id = p.car_id), '[]'::jsonb))
        ORDER BY p.laps DESC, p.track_name, p.car_name, p.track_id, p.car_id) FROM pairs p), '[]'::jsonb),
    'breakdown', jsonb_build_object(
      'games', coalesce((SELECT jsonb_agg(jsonb_build_object('game', g.game, 'laps', g.laps, 'validLaps', g.valid) ORDER BY g.laps DESC, g.game)
        FROM (SELECT b.game, count(*) AS laps, count(*) FILTER (WHERE b.ok) AS valid FROM base b WHERE b.win = 'cur' GROUP BY b.game) g), '[]'::jsonb),
      'tracks', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.track_id, 'name', g.track_name, 'game', g.game, 'laps', g.laps) ORDER BY g.laps DESC, g.track_name, g.track_id)
        FROM (SELECT b.track_id, b.track_name, b.game, count(*) AS laps FROM base b WHERE b.win = 'cur' AND b.track_id IS NOT NULL
              GROUP BY b.track_id, b.track_name, b.game ORDER BY count(*) DESC, b.track_name, b.track_id LIMIT 6) g), '[]'::jsonb),
      'cars', coalesce((SELECT jsonb_agg(jsonb_build_object('id', g.car_id, 'name', g.car_name, 'game', g.game, 'laps', g.laps) ORDER BY g.laps DESC, g.car_name, g.car_id)
        FROM (SELECT b.car_id, b.car_name, b.game, count(*) AS laps FROM base b WHERE b.win = 'cur' AND b.car_id IS NOT NULL
              GROUP BY b.car_id, b.car_name, b.game ORDER BY count(*) DESC, b.car_name, b.car_id LIMIT 6) g), '[]'::jsonb)),
    'consistency', coalesce((SELECT jsonb_agg(jsonb_build_object('sessionId', s.id, 'startedAt', public.sim_iso(s.started_at), 'validLaps', s.valid,
        'spreadMs', CASE WHEN s.clean >= 3 THEN round(s.spread)::int ELSE NULL END,
        'cleanShare', CASE WHEN s.laps > 0 THEN round(s.clean::numeric / s.laps, 3) ELSE 0 END) ORDER BY s.started_at, s.id) FROM sess s), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END $$;

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sim_stats_improvements', 'sim_v1_stats')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $grants$;
