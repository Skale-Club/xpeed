-- Keep a lap's game, source track name and variant together. Titles are display text.
-- Historical rows lack variant evidence. Keep their ids, sessions and bests, and only
-- bind a legacy track to an exact variant-less layout when no named variant is known.
ALTER TABLE public.sim_track_catalog ADD COLUMN IF NOT EXISTS source_name text;
ALTER TABLE public.sim_track_catalog ADD COLUMN IF NOT EXISTS variant text;
ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS track_variant text;
ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS track_variant_known boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS sim_track_catalog_source_identity ON public.sim_track_catalog
  (game, lower(btrim(source_name)), coalesce(lower(btrim(variant)), '')) WHERE source_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS sim_laps_track_history ON public.sim_laps (track_id, user_id);

CREATE OR REPLACE FUNCTION public.sim_track_label(p_name text, p_variant text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_variant IS NULL OR public.sim_norm(p_name) = public.sim_norm(p_variant)
      OR (public.sim_norm(p_variant) <> '' AND right(public.sim_norm(p_name), char_length(public.sim_norm(p_variant)) + 1) = ' ' || public.sim_norm(p_variant))
      THEN left(p_name, 120)
    WHEN char_length(p_variant) >= 117 THEN left(p_variant, 120)
    ELSE left(p_name, 117 - char_length(p_variant)) || ' · ' || p_variant
  END
$$;

CREATE OR REPLACE FUNCTION public.sim_resolve_lap_track(
  p_game text, p_name text, p_variant text, p_length double precision, p_title text, p_variant_known boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Unknown');
  v_variant text := nullif(btrim(p_variant), '');
  v_length double precision := CASE WHEN p_length > 0 AND p_length <= 100000 THEN p_length END;
  v_title text := CASE WHEN char_length(btrim(p_title)) BETWEEN 1 AND 120 AND public.sim_norm(p_title) <> '' THEN btrim(p_title) END;
  v_alias text := left(coalesce(nullif(public.sim_norm(v_name), ''), 'unknown'), 160);
BEGIN
  -- A server from before the variant change still writes to its original alias.
  IF NOT p_variant_known THEN RETURN public.sim_resolve_track(p_game, p_name, p_length); END IF;

  -- Serialize adoption and creation for the same alias, even across accounts.
  PERFORM pg_advisory_xact_lock(hashtextextended('sim-track:' || p_game || ':' || v_alias, 0));
  SELECT c.id INTO v_id FROM public.sim_track_catalog c
    WHERE c.game = p_game AND lower(btrim(c.source_name)) = lower(v_name)
      AND coalesce(lower(btrim(c.variant)), '') = coalesce(lower(v_variant), '');

  IF v_id IS NULL AND v_variant IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.sim_track_alias a WHERE a.game = p_game AND a.alias_norm = v_alias) THEN
      PERFORM public.sim_resolve_track(p_game, v_name, v_length);
    END IF;
    -- An old row can contain different layouts because the legacy ingest discarded
    -- their variants. Adopt only an empty row or one with proven default laps.
    UPDATE public.sim_track_catalog c SET source_name = v_name
      FROM public.sim_track_alias a
      WHERE a.game = p_game AND a.alias_norm = v_alias AND a.track_id = c.id AND c.source_name IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.sim_laps l WHERE l.track_id = c.id
          AND (NOT l.track_variant_known OR l.track_variant IS NOT NULL OR lower(btrim(l.track_name)) <> lower(v_name)))
        AND NOT EXISTS (SELECT 1 FROM public.sim_track_catalog other WHERE other.game = p_game
          AND lower(btrim(other.source_name)) = lower(v_name) AND other.variant IS NOT NULL)
      RETURNING c.id INTO v_id;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.sim_track_catalog(game, slug, name, length_m, source_name, variant)
      VALUES (p_game, 'source-' || gen_random_uuid()::text, public.sim_track_label(coalesce(v_title, v_name), v_variant), v_length, v_name, v_variant)
      RETURNING id INTO v_id;
  ELSE
    UPDATE public.sim_track_catalog c SET
      length_m = coalesce(c.length_m, v_length),
      name = CASE WHEN v_title IS NOT NULL AND c.name = public.sim_track_label(c.source_name, c.variant)
        THEN public.sim_track_label(v_title, c.variant) ELSE c.name END
      WHERE c.id = v_id AND (c.length_m IS NULL AND v_length IS NOT NULL
        OR v_title IS NOT NULL AND c.name = public.sim_track_label(c.source_name, c.variant)
          AND c.name <> public.sim_track_label(v_title, c.variant));
  END IF;
  RETURN v_id;
