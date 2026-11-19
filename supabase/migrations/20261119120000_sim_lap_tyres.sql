-- Tyre boards (plans/condition-aware-leaderboards.md, phase 1).
--
-- The lap file header already says which tyre compound the car ran (`tyreCompound`, version 2); until now the server dropped it. This
-- keeps it beside the lap, lets a board be filtered by it, lists the compounds a board has, and works out the "theoretical best" of a
-- board (the best of each sector and who drove it). Additive: two columns, two indexes, new functions, and the board functions replaced
-- by the same bodies plus a trailing `p_tyre text DEFAULT NULL` (null means every tyre), so a caller that does not pass it is unchanged.
--
--   tyre_compound  the compound as the game writes it ("Soft", "Medium"...), NULL when the lap has none. Compared as an exact string
--                  within one game; there is no mapping across games.
--   tyre_read      true once the lap's header has been looked at. Laps that arrived before this migration are false until the
--                  background backfill (api/sim/_tyres.ts) reads their files, header only; a lap whose header has no compound is
--                  marked read with a NULL compound, so it is not met again.

ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS tyre_compound text;
ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS tyre_read boolean NOT NULL DEFAULT false;
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.sim_laps'::regclass AND conname = 'sim_laps_tyre_compound_length') THEN
    ALTER TABLE public.sim_laps ADD CONSTRAINT sim_laps_tyre_compound_length CHECK (tyre_compound IS NULL OR char_length(tyre_compound) BETWEEN 1 AND 40);
  END IF;
END $constraint$;

-- The board of one tyre: sim_laps_board with the compound after the car.
CREATE INDEX IF NOT EXISTS sim_laps_board_tyre ON public.sim_laps(track_id, car_id, tyre_compound, user_id, time_ms, started_at, id)
  WHERE valid AND plausible IS TRUE AND NOT hidden;
-- Laps whose header has not been read for the tyre yet, oldest first (the backfill's queue).
CREATE INDEX IF NOT EXISTS sim_laps_tyre_unread ON public.sim_laps(created_at, id) WHERE NOT tyre_read;

-- ---------------------------------------------------------------- the ingest, now with the tyre

-- The ingest as sim_lap_recorder.sql defined it, with `tyre_compound` stored beside the lap. A server that sends no `tyre_compound` key
-- at all (an older one, during a rollout) leaves the lap unread, so the backfill picks it up; a server that sends the key, even as
-- null, has looked at the header.
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
    plausible, plausibility, recorder, tyre_compound, tyre_read)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1),
    (p_lap->>'plausible')::boolean, p_lap->'plausibility',
    CASE WHEN jsonb_typeof(p_lap->'recorder') = 'object' THEN p_lap->'recorder' ELSE NULL END,
    nullif(p_lap->>'tyre_compound', ''), p_lap ? 'tyre_compound')
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

-- ---------------------------------------------------------------- the backfill queue

-- The next laps whose header has not been read for the tyre, oldest first, and how many are left in all.
CREATE OR REPLACE FUNCTION public.sim_tyre_unread_laps(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'storage_path', x.storage_path, 'format_version', x.format_version) ORDER BY x.created_at, x.id), '[]'::jsonb)
      FROM (SELECT id, storage_path, format_version, created_at FROM public.sim_laps WHERE NOT tyre_read ORDER BY created_at, id LIMIT p_limit) x),
    'remaining', (SELECT count(*) FROM public.sim_laps WHERE NOT tyre_read))
$$;

