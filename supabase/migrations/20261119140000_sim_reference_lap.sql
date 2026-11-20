-- The reference lap of a device's owner for one game, track and car (GET /api/sim/reference, phase 5 of plans/companion-dashboard-catalog.md).
-- Additive only: one new read-only function, no table or column changes, nothing is written.
--
-- p_kind 'personal': the owner's own fastest valid, plausible, not hidden lap.
-- p_kind 'best':     the leader of the public board as the owner sees it (public.sim_board, scope 'public': the same rules as the leaderboard,
--                    so a private, friends-only, hidden or blocked driver is never returned, and laps that are invalid, implausible or hidden
--                    are not on it), else the owner's own personal best.
-- The names are looked up through the alias tables, like public.sim_resolve_track / sim_resolve_car but WITHOUT creating anything: a name that
-- was never uploaded has no reference. Answers NULL when there is none, else
--   { kind, lapId, timeMs, recordedAt, driver, storagePath }
-- where kind is the kind of lap returned (a best that falls back to the personal best says 'personal') and driver is NULL for the owner's own lap,
-- else the display name (or handle) of the public driver.

CREATE FUNCTION public.sim_reference_lap(p_user uuid, p_game text, p_track text, p_car text, p_kind text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_track uuid; v_car uuid; v_lap uuid; v_ms integer; v_at timestamptz; v_owner uuid; v_name text; v_path text;
BEGIN
  SELECT a.track_id INTO v_track FROM public.sim_track_alias a
    WHERE a.game = p_game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(p_track), ''), 'unknown'), 160);
  SELECT a.car_id INTO v_car FROM public.sim_car_alias a
    WHERE a.game = p_game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(p_car), ''), 'unknown'), 160);
  IF v_track IS NULL OR v_car IS NULL THEN RETURN NULL; END IF;

  IF p_kind = 'best' THEN
    SELECT b.lap_id, b.time_ms, b.started_at, b.user_id, coalesce(b.display_name, b.handle)
      INTO v_lap, v_ms, v_at, v_owner, v_name
    FROM public.sim_board(p_user, v_track, v_car, 'public') b ORDER BY b.pos LIMIT 1;
    IF v_lap IS NOT NULL THEN
      SELECT l.storage_path INTO v_path FROM public.sim_laps l WHERE l.id = v_lap;
      RETURN jsonb_build_object('kind', 'best', 'lapId', v_lap, 'timeMs', v_ms, 'recordedAt', public.sim_iso(v_at),
        'driver', CASE WHEN v_owner = p_user THEN NULL ELSE v_name END, 'storagePath', v_path);
    END IF;
  END IF;

  SELECT l.id, l.time_ms, l.started_at, l.storage_path INTO v_lap, v_ms, v_at, v_path
  FROM public.sim_laps l
  WHERE l.user_id = p_user AND l.track_id = v_track AND l.car_id = v_car
    AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0
  ORDER BY l.time_ms, l.started_at, l.id LIMIT 1;
  IF v_lap IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('kind', 'personal', 'lapId', v_lap, 'timeMs', v_ms, 'recordedAt', public.sim_iso(v_at), 'driver', NULL, 'storagePath', v_path);
END $$;

-- Only the server: it resolves the device key first and passes the owner's id.
REVOKE ALL ON FUNCTION public.sim_reference_lap(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_reference_lap(uuid, text, text, text, text) TO service_role;
