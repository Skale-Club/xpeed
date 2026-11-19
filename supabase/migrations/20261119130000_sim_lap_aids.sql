-- Aid boards (plans/condition-aware-leaderboards.md, phase 3).
--
-- The lap file header can say which driving aids the lap was driven with (`aids`, phase 2: the highest setting seen during the lap).
-- The server sorts a lap into one class at ingest (api/sim/_aids.ts) and stores it beside the lap, so a board can be filtered by it.
-- Additive: two columns, one index, the ingest replaced by the same body plus those two columns, and the board functions replaced by
-- the same bodies plus a trailing `p_aids text DEFAULT 'all'`, so a caller that does not pass it is unchanged. Safe to run again.
--
--   aids       the aids object of the header as sent, or NULL when the header has none or the lap contradicts it (see aid_class).
--   aid_class  none       TC and ABS are known and 0, and every other aid the game gave is off;
--              no_tc_abs  TC and ABS are known and 0, but some other aid is on;
--              any        TC or ABS is known and above 0;
--              unknown    TC or ABS is missing (every lap before the Companion wrote aids, iRacing...) or the lap's own channels
--                         contradict its claim (tc_active / abs_active set while it says 0): that is stored in `plausibility`->'aids'
--                         for the moderators and does NOT make the lap implausible.
--              A lap of class unknown is only on the "all" board.

ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS aids jsonb;
ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS aid_class text NOT NULL DEFAULT 'unknown';
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sim_laps'::regclass AND conname = 'sim_laps_aid_class_values') THEN
    ALTER TABLE public.sim_laps ADD CONSTRAINT sim_laps_aid_class_values CHECK (aid_class IN ('none', 'no_tc_abs', 'any', 'unknown'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sim_laps'::regclass AND conname = 'sim_laps_aids_object') THEN
    ALTER TABLE public.sim_laps ADD CONSTRAINT sim_laps_aids_object CHECK (aids IS NULL OR jsonb_typeof(aids) = 'object');
  END IF;
END $constraint$;

-- The board of one aid class: sim_laps_board with the class after the car (like sim_laps_board_tyre).
CREATE INDEX IF NOT EXISTS sim_laps_board_aids ON public.sim_laps(track_id, car_id, aid_class, user_id, time_ms, started_at, id)
  WHERE valid AND plausible IS TRUE AND NOT hidden;

-- ---------------------------------------------------------------- the ingest, now with the aids

-- The ingest of sim_lap_tyres.sql, with `aids` and `aid_class` stored beside the lap. A server that sends neither (an older one, during a
-- rollout) stores the lap as class unknown, which is the honest reading.
CREATE OR REPLACE FUNCTION public.sim_ingest_lap(p_user_id uuid, p_device_id uuid, p_lap jsonb, p_max_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_admission jsonb; v_track uuid; v_car uuid; v_session uuid; v_id uuid;
  v_started timestamptz := (p_lap->>'started_at')::timestamptz;
  v_ms integer := (p_lap->>'time_ms')::integer;
  v_sectors integer[];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || p_user_id::text, 0));
  v_admission := public.sim_lap_admission(p_user_id, p_lap->>'identity', (p_lap->>'size_bytes')::integer, p_max_bytes);
  IF v_admission->>'status' <> 'ok' THEN RETURN v_admission; END IF;

  PERFORM public.sim_ensure_profile(p_user_id);
  v_track := public.sim_resolve_track(p_lap->>'game', p_lap->>'track_name', (p_lap->>'track_length_m')::double precision);
  v_car := public.sim_resolve_car(p_lap->>'game', p_lap->>'car_name', p_lap->>'car_class');
  v_session := public.sim_assign_session(p_user_id, p_lap->>'game', v_track, v_car, v_started, v_started + v_ms * interval '1 millisecond',
    nullif(p_lap->>'session_id', ''), p_lap->>'session_kind', p_lap->>'weather',
    (p_lap->>'air_temp_c')::real, (p_lap->>'track_temp_c')::real);
  IF jsonb_typeof(p_lap->'sector_ms') = 'array' THEN
    SELECT array_agg(x.value::integer ORDER BY x.ord) INTO v_sectors FROM jsonb_array_elements_text(p_lap->'sector_ms') WITH ORDINALITY AS x(value, ord);
  END IF;

  INSERT INTO public.sim_laps(user_id, device_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at,
    sample_count, size_bytes, storage_path, track_id, car_id, session_id, sector_ms, top_speed_kmh, fuel_used_l, in_lap, out_lap, format_version,
    plausible, plausibility, recorder, tyre_compound, tyre_read, aids, aid_class)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1),
    (p_lap->>'plausible')::boolean, p_lap->'plausibility',
    CASE WHEN jsonb_typeof(p_lap->'recorder') = 'object' THEN p_lap->'recorder' ELSE NULL END,
    nullif(p_lap->>'tyre_compound', ''), p_lap ? 'tyre_compound',
    CASE WHEN jsonb_typeof(p_lap->'aids') = 'object' THEN p_lap->'aids' ELSE NULL END,
    CASE WHEN p_lap->>'aid_class' IN ('none', 'no_tc_abs', 'any') THEN p_lap->>'aid_class' ELSE 'unknown' END)
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

