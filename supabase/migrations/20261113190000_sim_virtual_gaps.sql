-- Server-side gaps the Virtual screens reported (docs/platform/API-V1.md): the personal best a lap replaced, whether a track has a
-- layout the Companion sent, the car's best lap per day, the leaderboard catalog (tracks and cars that have public laps), what a share
-- link is about, and how many friend requests wait. Additive and idempotent: new functions, one new partial index, and replaced
-- functions with the same signatures (the answers only gain fields).

-- ---------------------------------------------------------------- the personal best a lap replaced

-- The laps that can have been a person's best before a given lap: valid and timed. Serves sim_previous_best (a range on started_at).
CREATE INDEX IF NOT EXISTS sim_laps_previous_best ON public.sim_laps(user_id, track_id, car_id, started_at, id) INCLUDE (time_ms)
  WHERE valid AND time_ms > 0;

-- The best valid time on that track and car before the lap p_lap (by start time, the lap id breaking a tie), when it was slower than
-- p_best; null when the lap was the first valid one or an earlier lap was as fast (nothing was replaced). Runs as the caller.
CREATE OR REPLACE FUNCTION public.sim_previous_best(p_user uuid, p_track uuid, p_car uuid, p_lap uuid, p_started timestamptz, p_best integer)
RETURNS integer
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT x.m FROM (
    SELECT min(l.time_ms) AS m FROM public.sim_laps l
    WHERE l.user_id = p_user AND l.track_id = p_track AND l.car_id = p_car AND l.valid AND l.time_ms > 0 AND (l.started_at, l.id) < (p_started, p_lap)
  ) x WHERE x.m > p_best
$$;

-- ---------------------------------------------------------------- the layout a track has

