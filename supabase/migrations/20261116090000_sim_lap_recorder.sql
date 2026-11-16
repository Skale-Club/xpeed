-- Which program and reader recorded a lap, and what its automatic data checks found.
--
-- The lap file header (version 2) may carry a `recorder` object ({app, version, build, source, gameBuild}) and a list of `checks` (ids of the
-- Companion's sanity checks the lap failed). The server stores both beside the lap, in one nullable jsonb column, so the laps of a bad
-- release can be told apart from the others:
--
--   recorder = {"app": "xpeed-companion", "version": "0.8.2", "build": "9900d41", "source": "acevo", "gameBuild": "0.9.1", "checks": ["t_repeats"]}
--
-- NULL for every lap that arrived before, and for a file that carries no recorder. Additive and idempotent: one new column, and the two
-- functions that touch it are replaced by the same bodies plus the column (sim_ingest_lap) or plus one key (sim_admin_lap).

ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS recorder jsonb;

-- The ingest as sim_social.sql defined it, with `recorder` stored beside the lap.
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
    plausible, plausibility, recorder)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1),
    (p_lap->>'plausible')::boolean, p_lap->'plausibility',
    CASE WHEN jsonb_typeof(p_lap->'recorder') = 'object' THEN p_lap->'recorder' ELSE NULL END)
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

-- What a moderator needs to judge a lap, now with who recorded it and the data checks it failed.
CREATE OR REPLACE FUNCTION public.sim_admin_lap(p_lap uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.sim_laps; p public.sim_profiles;
BEGIN
  SELECT * INTO l FROM public.sim_laps WHERE id = p_lap;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = l.user_id;
  RETURN jsonb_build_object(
    'lap', jsonb_build_object('id', l.id, 'game', l.game, 'track', l.track_name, 'car', l.car_name, 'lapNumber', l.lap_number, 'timeMs', l.time_ms, 'valid', l.valid,
      'startedAt', public.sim_iso(l.started_at), 'sectorsMs', to_jsonb(l.sector_ms), 'topSpeedKmh', l.top_speed_kmh, 'sampleCount', l.sample_count,
      'sizeBytes', l.size_bytes, 'formatVersion', l.format_version, 'createdAt', public.sim_iso(l.created_at), 'marked', l.marked,
      'plausible', l.plausible, 'plausibility', l.plausibility, 'hidden', l.hidden, 'recorder', l.recorder),
    'owner', CASE WHEN p.user_id IS NULL THEN NULL ELSE jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'visibility', p.visibility, 'hidden', p.hidden) END,
    'onLeaderboard', l.valid AND l.plausible IS TRUE AND NOT l.hidden AND coalesce(p.visibility = 'public' AND NOT p.hidden, false),
    'reports', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason, 'createdAt', public.sim_iso(r.created_at)) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM public.sim_reports r WHERE r.target_kind = 'lap' AND r.target_id = l.id));
END $$;
