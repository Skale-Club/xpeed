-- Four small things the site needs from the racing data (docs/platform/API-V1.md): one lap's metadata, a whole session
-- deleted in one call, and the best time of each sector in the personal bests and in a track's best-per-car list.
-- Additive: new functions and one new partial index; sim_v1_pbs and sim_v1_track are replaced with the same signature and the
-- same answer plus two fields per item (bestSectorsMs, sectorLapIds).

-- ---------------------------------------------------------------- the lap an id names

-- The same object as one item of the list (sim_lap_json), or null when the person has no such lap. Runs as the caller.
CREATE FUNCTION public.sim_v1_lap(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT public.sim_lap_json(l, t.name, c.name, d.name)
  FROM public.sim_laps l
  LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id
  LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
  LEFT JOIN public.sim_devices d ON d.id = l.device_id
  WHERE l.id = p_id AND l.user_id = public.current_app_user_id()
$$;

-- ---------------------------------------------------------------- a whole session deleted

-- Deletes every lap of the person's session and then the session, in one transaction. The delete triggers of sim_laps correct the
-- personal bests (and drop the session when its last lap goes). Answers {deleted: <laps>, paths: [<stored files>]}, or null when the
-- person has no such session (unknown, someone else's, or already deleted). The server removes the files afterwards.
CREATE FUNCTION public.sim_delete_session(p_user uuid, p_session uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_paths text[]; v_count integer;
BEGIN
  PERFORM 1 FROM public.sim_sessions WHERE id = p_session AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  WITH gone AS (DELETE FROM public.sim_laps WHERE session_id = p_session AND user_id = p_user RETURNING storage_path)
  SELECT coalesce(array_agg(storage_path), '{}'::text[]), count(*)::integer INTO v_paths, v_count FROM gone;
  DELETE FROM public.sim_sessions WHERE id = p_session AND user_id = p_user;
  RETURN jsonb_build_object('deleted', v_count, 'paths', to_jsonb(v_paths));
END $$;

-- ---------------------------------------------------------------- the best of each sector

-- The laps that can say what the best sectors are: valid and plausible, with sectors. Matches the WHERE of sim_sector_bests.
CREATE INDEX sim_laps_sector_bests ON public.sim_laps(user_id, track_id, car_id)
  WHERE valid AND plausible IS TRUE AND sector_ms IS NOT NULL;

-- For each (track, car) pair given (two arrays of the same length), the best time of every sector over the person's valid and
-- plausible laps that have the sector count most laps have for that pair (the larger count wins a tie): best_sectors[i] is the
-- fastest sector i + 1, sector_lap_ids[i] the lap that holds it (the earliest one on a tie). A lap with a sector of zero or less
-- is not used, so every sector has a value. A pair with no such lap is not returned. One set-based statement for the whole page.
CREATE FUNCTION public.sim_sector_bests(p_user uuid, p_tracks uuid[], p_cars uuid[])
RETURNS TABLE (track_id uuid, car_id uuid, best_sectors jsonb, sector_lap_ids jsonb)
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH pairs AS (
    SELECT DISTINCT x.track_id, x.car_id FROM unnest(p_tracks, p_cars) AS x(track_id, car_id)
  ), cand AS (
    SELECT l.track_id, l.car_id, cardinality(l.sector_ms) AS n, l.sector_ms, l.id, l.started_at
    FROM pairs p
    JOIN public.sim_laps l ON l.user_id = p_user AND l.track_id = p.track_id AND l.car_id = p.car_id
    WHERE l.valid AND l.plausible IS TRUE AND l.sector_ms IS NOT NULL AND cardinality(l.sector_ms) > 0 AND 0 < ALL (l.sector_ms)
  ), major AS (
    SELECT DISTINCT ON (g.track_id, g.car_id) g.track_id, g.car_id, g.n
    FROM (SELECT c.track_id, c.car_id, c.n, count(*) AS laps FROM cand c GROUP BY c.track_id, c.car_id, c.n) g
    ORDER BY g.track_id, g.car_id, g.laps DESC, g.n DESC
  ), best AS (
    SELECT DISTINCT ON (c.track_id, c.car_id, u.idx) c.track_id, c.car_id, u.idx, u.v, c.id
    FROM cand c
    JOIN major m ON m.track_id = c.track_id AND m.car_id = c.car_id AND m.n = c.n
    CROSS JOIN LATERAL unnest(c.sector_ms) WITH ORDINALITY AS u(v, idx)
    ORDER BY c.track_id, c.car_id, u.idx, u.v, c.started_at, c.id
  )
  SELECT b.track_id, b.car_id, jsonb_agg(b.v ORDER BY b.idx), jsonb_agg(b.id ORDER BY b.idx)
  FROM best b GROUP BY b.track_id, b.car_id
$$;

-- sim_v1_pbs, with bestSectorsMs and sectorLapIds on every item (null when no lap of that track and car has sectors).
CREATE OR REPLACE FUNCTION public.sim_v1_pbs(
  p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL,
  p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((
    WITH page AS MATERIALIZED (
      SELECT b.track_id, b.car_id, b.best_ms, b.lap_id, b.achieved_at, t.game, t.name AS track_name, c.name AS car_name
      FROM public.sim_personal_bests b
      JOIN public.sim_track_catalog t ON t.id = b.track_id
      JOIN public.sim_car_catalog c ON c.id = b.car_id
      WHERE b.user_id = v_user
        AND (p_game IS NULL OR t.game = p_game) AND (p_track IS NULL OR b.track_id = p_track) AND (p_car IS NULL OR b.car_id = p_car)
        AND (p_after_t IS NULL OR (b.achieved_at, b.lap_id) < (p_after_t, p_after_id))
      ORDER BY b.achieved_at DESC, b.lap_id DESC LIMIT least(greatest(p_limit, 1), 101)
    ), sectors AS (
      SELECT * FROM public.sim_sector_bests(v_user, ARRAY(SELECT pg.track_id FROM page pg), ARRAY(SELECT pg.car_id FROM page pg))
    )
    SELECT jsonb_agg(
      jsonb_build_object('game', p.game, 'track', jsonb_build_object('id', p.track_id, 'name', p.track_name), 'car', jsonb_build_object('id', p.car_id, 'name', p.car_name),
        'bestMs', p.best_ms, 'lapId', p.lap_id, 'achievedAt', public.sim_iso(p.achieved_at),
        'bestSectorsMs', s.best_sectors, 'sectorLapIds', s.sector_lap_ids,
        '_k', public.sim_iso_us(p.achieved_at), '_i', p.lap_id)
      ORDER BY p.achieved_at DESC, p.lap_id DESC)
    FROM page p LEFT JOIN sectors s ON s.track_id = p.track_id AND s.car_id = p.car_id
  ), '[]'::jsonb);
END $$;

-- sim_v1_track, with the same two fields on every bestPerCar item.
CREATE OR REPLACE FUNCTION public.sim_v1_track(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id(); t public.sim_track_catalog;
BEGIN
  SELECT * INTO t FROM public.sim_track_catalog WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'track', jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m),
    'totals', (SELECT jsonb_build_object('lapCount', count(*), 'validLapCount', count(*) FILTER (WHERE l.valid AND l.time_ms > 0),
        'sessionCount', count(DISTINCT l.session_id), 'carCount', count(DISTINCT l.car_id),
        'bestLapMs', min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0), 'lastDrivenAt', public.sim_iso(max(l.started_at)))
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id = t.id),
    'progress', jsonb_build_object(
      'bestPerDay', coalesce((SELECT jsonb_agg(d.j ORDER BY d.day) FROM (
        SELECT x.day, jsonb_build_object('day', x.day::text, 'bestMs', x.time_ms, 'lapId', x.id, 'car', jsonb_build_object('id', x.car_id, 'name', c.name)) AS j
        FROM (
          SELECT DISTINCT ON ((l.started_at AT TIME ZONE 'UTC')::date) (l.started_at AT TIME ZONE 'UTC')::date AS day, l.time_ms, l.id, l.car_id
          FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id = t.id AND l.valid AND l.time_ms > 0
          ORDER BY (l.started_at AT TIME ZONE 'UTC')::date DESC, l.time_ms, l.started_at, l.id LIMIT 1000
        ) x LEFT JOIN public.sim_car_catalog c ON c.id = x.car_id) d), '[]'::jsonb),
      'lapsPerDay', coalesce((SELECT jsonb_agg(d.j ORDER BY d.day) FROM (
        SELECT (l.started_at AT TIME ZONE 'UTC')::date AS day,
          jsonb_build_object('day', ((l.started_at AT TIME ZONE 'UTC')::date)::text, 'laps', count(*), 'validLaps', count(*) FILTER (WHERE l.valid AND l.time_ms > 0)) AS j
        FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id = t.id
        GROUP BY (l.started_at AT TIME ZONE 'UTC')::date ORDER BY (l.started_at AT TIME ZONE 'UTC')::date DESC LIMIT 1000) d), '[]'::jsonb)),
    'bestPerCar', coalesce((
      WITH a AS (
        SELECT l.car_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps
        FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id = t.id AND l.car_id IS NOT NULL GROUP BY l.car_id
      ), sectors AS (
        SELECT * FROM public.sim_sector_bests(v_user, ARRAY(SELECT t.id FROM a), ARRAY(SELECT a.car_id FROM a))
      )
      SELECT jsonb_agg(z.j ORDER BY z.best_ms NULLS LAST, z.name, z.car_id) FROM (
        SELECT a.car_id, c.name, b.best_ms,
          jsonb_build_object('car', jsonb_build_object('id', c.id, 'name', c.name, 'class', c.class), 'lapCount', a.laps, 'validLapCount', a.valid_laps,
            'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at),
            'bestSectorsMs', s.best_sectors, 'sectorLapIds', s.sector_lap_ids) AS j
        FROM a
        JOIN public.sim_car_catalog c ON c.id = a.car_id
        LEFT JOIN public.sim_personal_bests b ON b.user_id = v_user AND b.track_id = t.id AND b.car_id = a.car_id
        LEFT JOIN sectors s ON s.car_id = a.car_id
        LIMIT 200) z), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  -- Only the server: it resolves the signed-in person first and passes their id.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sim_delete_session')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
  -- The read side runs as the signed-in person.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sim_v1_lap', 'sim_sector_bests')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $grants$;