-- The id of the person's newest track layout (sim_tracks) for a catalog track: the same game and the same name, by sim_norm (case,
-- accents and punctuation do not count). A layout is named the way the game names the track, so any of its track name, its track name
-- with the layout variant, or its title can be the catalog name (src/lib/sim/track-layout-match.ts). rFactor 1 layouts are filed under
-- the game `sce`. Null when there is none. Runs as the caller (row level security keeps it to their own layouts).
CREATE OR REPLACE FUNCTION public.sim_layout_id(p_user uuid, p_game text, p_name text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.id FROM public.sim_tracks s
  WHERE s.user_id = p_user
    AND public.sim_norm(s.game) = public.sim_norm(CASE WHEN lower(btrim(p_game)) = 'rfactor1' THEN 'sce' ELSE p_game END)
    AND public.sim_norm(p_name) <> ''
    AND public.sim_norm(p_name) IN (public.sim_norm(s.track_name), public.sim_norm(s.track_name || ' ' || coalesce(s.variant, '')), public.sim_norm(s.title))
  ORDER BY s.updated_at DESC, s.id LIMIT 1
$$;

-- ---------------------------------------------------------------- tracks (hasLayout), track, car (bestPerDay), pbs and overview (previousBestMs)

CREATE OR REPLACE FUNCTION public.sim_v1_tracks(
  p_game text DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(y.j ORDER BY y.last_driven DESC, y.id DESC) FROM (
    SELECT t.id, a.last_driven,
      jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m, 'hasLayout', lay.id IS NOT NULL, 'layoutId', lay.id,
        'lapCount', a.laps, 'validLapCount', a.valid_laps, 'sessionCount', a.sessions, 'carCount', a.cars, 'bestLapMs', a.best,
        'lastDrivenAt', public.sim_iso(a.last_driven), '_k', public.sim_iso_us(a.last_driven), '_i', t.id) AS j
    FROM (
      SELECT l.track_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps,
        count(DISTINCT l.session_id) AS sessions, count(DISTINCT l.car_id) AS cars,
        min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0) AS best, max(l.started_at) AS last_driven
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id IS NOT NULL GROUP BY l.track_id
    ) a JOIN public.sim_track_catalog t ON t.id = a.track_id
    LEFT JOIN LATERAL (SELECT public.sim_layout_id(v_user, t.game, t.name) AS id) lay ON true
    WHERE (p_game IS NULL OR t.game = p_game) AND (p_after_t IS NULL OR (a.last_driven, t.id) < (p_after_t, p_after_id))
    ORDER BY a.last_driven DESC, t.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) y), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.sim_v1_track(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id(); t public.sim_track_catalog; v_layout uuid;
BEGIN
  SELECT * INTO t FROM public.sim_track_catalog WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_layout := public.sim_layout_id(v_user, t.game, t.name);
  RETURN jsonb_build_object(
    'track', jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m, 'hasLayout', v_layout IS NOT NULL, 'layoutId', v_layout),
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

CREATE OR REPLACE FUNCTION public.sim_v1_car(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id(); c public.sim_car_catalog;
BEGIN
  SELECT * INTO c FROM public.sim_car_catalog WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'car', jsonb_build_object('id', c.id, 'game', c.game, 'name', c.name, 'brand', c.brand, 'class', c.class),
    'totals', (SELECT jsonb_build_object('lapCount', count(*), 'validLapCount', count(*) FILTER (WHERE l.valid AND l.time_ms > 0),
        'sessionCount', count(DISTINCT l.session_id), 'trackCount', count(DISTINCT l.track_id),
        'bestLapMs', min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0), 'lastDrivenAt', public.sim_iso(max(l.started_at)))
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.car_id = c.id),
    'progress', jsonb_build_object(
      -- The fastest valid lap of each day on each track (times on different tracks are not comparable), oldest day first.
      'bestPerDay', coalesce((SELECT jsonb_agg(d.j ORDER BY d.day, d.name, d.track_id) FROM (
        SELECT x.day, x.track_id, t.name,
          jsonb_build_object('day', x.day::text, 'bestMs', x.time_ms, 'lapId', x.id, 'track', jsonb_build_object('id', x.track_id, 'name', t.name)) AS j
        FROM (
          SELECT DISTINCT ON ((l.started_at AT TIME ZONE 'UTC')::date, l.track_id) (l.started_at AT TIME ZONE 'UTC')::date AS day, l.track_id, l.time_ms, l.id
          FROM public.sim_laps l WHERE l.user_id = v_user AND l.car_id = c.id AND l.track_id IS NOT NULL AND l.valid AND l.time_ms > 0
          ORDER BY (l.started_at AT TIME ZONE 'UTC')::date DESC, l.track_id, l.time_ms, l.started_at, l.id LIMIT 1000
        ) x JOIN public.sim_track_catalog t ON t.id = x.track_id) d), '[]'::jsonb),
      'lapsPerDay', coalesce((SELECT jsonb_agg(d.j ORDER BY d.day) FROM (
        SELECT (l.started_at AT TIME ZONE 'UTC')::date AS day,
          jsonb_build_object('day', ((l.started_at AT TIME ZONE 'UTC')::date)::text, 'laps', count(*), 'validLaps', count(*) FILTER (WHERE l.valid AND l.time_ms > 0)) AS j
        FROM public.sim_laps l WHERE l.user_id = v_user AND l.car_id = c.id
        GROUP BY (l.started_at AT TIME ZONE 'UTC')::date ORDER BY (l.started_at AT TIME ZONE 'UTC')::date DESC LIMIT 1000) d), '[]'::jsonb)),
    'bestPerTrack', coalesce((SELECT jsonb_agg(z.j ORDER BY z.name, z.track_id) FROM (
      SELECT a.track_id, t.name,
        jsonb_build_object('track', jsonb_build_object('id', t.id, 'name', t.name), 'lapCount', a.laps, 'validLapCount', a.valid_laps,
          'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at)) AS j
      FROM (SELECT l.track_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps
            FROM public.sim_laps l WHERE l.user_id = v_user AND l.car_id = c.id AND l.track_id IS NOT NULL GROUP BY l.track_id) a
      JOIN public.sim_track_catalog t ON t.id = a.track_id
      LEFT JOIN public.sim_personal_bests b ON b.user_id = v_user AND b.track_id = a.track_id AND b.car_id = c.id
      LIMIT 500) z), '[]'::jsonb));
END $$;

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
        'previousBestMs', pv.ms, 'improvedByMs', pv.ms - p.best_ms,
        '_k', public.sim_iso_us(p.achieved_at), '_i', p.lap_id)
      ORDER BY p.achieved_at DESC, p.lap_id DESC)
    FROM page p LEFT JOIN sectors s ON s.track_id = p.track_id AND s.car_id = p.car_id
    LEFT JOIN LATERAL (SELECT public.sim_previous_best(v_user, p.track_id, p.car_id, p.lap_id, p.achieved_at, p.best_ms) AS ms) pv ON true
  ), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.sim_v1_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN jsonb_build_object(
    'latestSessions', coalesce((SELECT jsonb_agg(x.j ORDER BY x.started_at DESC, x.id DESC) FROM (
      SELECT s.id, s.started_at, public.sim_session_json(s, t.name, c.name) AS j
      FROM public.sim_sessions s JOIN public.sim_track_catalog t ON t.id = s.track_id JOIN public.sim_car_catalog c ON c.id = s.car_id
      WHERE s.user_id = v_user ORDER BY s.started_at DESC, s.id DESC LIMIT 5) x), '[]'::jsonb),
    'latestPersonalBests', coalesce((SELECT jsonb_agg(x.j ORDER BY x.achieved_at DESC, x.lap_id DESC) FROM (
      SELECT b.achieved_at, b.lap_id,
        jsonb_build_object('game', t.game, 'track', jsonb_build_object('id', t.id, 'name', t.name), 'car', jsonb_build_object('id', c.id, 'name', c.name),
          'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at),
          'previousBestMs', pv.ms, 'improvedByMs', pv.ms - b.best_ms) AS j
      FROM public.sim_personal_bests b JOIN public.sim_track_catalog t ON t.id = b.track_id JOIN public.sim_car_catalog c ON c.id = b.car_id
        LEFT JOIN LATERAL (SELECT public.sim_previous_best(v_user, b.track_id, b.car_id, b.lap_id, b.achieved_at, b.best_ms) AS ms) pv ON true
      WHERE b.user_id = v_user ORDER BY b.achieved_at DESC, b.lap_id DESC LIMIT 5) x), '[]'::jsonb),
    'lapsPerGame', coalesce((SELECT jsonb_agg(g.j ORDER BY g.laps DESC, g.game) FROM (
      SELECT l.game, count(*) AS laps,
        jsonb_build_object('game', l.game, 'laps', count(*), 'validLaps', count(*) FILTER (WHERE l.valid AND l.time_ms > 0),
          'sessions', count(DISTINCT l.session_id), 'lastDrivenAt', public.sim_iso(max(l.started_at))) AS j
      FROM public.sim_laps l WHERE l.user_id = v_user GROUP BY l.game) g), '[]'::jsonb),
    'companion', jsonb_build_object(
      'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'pairedAt', public.sim_iso(d.created_at),
          'lastSeenAt', public.sim_iso(d.last_seen_at), 'lastLapAt', public.sim_iso(d.last_lap_at)) ORDER BY d.created_at DESC, d.id)
        FROM public.sim_devices d WHERE d.user_id = v_user AND d.revoked_at IS NULL), '[]'::jsonb),
      'lastLap', (SELECT public.sim_lap_json(l, t.name, c.name, d.name)
        FROM public.sim_laps l LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
          LEFT JOIN public.sim_devices d ON d.id = l.device_id
        WHERE l.user_id = v_user ORDER BY l.created_at DESC, l.id DESC LIMIT 1)),
    'storage', (SELECT jsonb_build_object('lapCount', count(*), 'usedBytes', coalesce(sum(l.size_bytes), 0)) FROM public.sim_laps l WHERE l.user_id = v_user));