-- ---------------------------------------------------------------- leaderboards

-- The versions of sim_lap_tyres.sql (no p_aids) and, so that this file can run again, the ones it creates.
DROP FUNCTION IF EXISTS public.sim_leaderboard_conditions(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard_me(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard(uuid, uuid, uuid, text, integer, timestamptz, uuid, integer, text);
DROP FUNCTION IF EXISTS public.sim_board(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.sim_board_laps(uuid, uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard_conditions(uuid, uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard_me(uuid, uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard(uuid, uuid, uuid, text, integer, timestamptz, uuid, integer, text, text);
DROP FUNCTION IF EXISTS public.sim_board(uuid, uuid, uuid, text, text, text);
DROP FUNCTION IF EXISTS public.sim_board_laps(uuid, uuid, uuid, text, text, text);

-- Every lap a board can show (see sim_lap_tyres.sql), now also limited to one aid board and carrying the lap's aids. p_aids: 'all' (or
-- anything else) is every lap, 'no_tc_abs' the laps of class no_tc_abs or none, 'none' the laps of class none. This is still the one place
-- that decides who is on a board, so the ranking, the chips and the theoretical best cannot disagree.
CREATE FUNCTION public.sim_board_laps(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL, p_aids text DEFAULT 'all')
RETURNS TABLE (lap_id uuid, user_id uuid, time_ms integer, started_at timestamptz, tyre_compound text, sector_ms integer[], handle text, display_name text, aids jsonb, aid_class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id, l.user_id, l.time_ms, l.started_at, l.tyre_compound, l.sector_ms, p.handle, p.display_name, l.aids, l.aid_class
  FROM public.sim_laps l JOIN public.sim_profiles p ON p.user_id = l.user_id
  WHERE l.track_id = p_track AND l.car_id = p_car AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0 AND NOT p.hidden
    AND (p_tyre IS NULL OR l.tyre_compound = p_tyre)
    AND CASE p_aids WHEN 'none' THEN l.aid_class = 'none' WHEN 'no_tc_abs' THEN l.aid_class IN ('none', 'no_tc_abs') ELSE true END
    AND CASE p_scope
      WHEN 'public' THEN p.visibility = 'public' AND NOT EXISTS (
        SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'blocked')
      ELSE l.user_id = p_viewer OR (p.visibility <> 'private' AND EXISTS (
        SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'accepted'))
    END
$$;

-- Every driver's best lap on one track and car (and tyre, and aid board). Ranked by time (ties share a rank, the earlier lap first);
-- gap_ms is the distance to the leader. aids is the aids of that lap.
CREATE FUNCTION public.sim_board(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL, p_aids text DEFAULT 'all')
RETURNS TABLE (rank bigint, pos bigint, lap_id uuid, user_id uuid, time_ms integer, started_at timestamptz, gap_ms integer, handle text, display_name text, aids jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH best AS (
    SELECT DISTINCT ON (l.user_id) l.user_id AS uid, l.lap_id AS lid, l.time_ms AS ms, l.started_at AS st, l.handle AS hd, l.display_name AS dn, l.aids AS ai
    FROM public.sim_board_laps(p_viewer, p_track, p_car, p_scope, p_tyre, p_aids) l
    ORDER BY l.user_id, l.time_ms, l.started_at, l.lap_id)
  SELECT rank() OVER (ORDER BY b.ms), row_number() OVER (ORDER BY b.ms, b.st, b.lid), b.lid, b.uid, b.ms, b.st,
         b.ms - min(b.ms) OVER (), b.hd, b.dn, b.ai
  FROM best b
$$;

CREATE FUNCTION public.sim_leaderboard(
  p_viewer uuid, p_track uuid, p_car uuid, p_scope text,
  p_after_ms integer DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_lap uuid DEFAULT NULL, p_limit integer DEFAULT 51,
  p_tyre text DEFAULT NULL, p_aids text DEFAULT 'all'
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.pos), '[]'::jsonb) FROM (
    SELECT b.pos, jsonb_build_object('rank', b.rank, 'lapId', b.lap_id, 'handle', b.handle, 'displayName', b.display_name, 'timeMs', b.time_ms,
      'gapMs', b.gap_ms, 'achievedAt', public.sim_iso(b.started_at), 'isMe', b.user_id = p_viewer, 'aids', b.aids,
      '_ms', b.time_ms, '_t', public.sim_iso_us(b.started_at), '_i', b.lap_id) AS item
    FROM public.sim_board(p_viewer, p_track, p_car, p_scope, p_tyre, p_aids) b
    WHERE p_after_lap IS NULL OR (b.time_ms, b.started_at, b.lap_id) > (p_after_ms, p_after_t, p_after_lap)
    ORDER BY b.pos LIMIT p_limit) x
$$;

-- The caller's own rank on a board (and tyre, and aid board) and the two drivers above and below them.
CREATE FUNCTION public.sim_leaderboard_me(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL, p_aids text DEFAULT 'all') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH b AS MATERIALIZED (SELECT * FROM public.sim_board(p_viewer, p_track, p_car, p_scope, p_tyre, p_aids)),
       me AS (SELECT b.pos FROM b WHERE b.user_id = p_viewer),
       r AS (SELECT b.pos, jsonb_build_object('rank', b.rank, 'lapId', b.lap_id, 'handle', b.handle, 'displayName', b.display_name, 'timeMs', b.time_ms,
          'gapMs', b.gap_ms, 'achievedAt', public.sim_iso(b.started_at), 'isMe', b.user_id = p_viewer, 'aids', b.aids) AS item FROM b)
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM b),
    'me', (SELECT r.item FROM r WHERE r.pos = (SELECT me.pos FROM me)),
    'reason', CASE WHEN EXISTS (SELECT 1 FROM me) THEN NULL ELSE 'not_listed' END,
    'above', (SELECT coalesce(jsonb_agg(r.item ORDER BY r.pos), '[]'::jsonb) FROM r WHERE r.pos BETWEEN (SELECT me.pos FROM me) - 2 AND (SELECT me.pos FROM me) - 1),
    'below', (SELECT coalesce(jsonb_agg(r.item ORDER BY r.pos), '[]'::jsonb) FROM r WHERE r.pos BETWEEN (SELECT me.pos FROM me) + 1 AND (SELECT me.pos FROM me) + 2))
$$;

-- What a board is made of (see sim_lap_tyres.sql): the tyre compounds that have laps on it, the theoretical best, and now the two aid
-- boards with how many drivers each has. The compounds always cover the whole board, so the chips do not change while one is chosen. The
-- aid counts honour p_tyre (the drivers on that aid board with that tyre); they never depend on p_aids, so the chips stay too. The
-- theoretical best follows both p_tyre and p_aids. Both aid classes are always listed, even with 0 drivers: a driver counts on no_tc_abs
-- if their lap is of class no_tc_abs or none, as on the board itself.
CREATE FUNCTION public.sim_leaderboard_conditions(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL, p_aids text DEFAULT 'all') RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH eligible AS MATERIALIZED (SELECT * FROM public.sim_board_laps(p_viewer, p_track, p_car, p_scope)),
       counted AS (
         SELECT * FROM eligible e
         WHERE (p_tyre IS NULL OR e.tyre_compound = p_tyre)
           AND CASE p_aids WHEN 'none' THEN e.aid_class = 'none' WHEN 'no_tc_abs' THEN e.aid_class IN ('none', 'no_tc_abs') ELSE true END),
       shape AS (
         SELECT count(*) AS laps, count(DISTINCT cardinality(c.sector_ms)) AS counts,
                coalesce(bool_and(coalesce(cardinality(c.sector_ms) >= 2 AND 0 < ALL (c.sector_ms), false)), false) AS usable
         FROM counted c),
       best AS (
         SELECT DISTINCT ON (s.idx) s.idx, s.ms, c.handle
         FROM counted c, unnest(c.sector_ms) WITH ORDINALITY AS s(ms, idx)
         WHERE (SELECT sh.laps > 0 AND sh.counts = 1 AND sh.usable FROM shape sh)
         ORDER BY s.idx, s.ms, c.started_at, c.lap_id)
  SELECT jsonb_build_object(
    'tyres', (SELECT coalesce(jsonb_agg(jsonb_build_object('compound', t.compound, 'drivers', t.drivers) ORDER BY t.drivers DESC, t.compound), '[]'::jsonb)
      FROM (SELECT e.tyre_compound AS compound, count(DISTINCT e.user_id) AS drivers FROM eligible e WHERE e.tyre_compound IS NOT NULL GROUP BY e.tyre_compound) t),
    'aids', jsonb_build_array(
      jsonb_build_object('class', 'no_tc_abs', 'drivers', (SELECT count(DISTINCT e.user_id) FROM eligible e
        WHERE e.aid_class IN ('none', 'no_tc_abs') AND (p_tyre IS NULL OR e.tyre_compound = p_tyre))),
      jsonb_build_object('class', 'none', 'drivers', (SELECT count(DISTINCT e.user_id) FROM eligible e
        WHERE e.aid_class = 'none' AND (p_tyre IS NULL OR e.tyre_compound = p_tyre)))),
    'theoreticalBest', CASE WHEN EXISTS (SELECT 1 FROM best) THEN jsonb_build_object(
      'timeMs', (SELECT sum(b.ms) FROM best b),
      'sectors', (SELECT jsonb_agg(jsonb_build_object('index', b.idx, 'ms', b.ms, 'handle', b.handle) ORDER BY b.idx) FROM best b)) ELSE NULL END)
$$;

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  -- Only the server: it resolves the signed-in person first and passes their id.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'sim_board_laps', 'sim_board', 'sim_leaderboard', 'sim_leaderboard_me', 'sim_leaderboard_conditions')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $grants$;