END $$;

-- Reference requests carry the same game, raw track name and variant as uploads.
-- The file reader verifies legacy headers, whose stored rows cannot prove a variant.
CREATE OR REPLACE FUNCTION public.sim_reference_lap(
  p_user uuid, p_game text, p_track text, p_car text, p_kind text, p_variant text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_track uuid; v_car uuid; v_lap uuid; v_ms integer; v_at timestamptz; v_owner uuid; v_name text; v_path text;
  v_raw text := lower(btrim(p_track));
  v_variant text := coalesce(lower(btrim(p_variant)), '');
BEGIN
  SELECT c.id INTO v_track FROM public.sim_track_catalog c
  WHERE c.game = p_game AND lower(btrim(c.source_name)) = v_raw
    AND coalesce(lower(btrim(c.variant)), '') = v_variant;
  IF v_track IS NULL AND v_variant = '' THEN
    SELECT c.id INTO v_track FROM public.sim_track_alias a
    JOIN public.sim_track_catalog c ON c.id = a.track_id AND c.source_name IS NULL
    WHERE a.game = p_game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(p_track), ''), 'unknown'), 160);
  END IF;
  SELECT a.car_id INTO v_car FROM public.sim_car_alias a
    WHERE a.game = p_game AND a.alias_norm = left(coalesce(nullif(public.sim_norm(p_car), ''), 'unknown'), 160);
  IF v_track IS NULL OR v_car IS NULL THEN RETURN NULL; END IF;

  IF p_kind = 'best' THEN
    SELECT b.lap_id, b.time_ms, b.started_at, b.user_id, coalesce(b.display_name, b.handle), l.storage_path
      INTO v_lap, v_ms, v_at, v_owner, v_name, v_path
    FROM public.sim_board_laps(p_user, v_track, v_car, 'public') b
    JOIN public.sim_laps l ON l.id = b.lap_id
    WHERE lower(btrim(l.track_name)) = v_raw AND lower(btrim(l.car_name)) = lower(btrim(p_car))
      AND coalesce(lower(btrim(l.track_variant)), '') = v_variant
    ORDER BY b.time_ms, b.started_at, b.lap_id LIMIT 1;
    IF v_lap IS NOT NULL THEN
      RETURN jsonb_build_object('kind', 'best', 'lapId', v_lap, 'timeMs', v_ms, 'recordedAt', public.sim_iso(v_at),
        'driver', CASE WHEN v_owner = p_user THEN NULL ELSE v_name END, 'storagePath', v_path);
    END IF;
  END IF;

  SELECT l.id, l.time_ms, l.started_at, l.storage_path INTO v_lap, v_ms, v_at, v_path
  FROM public.sim_laps l
  WHERE l.user_id = p_user AND l.track_id = v_track AND l.car_id = v_car
    AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0
    AND lower(btrim(l.track_name)) = v_raw AND lower(btrim(l.car_name)) = lower(btrim(p_car))
    AND coalesce(lower(btrim(l.track_variant)), '') = v_variant
  ORDER BY l.time_ms, l.started_at, l.id LIMIT 1;
  IF v_lap IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('kind', 'personal', 'lapId', v_lap, 'timeMs', v_ms, 'recordedAt', public.sim_iso(v_at), 'driver', NULL, 'storagePath', v_path);
END $$;