END $$;

-- ---------------------------------------------------------------- the leaderboard catalog

-- The tracks (p_kind 'track') or the cars ('car') that have at least one lap on the public board as p_viewer may see it: valid,
-- plausible, not hidden, of a public profile that is not hidden, and not of anyone who is blocked either way with the viewer.
-- Optional filters: the game, and the other side of the pair (p_car narrows the tracks, p_track the cars). Alphabetical by name,
-- then id; each item carries "_n" (the name) and "_i" (the id) for the cursor, which the API strips.
CREATE OR REPLACE FUNCTION public.sim_leaderboard_catalog(
  p_viewer uuid, p_kind text, p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL,
  p_after_name text DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH listed AS (
    SELECT CASE WHEN p_kind = 'track' THEN l.track_id ELSE l.car_id END AS item_id, count(*) AS laps
    FROM public.sim_laps l JOIN public.sim_profiles p ON p.user_id = l.user_id
    WHERE l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0 AND l.track_id IS NOT NULL AND l.car_id IS NOT NULL
      AND NOT p.hidden AND p.visibility = 'public'
      AND (p_game IS NULL OR l.game = p_game) AND (p_track IS NULL OR l.track_id = p_track) AND (p_car IS NULL OR l.car_id = p_car)
      AND NOT EXISTS (SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'blocked')
    GROUP BY 1
  ), items AS (
    SELECT t.name, t.id, jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m, 'lapCount', li.laps) AS item
    FROM listed li JOIN public.sim_track_catalog t ON t.id = li.item_id WHERE p_kind = 'track'
    UNION ALL
    SELECT c.name, c.id, jsonb_build_object('id', c.id, 'game', c.game, 'name', c.name, 'brand', c.brand, 'class', c.class, 'lapCount', li.laps)
    FROM listed li JOIN public.sim_car_catalog c ON c.id = li.item_id WHERE p_kind = 'car'
  )
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.name, x.id), '[]'::jsonb) FROM (
    SELECT i.name, i.id, i.item || jsonb_build_object('_n', i.name, '_i', i.id) AS item FROM items i
    WHERE p_after_id IS NULL OR (i.name, i.id) > (p_after_name, p_after_id)
    ORDER BY i.name, i.id LIMIT p_limit) x