-- Records what the header said (null or empty: no compound). Only a lap not read yet is touched, so a lap that arrived meanwhile is left alone.
CREATE OR REPLACE FUNCTION public.sim_set_tyre(p_id uuid, p_tyre text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.sim_laps SET tyre_compound = nullif(p_tyre, ''), tyre_read = true WHERE id = p_id AND NOT tyre_read
$$;

-- ---------------------------------------------------------------- leaderboards

DROP FUNCTION IF EXISTS public.sim_leaderboard_me(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.sim_leaderboard(uuid, uuid, uuid, text, integer, timestamptz, uuid, integer);
DROP FUNCTION IF EXISTS public.sim_board(uuid, uuid, uuid, text);

-- Every lap a board can show, as p_viewer may see it: valid, plausible and not hidden laps of people whose profile is not hidden, on one
-- track and car (and one tyre when p_tyre is given). scope public: public profiles, not blocked either way. scope friends: the viewer and
-- their accepted friends (a private friend is left out). This is the one place that decides who is on a board: the ranking, the compounds
-- and the theoretical best all read it, so they cannot disagree.
CREATE FUNCTION public.sim_board_laps(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL)
RETURNS TABLE (lap_id uuid, user_id uuid, time_ms integer, started_at timestamptz, tyre_compound text, sector_ms integer[], handle text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id, l.user_id, l.time_ms, l.started_at, l.tyre_compound, l.sector_ms, p.handle, p.display_name
  FROM public.sim_laps l JOIN public.sim_profiles p ON p.user_id = l.user_id
  WHERE l.track_id = p_track AND l.car_id = p_car AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0 AND NOT p.hidden
    AND (p_tyre IS NULL OR l.tyre_compound = p_tyre)
    AND CASE p_scope
      WHEN 'public' THEN p.visibility = 'public' AND NOT EXISTS (
        SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'blocked')
      ELSE l.user_id = p_viewer OR (p.visibility <> 'private' AND EXISTS (
        SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'accepted'))
    END
$$;

-- Every driver's best lap on one track and car (and tyre), as p_viewer may see the board. Ranked by time (ties share a rank, the earlier
-- lap first); gap_ms is the distance to the leader.
CREATE FUNCTION public.sim_board(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL)
RETURNS TABLE (rank bigint, pos bigint, lap_id uuid, user_id uuid, time_ms integer, started_at timestamptz, gap_ms integer, handle text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH best AS (
    SELECT DISTINCT ON (l.user_id) l.user_id AS uid, l.lap_id AS lid, l.time_ms AS ms, l.started_at AS st, l.handle AS hd, l.display_name AS dn
    FROM public.sim_board_laps(p_viewer, p_track, p_car, p_scope, p_tyre) l
    ORDER BY l.user_id, l.time_ms, l.started_at, l.lap_id)
  SELECT rank() OVER (ORDER BY b.ms), row_number() OVER (ORDER BY b.ms, b.st, b.lid), b.lid, b.uid, b.ms, b.st,
         b.ms - min(b.ms) OVER (), b.hd, b.dn
  FROM best b
$$;

CREATE FUNCTION public.sim_leaderboard(
  p_viewer uuid, p_track uuid, p_car uuid, p_scope text,
  p_after_ms integer DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_lap uuid DEFAULT NULL, p_limit integer DEFAULT 51,
  p_tyre text DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.pos), '[]'::jsonb) FROM (
    SELECT b.pos, jsonb_build_object('rank', b.rank, 'lapId', b.lap_id, 'handle', b.handle, 'displayName', b.display_name, 'timeMs', b.time_ms,
      'gapMs', b.gap_ms, 'achievedAt', public.sim_iso(b.started_at), 'isMe', b.user_id = p_viewer,
      '_ms', b.time_ms, '_t', public.sim_iso_us(b.started_at), '_i', b.lap_id) AS item
    FROM public.sim_board(p_viewer, p_track, p_car, p_scope, p_tyre) b
    WHERE p_after_lap IS NULL OR (b.time_ms, b.started_at, b.lap_id) > (p_after_ms, p_after_t, p_after_lap)
    ORDER BY b.pos LIMIT p_limit) x
$$;

-- The caller's own rank on a board (and tyre) and the two drivers above and below them.
CREATE FUNCTION public.sim_leaderboard_me(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH b AS MATERIALIZED (SELECT * FROM public.sim_board(p_viewer, p_track, p_car, p_scope, p_tyre)),
       me AS (SELECT b.pos FROM b WHERE b.user_id = p_viewer),
       r AS (SELECT b.pos, jsonb_build_object('rank', b.rank, 'lapId', b.lap_id, 'handle', b.handle, 'displayName', b.display_name, 'timeMs', b.time_ms,
          'gapMs', b.gap_ms, 'achievedAt', public.sim_iso(b.started_at), 'isMe', b.user_id = p_viewer) AS item FROM b)
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM b),
    'me', (SELECT r.item FROM r WHERE r.pos = (SELECT me.pos FROM me)),
    'reason', CASE WHEN EXISTS (SELECT 1 FROM me) THEN NULL ELSE 'not_listed' END,
    'above', (SELECT coalesce(jsonb_agg(r.item ORDER BY r.pos), '[]'::jsonb) FROM r WHERE r.pos BETWEEN (SELECT me.pos FROM me) - 2 AND (SELECT me.pos FROM me) - 1),
    'below', (SELECT coalesce(jsonb_agg(r.item ORDER BY r.pos), '[]'::jsonb) FROM r WHERE r.pos BETWEEN (SELECT me.pos FROM me) + 1 AND (SELECT me.pos FROM me) + 2))
$$;

-- What a board is made of: the tyre compounds that have laps on it (with how many drivers, most first; laps without a compound are not
-- listed), and its theoretical best, the fastest of each sector and who drove it. The compounds always cover the whole board, so the
-- chips do not change while one is chosen; the theoretical best follows p_tyre. It reads the laps the board can show, every one of them
-- and not only each driver's best, because a driver's best sector often is not on their best lap. It is null unless every one of those laps
-- has the same number of sectors, at least two, all of them above zero: a board with a lap that has no sectors, or a different count,
-- would give a sum that is not a lap. Sectors are numbered from 1.
CREATE FUNCTION public.sim_leaderboard_conditions(p_viewer uuid, p_track uuid, p_car uuid, p_scope text, p_tyre text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH eligible AS MATERIALIZED (SELECT * FROM public.sim_board_laps(p_viewer, p_track, p_car, p_scope)),
       counted AS (SELECT * FROM eligible e WHERE p_tyre IS NULL OR e.tyre_compound = p_tyre),
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
    'sim_board_laps', 'sim_board', 'sim_leaderboard', 'sim_leaderboard_me', 'sim_leaderboard_conditions', 'sim_tyre_unread_laps', 'sim_set_tyre')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $grants$;
