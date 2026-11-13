-- Phase 1, part 1: links the laps that already exist to the new model. It only inserts catalog rows, sessions and personal
-- bests, and it fills the new columns of sim_laps (track_id, car_id, session_id, format_version); nothing else of an
-- existing row is touched. The function is idempotent, each step guards itself with "is still NULL", and a second run changes
-- nothing: it is safe to call again by hand (SELECT public.sim_backfill_platform();) after any partial run or deploy overlap.
--
-- Steps: 1) a catalog row and alias for every distinct (game, track name) and (game, car name) not yet linked; 2) link the laps;
-- 3) sessions: each unlinked lap, oldest first per person, game, track and car, joins the session it follows within 30 minutes or
-- starts one (the same rule new uploads use, and the one the site always used); 4) format version 1 for the old files;
-- 5) every session's counters from its laps; 6) the personal bests.

CREATE FUNCTION public.sim_backfill_platform() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r record;
  v_tracks integer := 0; v_cars integer := 0; v_sessions_before integer; v_sessions integer;
  v_linked_tracks integer; v_linked_cars integer; v_laps_in_sessions integer := 0; v_session uuid;
BEGIN
  SELECT count(*) INTO v_sessions_before FROM public.sim_sessions;

  -- 1) catalog rows (laps whose game is not a valid id stay unlinked: the reader never lets such a lap in)
  -- the first spelling an account's laps used (by arrival) becomes the display name, so a second run or another database agree
  FOR r IN SELECT l.game, l.track_name FROM public.sim_laps l
    WHERE l.track_id IS NULL AND l.game ~ '^[a-z][a-z0-9_]{0,31}$'
    GROUP BY l.game, l.track_name ORDER BY min(l.created_at), l.game, l.track_name LOOP
    PERFORM public.sim_resolve_track(r.game, r.track_name,
      (SELECT t.length_m FROM public.sim_tracks t WHERE t.game = r.game AND lower(btrim(t.track_name)) = lower(btrim(r.track_name)) ORDER BY t.updated_at DESC LIMIT 1));
    v_tracks := v_tracks + 1;
  END LOOP;
  FOR r IN SELECT l.game, l.car_name FROM public.sim_laps l
    WHERE l.car_id IS NULL AND l.game ~ '^[a-z][a-z0-9_]{0,31}$'
    GROUP BY l.game, l.car_name ORDER BY min(l.created_at), l.game, l.car_name LOOP
    PERFORM public.sim_resolve_car(r.game, r.car_name);
    v_cars := v_cars + 1;
  END LOOP;

  -- 2) link the laps through the aliases
  UPDATE public.sim_laps l SET track_id = a.track_id FROM public.sim_track_alias a
    WHERE l.track_id IS NULL AND a.game = l.game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(l.track_name), ''), 'unknown'), 160);
  GET DIAGNOSTICS v_linked_tracks = ROW_COUNT;
  UPDATE public.sim_laps l SET car_id = a.car_id FROM public.sim_car_alias a
    WHERE l.car_id IS NULL AND a.game = l.game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(l.car_name), ''), 'unknown'), 160);
  GET DIAGNOSTICS v_linked_cars = ROW_COUNT;

  -- 3) sessions, chronologically, through the same function the ingest uses (no advisory locks: this runs alone)
  FOR r IN SELECT l.id, l.user_id, l.game, l.track_id, l.car_id, l.started_at,
      l.started_at + l.time_ms * interval '1 millisecond' AS ended_at
    FROM public.sim_laps l
    WHERE l.session_id IS NULL AND l.track_id IS NOT NULL AND l.car_id IS NOT NULL
    ORDER BY l.user_id, l.game, l.track_id, l.car_id, l.started_at, l.lap_number, l.id LOOP
    v_session := public.sim_assign_session(r.user_id, r.game, r.track_id, r.car_id, r.started_at, r.ended_at, NULL, NULL, NULL, NULL, NULL, false);
    UPDATE public.sim_laps SET session_id = v_session WHERE id = r.id;
    v_laps_in_sessions := v_laps_in_sessions + 1;
  END LOOP;

  -- 4) every file written so far is version 1
  UPDATE public.sim_laps SET format_version = 1 WHERE format_version IS NULL;

  -- 5) counters of every session, from the laps it has
  FOR r IN SELECT id FROM public.sim_sessions LOOP
    PERFORM public.sim_refresh_session(r.id);
  END LOOP;

  -- 6) personal bests: the fastest valid lap per person, track and car (the earliest wins a tie)
  INSERT INTO public.sim_personal_bests(user_id, track_id, car_id, best_ms, lap_id, achieved_at)
  SELECT DISTINCT ON (l.user_id, l.track_id, l.car_id) l.user_id, l.track_id, l.car_id, l.time_ms, l.id, l.started_at
  FROM public.sim_laps l
  WHERE l.valid AND l.time_ms > 0 AND l.track_id IS NOT NULL AND l.car_id IS NOT NULL
  ORDER BY l.user_id, l.track_id, l.car_id, l.time_ms, l.started_at, l.id
  ON CONFLICT (user_id, track_id, car_id) DO UPDATE SET best_ms = EXCLUDED.best_ms, lap_id = EXCLUDED.lap_id, achieved_at = EXCLUDED.achieved_at
    WHERE (public.sim_personal_bests.best_ms, public.sim_personal_bests.lap_id, public.sim_personal_bests.achieved_at)
      IS DISTINCT FROM (EXCLUDED.best_ms, EXCLUDED.lap_id, EXCLUDED.achieved_at);

  SELECT count(*) INTO v_sessions FROM public.sim_sessions;
  RETURN jsonb_build_object('tracksResolved', v_tracks, 'carsResolved', v_cars, 'lapsLinkedToTracks', v_linked_tracks,
    'lapsLinkedToCars', v_linked_cars, 'lapsPlacedInSessions', v_laps_in_sessions, 'sessionsCreated', v_sessions - v_sessions_before);
END $$;

REVOKE ALL ON FUNCTION public.sim_backfill_platform() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_backfill_platform() TO service_role;

SELECT public.sim_backfill_platform();