$$;

-- ---------------------------------------------------------------- share links: what each one is about

-- sim_share_list, each item also saying what the link shows: trackName, carName and lapMs for a lap, trackName, carName, sessionKind and
-- lapCount for a session (null where it does not apply). The names are the catalog's. Never the token, never anything about other people.
CREATE OR REPLACE FUNCTION public.sim_share_list(p_user uuid, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.t DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT s.created_at AS t, s.id,
      public.sim_share_item(s) || jsonb_build_object(
        'trackName', coalesce(lt.name, l.track_name, st.name), 'carName', coalesce(lc.name, l.car_name, sc.name),
        'lapMs', l.time_ms, 'sessionKind', ss.kind, 'lapCount', ss.lap_count,
        '_k', public.sim_iso_us(s.created_at), '_i', s.id) AS item
    FROM public.sim_shares s
    LEFT JOIN public.sim_laps l ON l.id = s.lap_id
    LEFT JOIN public.sim_track_catalog lt ON lt.id = l.track_id
    LEFT JOIN public.sim_car_catalog lc ON lc.id = l.car_id
    LEFT JOIN public.sim_sessions ss ON ss.id = s.session_id
    LEFT JOIN public.sim_track_catalog st ON st.id = ss.track_id
    LEFT JOIN public.sim_car_catalog sc ON sc.id = ss.car_id
    WHERE s.created_by = p_user AND (p_after_id IS NULL OR (s.created_at, s.id) < (p_after_t, p_after_id))
    ORDER BY s.created_at DESC, s.id DESC LIMIT p_limit) x
$$;

-- ---------------------------------------------------------------- friend requests waiting

-- How many people asked p_viewer to be friends and still wait (the people the list of incoming requests shows: hidden profiles are not counted).
CREATE OR REPLACE FUNCTION public.sim_friend_request_count(p_viewer uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.sim_friendships f
  JOIN public.sim_profiles op ON op.user_id = CASE WHEN f.user_a = p_viewer THEN f.user_b ELSE f.user_a END
  WHERE (f.user_a = p_viewer OR f.user_b = p_viewer) AND f.status = 'pending' AND f.requested_by <> p_viewer AND NOT op.hidden
$$;

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  -- Only the server: it resolves the signed-in person first and passes their id.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('sim_leaderboard_catalog', 'sim_share_list', 'sim_friend_request_count')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
  -- The read side runs as the signed-in person.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'sim_previous_best', 'sim_layout_id', 'sim_v1_tracks', 'sim_v1_track', 'sim_v1_car', 'sim_v1_pbs', 'sim_v1_overview')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $grants$;