CREATE OR REPLACE FUNCTION public.sim_reference_lap(p_user uuid, p_game text, p_track text, p_car text, p_kind text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.sim_reference_lap(p_user, p_game, p_track, p_car, p_kind, NULL)
$$;

REVOKE ALL ON FUNCTION public.sim_reference_lap(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_reference_lap(uuid, text, text, text, text, text) TO service_role;

-- Bind by UUID before looking at storage. A display title is never a storage key.
-- Existing rows have one raw name only if every lap in the account agrees.
CREATE OR REPLACE FUNCTION public.sim_layout_binding(p_user uuid, p_track uuid)
RETURNS TABLE (id uuid, updated_at timestamptz, source_name text) LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH t AS (
    SELECT c.id, c.game, c.variant, c.source_name,
      CASE WHEN c.game = 'rfactor1' THEN 'sce' ELSE c.game END AS layout_game
    FROM public.sim_track_catalog c WHERE c.id = p_track
  ), history AS (
    SELECT min(lower(btrim(l.track_name))) AS raw_name, count(DISTINCT lower(btrim(l.track_name))) AS names,
      coalesce(bool_or(NOT l.track_variant_known), false) AS unknown_variant
    FROM public.sim_laps l WHERE l.user_id = p_user AND l.track_id = p_track
  ), identity AS (
    SELECT t.*, coalesce(lower(btrim(t.source_name)), h.raw_name) AS raw_name, h.unknown_variant
    FROM t CROSS JOIN history h
    WHERE h.names <= 1 AND (t.source_name IS NOT NULL OR h.names = 1)
      AND (t.source_name IS NULL OR h.names = 0 OR lower(btrim(t.source_name)) = h.raw_name)
  )
  SELECT s.id, s.updated_at, s.track_name FROM identity i JOIN public.sim_tracks s ON s.user_id = p_user
    AND s.game = i.layout_game AND lower(btrim(s.track_name)) = i.raw_name
    AND coalesce(lower(btrim(s.variant)), '') = coalesce(lower(btrim(i.variant)), '')
  WHERE NOT i.unknown_variant OR NOT EXISTS (
    SELECT 1 FROM public.sim_tracks other
    WHERE other.user_id = p_user AND other.game = i.layout_game AND lower(btrim(other.track_name)) = i.raw_name AND nullif(btrim(other.variant), '') IS NOT NULL
    UNION ALL
    SELECT 1 FROM public.sim_track_catalog other
    WHERE other.game = i.game AND lower(btrim(other.source_name)) = i.raw_name AND other.variant IS NOT NULL
  )
  ORDER BY s.updated_at DESC, s.id LIMIT 1
$$;

-- The old name-based signature remains available to older callers. The name
-- can only select a unique catalog row, then its UUID decides the layout.
CREATE OR REPLACE FUNCTION public.sim_layout_id(p_user uuid, p_game text, p_name text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH candidates AS (
    SELECT c.id FROM public.sim_track_catalog c
      WHERE c.game = p_game AND (lower(btrim(c.name)) = lower(btrim(p_name)) OR lower(btrim(c.source_name)) = lower(btrim(p_name)))
    UNION
    SELECT a.track_id FROM public.sim_track_alias a
      WHERE a.game = p_game AND a.alias_norm = left(public.sim_norm(p_name), 160)
  ), unique_track AS (SELECT (array_agg(cid.id))[1] AS id FROM candidates cid HAVING count(*) = 1)
  SELECT l.id FROM unique_track t CROSS JOIN LATERAL public.sim_layout_binding(p_user, t.id) l
$$;

REVOKE ALL ON FUNCTION public.sim_resolve_lap_track(text, text, text, double precision, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_resolve_lap_track(text, text, text, double precision, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.sim_layout_binding(uuid, uuid), public.sim_layout_id(uuid, text, text), public.sim_track_label(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sim_layout_binding(uuid, uuid), public.sim_layout_id(uuid, text, text), public.sim_track_label(text, text) TO authenticated, service_role;


-- The catalog id flows through the existing session and best-lap transactions.
CREATE OR REPLACE FUNCTION public.sim_ingest_lap(p_user_id uuid, p_device_id uuid, p_lap jsonb, p_max_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_admission jsonb; v_track uuid; v_car uuid; v_session uuid; v_id uuid;
  v_started timestamptz := (p_lap->>'started_at')::timestamptz;
  v_ms integer := (p_lap->>'time_ms')::integer;
  v_sectors integer[];
  v_variant text := nullif(btrim(p_lap->>'track_variant'), '');
  v_car_title text := btrim(p_lap->>'car_title');
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || p_user_id::text, 0));
  v_admission := public.sim_lap_admission(p_user_id, p_lap->>'identity', (p_lap->>'size_bytes')::integer, p_max_bytes);
  IF v_admission->>'status' <> 'ok' THEN RETURN v_admission; END IF;

  PERFORM public.sim_ensure_profile(p_user_id);
  v_track := public.sim_resolve_lap_track(p_lap->>'game', p_lap->>'track_name', v_variant,
    (p_lap->>'track_length_m')::double precision, p_lap->>'track_title', p_lap ? 'track_variant');
  v_car := public.sim_resolve_car(p_lap->>'game', p_lap->>'car_name', p_lap->>'car_class');
  IF char_length(v_car_title) BETWEEN 1 AND 120 AND public.sim_norm(v_car_title) <> '' THEN
    UPDATE public.sim_car_catalog SET name = v_car_title
    WHERE id = v_car AND public.sim_norm(name) = public.sim_norm(p_lap->>'car_name') AND name <> v_car_title;
  END IF;
  v_session := public.sim_assign_session(p_user_id, p_lap->>'game', v_track, v_car, v_started, v_started + v_ms * interval '1 millisecond',
    nullif(p_lap->>'session_id', ''), p_lap->>'session_kind', p_lap->>'weather',
    (p_lap->>'air_temp_c')::real, (p_lap->>'track_temp_c')::real);
  IF jsonb_typeof(p_lap->'sector_ms') = 'array' THEN
    SELECT array_agg(x.value::integer ORDER BY x.ord) INTO v_sectors FROM jsonb_array_elements_text(p_lap->'sector_ms') WITH ORDINALITY AS x(value, ord);
  END IF;

  INSERT INTO public.sim_laps(user_id, device_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at,
    sample_count, size_bytes, storage_path, track_id, car_id, session_id, sector_ms, top_speed_kmh, fuel_used_l, in_lap, out_lap, format_version,
    plausible, plausibility, recorder, tyre_compound, tyre_read, aids, aid_class, track_variant, track_variant_known)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1),
    (p_lap->>'plausible')::boolean, p_lap->'plausibility',
    CASE WHEN jsonb_typeof(p_lap->'recorder') = 'object' THEN p_lap->'recorder' ELSE NULL END,
    nullif(p_lap->>'tyre_compound', ''), p_lap ? 'tyre_compound',
    CASE WHEN jsonb_typeof(p_lap->'aids') = 'object' THEN p_lap->'aids' ELSE NULL END,
    CASE WHEN p_lap->>'aid_class' IN ('none', 'no_tc_abs', 'any') THEN p_lap->>'aid_class' ELSE 'unknown' END,
    v_variant, p_lap ? 'track_variant')
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

CREATE OR REPLACE FUNCTION public.sim_track_identity_json(p_track public.sim_track_catalog, p_layout_source text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_track.source_name IS NOT NULL THEN jsonb_build_object('sourceName', p_track.source_name, 'variant', p_track.variant)
    WHEN p_layout_source IS NOT NULL THEN jsonb_build_object('sourceName', p_layout_source)
    ELSE '{}'::jsonb END
$$;

REVOKE ALL ON FUNCTION public.sim_track_identity_json(public.sim_track_catalog, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sim_track_identity_json(public.sim_track_catalog, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sim_lap_json(l public.sim_laps, p_track text, p_car text, p_device text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'game', l.game,
    'track', CASE WHEN l.track_id IS NULL THEN NULL ELSE jsonb_build_object('id', l.track_id, 'name', coalesce(p_track, l.track_name), 'sourceName', l.track_name)
      || CASE WHEN l.track_variant_known THEN jsonb_build_object('variant', l.track_variant) ELSE '{}'::jsonb END END,
    'car', CASE WHEN l.car_id IS NULL THEN NULL ELSE jsonb_build_object('id', l.car_id, 'name', coalesce(p_car, l.car_name), 'sourceName', l.car_name) END,
    'sessionId', l.session_id, 'lapNumber', l.lap_number, 'timeMs', l.time_ms, 'valid', l.valid,
    'startedAt', public.sim_iso(l.started_at), 'sectorsMs', to_jsonb(l.sector_ms),
    'topSpeedKmh', l.top_speed_kmh, 'fuelUsedL', l.fuel_used_l, 'inLap', l.in_lap, 'outLap', l.out_lap,
    'sampleCount', l.sample_count, 'sizeBytes', l.size_bytes, 'reduced', coalesce(l.reduced, false),
    'formatVersion', l.format_version, 'createdAt', public.sim_iso(l.created_at), 'deviceName', p_device)
$$;

CREATE OR REPLACE FUNCTION public.sim_v1_tracks(
  p_game text DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(y.j ORDER BY y.last_driven DESC, y.id DESC) FROM (
    SELECT t.id, a.last_driven,
      jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m, 'hasLayout', lay.id IS NOT NULL, 'layoutId', lay.id,
        'layoutUpdatedAt', public.sim_iso_us(lay.updated_at),
        'lapCount', a.laps, 'validLapCount', a.valid_laps, 'sessionCount', a.sessions, 'carCount', a.cars, 'bestLapMs', a.best,
        'lastDrivenAt', public.sim_iso(a.last_driven), '_k', public.sim_iso_us(a.last_driven), '_i', t.id) || public.sim_track_identity_json(t, lay.source_name) AS j
    FROM (
      SELECT l.track_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps,
        count(DISTINCT l.session_id) AS sessions, count(DISTINCT l.car_id) AS cars,
        min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0) AS best, max(l.started_at) AS last_driven
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id IS NOT NULL GROUP BY l.track_id
    ) a JOIN public.sim_track_catalog t ON t.id = a.track_id
    LEFT JOIN LATERAL public.sim_layout_binding(v_user, t.id) lay ON true
    WHERE (p_game IS NULL OR t.game = p_game) AND (p_after_t IS NULL OR (a.last_driven, t.id) < (p_after_t, p_after_id))
    ORDER BY a.last_driven DESC, t.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) y), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.sim_v1_track(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id(); t public.sim_track_catalog; v_layout uuid; v_layout_at timestamptz; v_layout_source text;
BEGIN
  SELECT * INTO t FROM public.sim_track_catalog WHERE id = p_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT lay.id, lay.updated_at, lay.source_name INTO v_layout, v_layout_at, v_layout_source FROM public.sim_layout_binding(v_user, t.id) lay;
  RETURN jsonb_build_object(
    'track', jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m, 'hasLayout', v_layout IS NOT NULL, 'layoutId', v_layout,
      'layoutUpdatedAt', public.sim_iso_us(v_layout_at)) || public.sim_track_identity_json(t, v_layout_source),
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

CREATE OR REPLACE FUNCTION public.sim_v1_pbs(
  p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL,
  p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((
    WITH page AS MATERIALIZED (
      SELECT b.track_id, b.car_id, b.best_ms, b.lap_id, b.achieved_at, t.game, t.name AS track_name, c.name AS car_name,
        l.track_name AS track_source, l.car_name AS car_source, l.track_variant, l.track_variant_known
      FROM public.sim_personal_bests b
      JOIN public.sim_track_catalog t ON t.id = b.track_id
      JOIN public.sim_car_catalog c ON c.id = b.car_id
      JOIN public.sim_laps l ON l.id = b.lap_id AND l.user_id = b.user_id
      WHERE b.user_id = v_user
        AND (p_game IS NULL OR t.game = p_game) AND (p_track IS NULL OR b.track_id = p_track) AND (p_car IS NULL OR b.car_id = p_car)
        AND (p_after_t IS NULL OR (b.achieved_at, b.lap_id) < (p_after_t, p_after_id))
      ORDER BY b.achieved_at DESC, b.lap_id DESC LIMIT least(greatest(p_limit, 1), 101)
    ), sectors AS (
      SELECT * FROM public.sim_sector_bests(v_user, ARRAY(SELECT pg.track_id FROM page pg), ARRAY(SELECT pg.car_id FROM page pg))
    )
    SELECT jsonb_agg(
      jsonb_build_object('game', p.game, 'track', jsonb_build_object('id', p.track_id, 'name', p.track_name, 'sourceName', p.track_source)
          || CASE WHEN p.track_variant_known THEN jsonb_build_object('variant', p.track_variant) ELSE '{}'::jsonb END,
        'car', jsonb_build_object('id', p.car_id, 'name', p.car_name, 'sourceName', p.car_source),
        'bestMs', p.best_ms, 'lapId', p.lap_id, 'achievedAt', public.sim_iso(p.achieved_at),
        'bestSectorsMs', s.best_sectors, 'sectorLapIds', s.sector_lap_ids,
        'previousBestMs', pv.ms, 'improvedByMs', pv.ms - p.best_ms,
        '_k', public.sim_iso_us(p.achieved_at), '_i', p.lap_id)
      ORDER BY p.achieved_at DESC, p.lap_id DESC)
    FROM page p LEFT JOIN sectors s ON s.track_id = p.track_id AND s.car_id = p.car_id
    LEFT JOIN LATERAL (SELECT public.sim_previous_best(v_user, p.track_id, p.car_id, p.lap_id, p.achieved_at, p.best_ms) AS ms) pv ON true
  ), '[]'::jsonb);
END $$;
