-- Phase 1, part 1 of the racing data model (docs/platform/PHASE-1-DATA-MODEL.md): track, car and session become real
-- entities, laps are linked to them, personal bests are kept by the database, and the read side (API v1) has the
-- functions it pages through. Everything here is additive: new tables, new nullable columns on sim_laps, new indexes and
-- functions. No existing row is dropped or rewritten; the next migration fills the new columns of the rows that exist.
--
-- Who may do what: the server (service role) writes everything. A signed-in person reads only their own sessions,
-- personal bests and laps; the catalogs (tracks, cars and their aliases) are readable by any signed-in person.
-- The sim_v1_* functions run as the caller (SECURITY INVOKER), so row level security decides what each one returns.

-- ---------------------------------------------------------------- normalization

-- lower case, accents removed, anything that is not a letter or a digit collapsed to one space, trimmed. Letters of other
-- scripts (Greek, Cyrillic, kana, CJK, Hangul) are kept, so a track named in Japanese does not collapse to an empty string.
CREATE FUNCTION public.sim_norm(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT btrim(regexp_replace(
    translate(lower(coalesce(p_text, '')),
      'àÀáÁâÂãÃäÄåÅāĀăĂąĄçÇćĆčČďĎđĐèÈéÉêÊëËēĒěĚęĘğĞìÌíÍîÎïÏīĪıłŁľĽñÑńŃňŇòÒóÓôÔõÕöÖøØōŌőŐřŘŕŔśŚşŞšŠťŤţŢùÙúÚûÛüÜūŪůŮűŰýÝÿŸžŽźŹżŻİ',
      'aaaaaaaaaaaaaaaaaaccccccddddeeeeeeeeeeeeeeggiiiiiiiiiiillllnnnnnnoooooooooooooooorrrrssssssttttuuuuuuuuuuuuuuyyyyzzzzzzi'),
    '[^a-z0-9Ͱ-ԯ぀-ヿ一-鿿가-힯]+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------- the catalogs

CREATE TABLE public.sim_track_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL CHECK (game ~ '^[a-z][a-z0-9_]{0,31}$'),
  slug text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 160),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  length_m double precision CHECK (length_m IS NULL OR (length_m > 0 AND length_m <= 100000)),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game, slug)
);

-- Every spelling a game or a Companion version has sent. Two catalog rows are merged by pointing an alias at the other.
CREATE TABLE public.sim_track_alias (
  game text NOT NULL CHECK (game ~ '^[a-z][a-z0-9_]{0,31}$'),
  alias_norm text NOT NULL CHECK (char_length(alias_norm) BETWEEN 1 AND 160),
  track_id uuid NOT NULL REFERENCES public.sim_track_catalog(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, alias_norm)
);
CREATE INDEX sim_track_alias_track ON public.sim_track_alias(track_id);

CREATE TABLE public.sim_car_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL CHECK (game ~ '^[a-z][a-z0-9_]{0,31}$'),
  slug text NOT NULL CHECK (char_length(slug) BETWEEN 1 AND 160),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  brand text CHECK (char_length(brand) BETWEEN 1 AND 60),
  class text CHECK (char_length(class) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game, slug)
);

CREATE TABLE public.sim_car_alias (
  game text NOT NULL CHECK (game ~ '^[a-z][a-z0-9_]{0,31}$'),
  alias_norm text NOT NULL CHECK (char_length(alias_norm) BETWEEN 1 AND 160),
  car_id uuid NOT NULL REFERENCES public.sim_car_catalog(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, alias_norm)
);
CREATE INDEX sim_car_alias_car ON public.sim_car_alias(car_id);

-- ---------------------------------------------------------------- sessions and personal bests

-- A session is one stretch of driving of one car on one track. The Companion names it (companion_session_id, from the lap
-- header); when it does not, the server infers it: same game, track and car, and a break of at most 30 minutes between laps.
CREATE TABLE public.sim_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  game text NOT NULL CHECK (game ~ '^[a-z][a-z0-9_]{0,31}$'),
  track_id uuid NOT NULL REFERENCES public.sim_track_catalog(id),
  car_id uuid NOT NULL REFERENCES public.sim_car_catalog(id),
  kind text NOT NULL DEFAULT 'unknown' CHECK (kind IN ('practice', 'qualifying', 'race', 'unknown')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  weather text CHECK (char_length(weather) BETWEEN 1 AND 40),
  air_temp_c real CHECK (air_temp_c BETWEEN -100 AND 200),
  track_temp_c real CHECK (track_temp_c BETWEEN -100 AND 200),
  lap_count integer NOT NULL DEFAULT 0 CHECK (lap_count >= 0),
  best_lap_ms integer,
  origin text NOT NULL CHECK (origin IN ('companion', 'inferred')),
  companion_session_id text CHECK (char_length(companion_session_id) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at)
);
CREATE INDEX sim_sessions_user_started ON public.sim_sessions(user_id, started_at DESC, id DESC);
CREATE INDEX sim_sessions_user_driving ON public.sim_sessions(user_id, game, track_id, car_id, ended_at DESC);
CREATE UNIQUE INDEX sim_sessions_companion ON public.sim_sessions(user_id, companion_session_id, track_id, car_id)
  WHERE companion_session_id IS NOT NULL;

-- One row per person, track and car: the fastest valid lap. Kept by the triggers on sim_laps.
CREATE TABLE public.sim_personal_bests (
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  track_id uuid NOT NULL REFERENCES public.sim_track_catalog(id),
  car_id uuid NOT NULL REFERENCES public.sim_car_catalog(id),
  best_ms integer NOT NULL CHECK (best_ms > 0),
  lap_id uuid NOT NULL REFERENCES public.sim_laps(id) ON DELETE CASCADE,
  achieved_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, track_id, car_id)
);
CREATE INDEX sim_personal_bests_user_achieved ON public.sim_personal_bests(user_id, achieved_at DESC, lap_id DESC);
CREATE INDEX sim_personal_bests_lap ON public.sim_personal_bests(lap_id);

-- A per-key counter in fixed windows, so a rate limit survives a restart and is shared by every server instance.
CREATE TABLE public.sim_rate (
  key text NOT NULL CHECK (char_length(key) <= 120),
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------- what a lap now knows about itself

ALTER TABLE public.sim_laps
  ADD COLUMN track_id uuid REFERENCES public.sim_track_catalog(id),
  ADD COLUMN car_id uuid REFERENCES public.sim_car_catalog(id),
  ADD COLUMN session_id uuid REFERENCES public.sim_sessions(id) ON DELETE SET NULL,
  ADD COLUMN sector_ms integer[] CHECK (sector_ms IS NULL OR cardinality(sector_ms) <= 8),
  ADD COLUMN top_speed_kmh real CHECK (top_speed_kmh IS NULL OR (top_speed_kmh >= 0 AND top_speed_kmh <= 2000)),
  ADD COLUMN fuel_used_l real CHECK (fuel_used_l IS NULL OR (fuel_used_l >= 0 AND fuel_used_l <= 1000)),
  ADD COLUMN in_lap boolean,
  ADD COLUMN out_lap boolean,
  ADD COLUMN format_version smallint,
  ADD COLUMN reduced boolean DEFAULT false;

-- The strings the reader already limits are limited here too, for the rows that arrive from now on.
ALTER TABLE public.sim_laps
  ADD CONSTRAINT sim_laps_game_len CHECK (char_length(game) BETWEEN 1 AND 32) NOT VALID,
  ADD CONSTRAINT sim_laps_track_name_len CHECK (char_length(track_name) BETWEEN 1 AND 120) NOT VALID,
  ADD CONSTRAINT sim_laps_car_name_len CHECK (char_length(car_name) BETWEEN 1 AND 120) NOT VALID,
  ADD CONSTRAINT sim_laps_storage_path_len CHECK (char_length(storage_path) <= 300) NOT VALID;

CREATE INDEX sim_laps_user_driving ON public.sim_laps(user_id, game, track_id, car_id, valid, time_ms);
CREATE INDEX sim_laps_user_session ON public.sim_laps(user_id, session_id);
CREATE INDEX sim_laps_session ON public.sim_laps(session_id);
CREATE INDEX sim_laps_user_started_id ON public.sim_laps(user_id, started_at DESC, id DESC);
CREATE INDEX sim_laps_user_created ON public.sim_laps(user_id, created_at DESC, id DESC);
-- The bytes an account keeps are summed on every upload: an index-only scan.
CREATE INDEX sim_laps_user_size ON public.sim_laps(user_id) INCLUDE (size_bytes);

-- ---------------------------------------------------------------- access

ALTER TABLE public.sim_track_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_track_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_car_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_car_alias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_personal_bests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_rate ENABLE ROW LEVEL SECURITY;

CREATE POLICY read_sim_track_catalog ON public.sim_track_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY read_sim_track_alias ON public.sim_track_alias FOR SELECT TO authenticated USING (true);
CREATE POLICY read_sim_car_catalog ON public.sim_car_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY read_sim_car_alias ON public.sim_car_alias FOR SELECT TO authenticated USING (true);
CREATE POLICY own_sim_sessions ON public.sim_sessions FOR SELECT TO authenticated USING (user_id = public.current_app_user_id());
CREATE POLICY own_sim_personal_bests ON public.sim_personal_bests FOR SELECT TO authenticated USING (user_id = public.current_app_user_id());

REVOKE ALL ON public.sim_track_catalog, public.sim_track_alias, public.sim_car_catalog, public.sim_car_alias,
  public.sim_sessions, public.sim_personal_bests, public.sim_rate FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sim_track_catalog, public.sim_track_alias, public.sim_car_catalog, public.sim_car_alias,
  public.sim_sessions, public.sim_personal_bests TO authenticated;
GRANT ALL ON public.sim_track_catalog, public.sim_track_alias, public.sim_car_catalog, public.sim_car_alias,
  public.sim_sessions, public.sim_personal_bests, public.sim_rate TO service_role;
-- sim_laps keeps its own policy and its table-level SELECT: the new columns are the person's own too.

-- ---------------------------------------------------------------- resolving names

-- The catalog row of a track, found by alias or created (with its alias) on the fly: a new game or a new spelling never blocks an upload.
CREATE FUNCTION public.sim_resolve_track(p_game text, p_name text, p_length_m double precision DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_norm text := left(coalesce(nullif(public.sim_norm(p_name), ''), 'unknown'), 160); v_id uuid; v_slug text;
BEGIN
  SELECT track_id INTO v_id FROM public.sim_track_alias WHERE game = p_game AND alias_norm = v_norm;
  IF v_id IS NOT NULL THEN
    IF p_length_m IS NOT NULL AND p_length_m > 0 AND p_length_m <= 100000 THEN
      UPDATE public.sim_track_catalog SET length_m = p_length_m WHERE id = v_id AND length_m IS NULL;
    END IF;
    RETURN v_id;
  END IF;
  v_slug := replace(v_norm, ' ', '-');
  INSERT INTO public.sim_track_catalog(game, slug, name, length_m)
  VALUES (p_game, v_slug, left(coalesce(nullif(btrim(p_name), ''), 'Unknown'), 120), CASE WHEN p_length_m > 0 AND p_length_m <= 100000 THEN p_length_m END)
  ON CONFLICT (game, slug) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM public.sim_track_catalog WHERE game = p_game AND slug = v_slug; END IF;
  INSERT INTO public.sim_track_alias(game, alias_norm, track_id) VALUES (p_game, v_norm, v_id) ON CONFLICT (game, alias_norm) DO NOTHING;
  SELECT track_id INTO v_id FROM public.sim_track_alias WHERE game = p_game AND alias_norm = v_norm;
  RETURN v_id;
END $$;

CREATE FUNCTION public.sim_resolve_car(p_game text, p_name text, p_class text DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_norm text := left(coalesce(nullif(public.sim_norm(p_name), ''), 'unknown'), 160); v_id uuid; v_slug text; v_class text := left(nullif(btrim(coalesce(p_class, '')), ''), 60);
BEGIN
  SELECT car_id INTO v_id FROM public.sim_car_alias WHERE game = p_game AND alias_norm = v_norm;
  IF v_id IS NOT NULL THEN
    IF v_class IS NOT NULL THEN UPDATE public.sim_car_catalog SET class = v_class WHERE id = v_id AND class IS NULL; END IF;
    RETURN v_id;
  END IF;
  v_slug := replace(v_norm, ' ', '-');
  INSERT INTO public.sim_car_catalog(game, slug, name, class)
  VALUES (p_game, v_slug, left(coalesce(nullif(btrim(p_name), ''), 'Unknown'), 120), v_class)
  ON CONFLICT (game, slug) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN SELECT id INTO v_id FROM public.sim_car_catalog WHERE game = p_game AND slug = v_slug; END IF;
  INSERT INTO public.sim_car_alias(game, alias_norm, car_id) VALUES (p_game, v_norm, v_id) ON CONFLICT (game, alias_norm) DO NOTHING;
  SELECT car_id INTO v_id FROM public.sim_car_alias WHERE game = p_game AND alias_norm = v_norm;
  RETURN v_id;
END $$;

-- ---------------------------------------------------------------- sessions

-- The session a lap belongs to. The Companion's own id wins; otherwise the lap joins the session of the same person, game,
-- track and car whose laps it follows within 30 minutes (the rule the site always used: break counted from the end of a lap to
-- the start of the next), else it starts a new inferred one. The session's span grows to cover the lap. p_lock serializes one
-- person's ingests (the migration passes false: it already runs alone, and thousands of advisory locks would fill the lock table).
CREATE FUNCTION public.sim_assign_session(
  p_user_id uuid, p_game text, p_track_id uuid, p_car_id uuid, p_started_at timestamptz, p_ended_at timestamptz,
  p_companion_id text DEFAULT NULL, p_kind text DEFAULT NULL, p_weather text DEFAULT NULL,
  p_air_temp_c real DEFAULT NULL, p_track_temp_c real DEFAULT NULL, p_lock boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_kind text := CASE WHEN p_kind IN ('practice', 'qualifying', 'race') THEN p_kind ELSE 'unknown' END;
  v_weather text := left(nullif(btrim(coalesce(p_weather, '')), ''), 40);
  v_origin text := CASE WHEN nullif(p_companion_id, '') IS NULL THEN 'inferred' ELSE 'companion' END;
BEGIN
  IF p_lock THEN PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || p_user_id::text, 0)); END IF;
  IF v_origin = 'companion' THEN
    SELECT id INTO v_id FROM public.sim_sessions
      WHERE user_id = p_user_id AND companion_session_id = p_companion_id AND track_id = p_track_id AND car_id = p_car_id;
  ELSE
    SELECT id INTO v_id FROM public.sim_sessions
      WHERE user_id = p_user_id AND game = p_game AND track_id = p_track_id AND car_id = p_car_id AND origin = 'inferred'
        AND p_started_at - ended_at <= interval '30 minutes' AND started_at - p_ended_at <= interval '30 minutes'
      ORDER BY abs(extract(epoch FROM (p_started_at - ended_at))) LIMIT 1;
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.sim_sessions(user_id, game, track_id, car_id, kind, started_at, ended_at, weather, air_temp_c, track_temp_c, origin, companion_session_id)
    VALUES (p_user_id, p_game, p_track_id, p_car_id, v_kind, p_started_at, greatest(p_ended_at, p_started_at), v_weather, p_air_temp_c, p_track_temp_c, v_origin, nullif(p_companion_id, ''))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.sim_sessions SET
      started_at = least(started_at, p_started_at),
      ended_at = greatest(ended_at, p_ended_at, p_started_at),
      kind = CASE WHEN kind = 'unknown' THEN v_kind ELSE kind END,
      weather = coalesce(weather, v_weather),
      air_temp_c = coalesce(air_temp_c, p_air_temp_c),
      track_temp_c = coalesce(track_temp_c, p_track_temp_c)
    WHERE id = v_id;
  END IF;
  RETURN v_id;
END $$;

-- Recomputes a session's counters and span from the laps it has; a session with no laps left is removed.
CREATE FUNCTION public.sim_refresh_session(p_session_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  SELECT count(*)::int AS n, min(started_at) AS s, max(started_at + time_ms * interval '1 millisecond') AS e,
         min(time_ms) FILTER (WHERE valid AND time_ms > 0) AS b
    INTO r FROM public.sim_laps WHERE session_id = p_session_id;
  IF r.n = 0 THEN
    DELETE FROM public.sim_sessions WHERE id = p_session_id;
  ELSE
    UPDATE public.sim_sessions SET lap_count = r.n, started_at = r.s, ended_at = r.e, best_lap_ms = r.b
      WHERE id = p_session_id AND (lap_count, started_at, ended_at, best_lap_ms) IS DISTINCT FROM (r.n, r.s, r.e, r.b);
  END IF;
END $$;

-- Recomputes one personal best from the laps that remain: the fastest valid one (earliest wins a tie), or none.
CREATE FUNCTION public.sim_refresh_best(p_user_id uuid, p_track_id uuid, p_car_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r record;
BEGIN
  SELECT id, time_ms, started_at INTO r FROM public.sim_laps
    WHERE user_id = p_user_id AND track_id = p_track_id AND car_id = p_car_id AND valid AND time_ms > 0
    ORDER BY time_ms, started_at, id LIMIT 1;
  IF NOT FOUND THEN
    DELETE FROM public.sim_personal_bests WHERE user_id = p_user_id AND track_id = p_track_id AND car_id = p_car_id;
  ELSE
    INSERT INTO public.sim_personal_bests(user_id, track_id, car_id, best_ms, lap_id, achieved_at)
    VALUES (p_user_id, p_track_id, p_car_id, r.time_ms, r.id, r.started_at)
    ON CONFLICT (user_id, track_id, car_id) DO UPDATE SET best_ms = EXCLUDED.best_ms, lap_id = EXCLUDED.lap_id, achieved_at = EXCLUDED.achieved_at
      WHERE (sim_personal_bests.best_ms, sim_personal_bests.lap_id, sim_personal_bests.achieved_at) IS DISTINCT FROM (EXCLUDED.best_ms, EXCLUDED.lap_id, EXCLUDED.achieved_at);
  END IF;
END $$;

-- ---------------------------------------------------------------- the lap triggers

-- A lap inserted without its links (an older server, a hand-made row) is linked here, so no path leaves a lap unlinked.
CREATE FUNCTION public.sim_lap_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.game ~ '^[a-z][a-z0-9_]{0,31}$' THEN
    IF NEW.track_id IS NULL THEN NEW.track_id := public.sim_resolve_track(NEW.game, NEW.track_name); END IF;
    IF NEW.car_id IS NULL THEN NEW.car_id := public.sim_resolve_car(NEW.game, NEW.car_name); END IF;
    IF NEW.session_id IS NULL THEN
      NEW.session_id := public.sim_assign_session(NEW.user_id, NEW.game, NEW.track_id, NEW.car_id, NEW.started_at,
        NEW.started_at + NEW.time_ms * interval '1 millisecond');
    END IF;
  END IF;
  IF NEW.format_version IS NULL THEN NEW.format_version := 1; END IF;
  RETURN NEW;
END $$;

-- A lap arrived: the session counts it, and it is the personal best when it is valid and strictly faster.
CREATE FUNCTION public.sim_after_lap_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.session_id IS NOT NULL THEN
    UPDATE public.sim_sessions SET
      lap_count = lap_count + 1,
      started_at = least(started_at, NEW.started_at),
      ended_at = greatest(ended_at, NEW.started_at + NEW.time_ms * interval '1 millisecond'),
      best_lap_ms = CASE WHEN NEW.valid AND NEW.time_ms > 0 AND (best_lap_ms IS NULL OR NEW.time_ms < best_lap_ms) THEN NEW.time_ms ELSE best_lap_ms END
    WHERE id = NEW.session_id;
  END IF;
  IF NEW.valid AND NEW.time_ms > 0 AND NEW.track_id IS NOT NULL AND NEW.car_id IS NOT NULL THEN
    INSERT INTO public.sim_personal_bests(user_id, track_id, car_id, best_ms, lap_id, achieved_at)
    VALUES (NEW.user_id, NEW.track_id, NEW.car_id, NEW.time_ms, NEW.id, NEW.started_at)
    ON CONFLICT (user_id, track_id, car_id) DO UPDATE SET best_ms = EXCLUDED.best_ms, lap_id = EXCLUDED.lap_id, achieved_at = EXCLUDED.achieved_at
      WHERE EXCLUDED.best_ms < public.sim_personal_bests.best_ms;
  END IF;
  RETURN NULL;
END $$;

-- A lap was deleted: its session and, when it was valid, the personal best are recomputed from the laps that remain.
CREATE FUNCTION public.sim_after_lap_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- The whole account is going away (ON DELETE CASCADE): nothing to keep up to date.
  IF NOT EXISTS (SELECT 1 FROM public.app_accounts WHERE id = OLD.user_id) THEN RETURN NULL; END IF;
  IF OLD.session_id IS NOT NULL THEN PERFORM public.sim_refresh_session(OLD.session_id); END IF;
  IF OLD.valid AND OLD.track_id IS NOT NULL AND OLD.car_id IS NOT NULL THEN
    PERFORM public.sim_refresh_best(OLD.user_id, OLD.track_id, OLD.car_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER sim_laps_before_insert BEFORE INSERT ON public.sim_laps FOR EACH ROW EXECUTE FUNCTION public.sim_lap_before_insert();
CREATE TRIGGER sim_laps_after_insert AFTER INSERT ON public.sim_laps FOR EACH ROW EXECUTE FUNCTION public.sim_after_lap_insert();
CREATE TRIGGER sim_laps_after_delete AFTER DELETE ON public.sim_laps FOR EACH ROW EXECUTE FUNCTION public.sim_after_lap_delete();

-- ---------------------------------------------------------------- upload: limits and the one-transaction ingest

-- Counts a hit on a key in a fixed window. Answers 0 when the hit is allowed, else how many seconds until the window ends.
CREATE FUNCTION public.sim_rate_hit(p_key text, p_max integer, p_window_seconds integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_start timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
BEGIN
  INSERT INTO public.sim_rate AS r(key, window_start, hits) VALUES (p_key, v_start, 1)
  ON CONFLICT (key, window_start) DO UPDATE SET hits = r.hits + 1 RETURNING r.hits INTO v_hits;
  -- Old windows are of no use: sweep them now and then, not on every hit.
  IF random() < 0.01 THEN DELETE FROM public.sim_rate WHERE window_start < now() - interval '1 day'; END IF;
  IF v_hits > p_max THEN
    RETURN greatest(1, ceil(extract(epoch FROM (v_start + p_window_seconds * interval '1 second' - now())))::integer);
  END IF;
  RETURN 0;
END $$;

-- Whether a lap may be taken: {status: duplicate, id} when the account already has it, {status: quota} when keeping it would
-- take the account past p_max_bytes, else {status: ok}.
CREATE FUNCTION public.sim_lap_admission(p_user_id uuid, p_identity text, p_size integer, p_max_bytes bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_used bigint;
BEGIN
  SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_identity;
  IF v_id IS NOT NULL THEN RETURN jsonb_build_object('status', 'duplicate', 'id', v_id); END IF;
  SELECT coalesce(sum(size_bytes), 0) INTO v_used FROM public.sim_laps WHERE user_id = p_user_id;
  IF v_used + p_size > p_max_bytes THEN RETURN jsonb_build_object('status', 'quota'); END IF;
  RETURN jsonb_build_object('status', 'ok');
END $$;

-- The whole ingest of a lap in one transaction: admission, catalog, session, the row (the triggers keep the session and the
-- personal best), and the device's last-lap time. p_lap carries what the server read from the file. Answers
-- {status: created | duplicate | quota, id}.
CREATE FUNCTION public.sim_ingest_lap(p_user_id uuid, p_device_id uuid, p_lap jsonb, p_max_bytes bigint) RETURNS jsonb
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

  v_track := public.sim_resolve_track(p_lap->>'game', p_lap->>'track_name', (p_lap->>'track_length_m')::double precision);
  v_car := public.sim_resolve_car(p_lap->>'game', p_lap->>'car_name', p_lap->>'car_class');
  v_session := public.sim_assign_session(p_user_id, p_lap->>'game', v_track, v_car, v_started, v_started + v_ms * interval '1 millisecond',
    nullif(p_lap->>'session_id', ''), p_lap->>'session_kind', p_lap->>'weather',
    (p_lap->>'air_temp_c')::real, (p_lap->>'track_temp_c')::real);
  IF jsonb_typeof(p_lap->'sector_ms') = 'array' THEN
    SELECT array_agg(x.value::integer ORDER BY x.ord) INTO v_sectors FROM jsonb_array_elements_text(p_lap->'sector_ms') WITH ORDINALITY AS x(value, ord);
  END IF;

  INSERT INTO public.sim_laps(user_id, device_id, identity, game, track_name, car_name, lap_number, time_ms, valid, started_at,
    sample_count, size_bytes, storage_path, track_id, car_id, session_id, sector_ms, top_speed_kmh, fuel_used_l, in_lap, out_lap, format_version)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1))
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

-- ---------------------------------------------------------------- read side (API v1)
-- JSON builders and the page queries. Run as the caller: row level security keeps each person to their own rows.

CREATE FUNCTION public.sim_iso(p_t timestamptz) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT to_char(p_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
-- With microseconds: what a paging cursor needs to compare exactly.
CREATE FUNCTION public.sim_iso_us(p_t timestamptz) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT to_char(p_t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION public.sim_lap_json(l public.sim_laps, p_track text, p_car text, p_device text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'game', l.game,
    'track', CASE WHEN l.track_id IS NULL THEN NULL ELSE jsonb_build_object('id', l.track_id, 'name', coalesce(p_track, l.track_name)) END,
    'car', CASE WHEN l.car_id IS NULL THEN NULL ELSE jsonb_build_object('id', l.car_id, 'name', coalesce(p_car, l.car_name)) END,
    'sessionId', l.session_id, 'lapNumber', l.lap_number, 'timeMs', l.time_ms, 'valid', l.valid,
    'startedAt', public.sim_iso(l.started_at), 'sectorsMs', to_jsonb(l.sector_ms),
    'topSpeedKmh', l.top_speed_kmh, 'fuelUsedL', l.fuel_used_l, 'inLap', l.in_lap, 'outLap', l.out_lap,
    'sampleCount', l.sample_count, 'sizeBytes', l.size_bytes, 'reduced', coalesce(l.reduced, false),
    'formatVersion', l.format_version, 'createdAt', public.sim_iso(l.created_at), 'deviceName', p_device)
$$;

CREATE FUNCTION public.sim_session_json(s public.sim_sessions, p_track text, p_car text) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'game', s.game,
    'track', jsonb_build_object('id', s.track_id, 'name', p_track), 'car', jsonb_build_object('id', s.car_id, 'name', p_car),
    'kind', s.kind, 'origin', s.origin, 'startedAt', public.sim_iso(s.started_at), 'endedAt', public.sim_iso(s.ended_at),
    'weather', s.weather, 'airTempC', s.air_temp_c, 'trackTempC', s.track_temp_c, 'lapCount', s.lap_count, 'bestLapMs', s.best_lap_ms)
$$;

-- Every list function returns a jsonb array of at most p_limit + 1 items, newest first; each item carries "_k" (the sort time,
-- with microseconds) and "_i" (the tie-breaking id) for the cursor, which the API strips.

CREATE FUNCTION public.sim_v1_laps(
  p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL, p_session uuid DEFAULT NULL, p_valid boolean DEFAULT NULL,
  p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(x.j ORDER BY x.started_at DESC, x.id DESC) FROM (
    SELECT l.id, l.started_at,
      public.sim_lap_json(l, t.name, c.name, d.name) || jsonb_build_object('_k', public.sim_iso_us(l.started_at), '_i', l.id) AS j
    FROM public.sim_laps l
    LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id
    LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
    LEFT JOIN public.sim_devices d ON d.id = l.device_id
    WHERE l.user_id = v_user
      AND (p_game IS NULL OR l.game = p_game) AND (p_track IS NULL OR l.track_id = p_track)
      AND (p_car IS NULL OR l.car_id = p_car) AND (p_session IS NULL OR l.session_id = p_session)
      AND (p_valid IS NULL OR l.valid = p_valid)
      AND (p_after_t IS NULL OR (l.started_at, l.id) < (p_after_t, p_after_id))
    ORDER BY l.started_at DESC, l.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) x), '[]'::jsonb);
END $$;

CREATE FUNCTION public.sim_v1_sessions(
  p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL,
  p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(x.j ORDER BY x.started_at DESC, x.id DESC) FROM (
    SELECT s.id, s.started_at,
      public.sim_session_json(s, t.name, c.name) || jsonb_build_object('_k', public.sim_iso_us(s.started_at), '_i', s.id) AS j
    FROM public.sim_sessions s
    JOIN public.sim_track_catalog t ON t.id = s.track_id
    JOIN public.sim_car_catalog c ON c.id = s.car_id
    WHERE s.user_id = v_user
      AND (p_game IS NULL OR s.game = p_game) AND (p_track IS NULL OR s.track_id = p_track) AND (p_car IS NULL OR s.car_id = p_car)
      AND (p_after_t IS NULL OR (s.started_at, s.id) < (p_after_t, p_after_id))
    ORDER BY s.started_at DESC, s.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) x), '[]'::jsonb);
END $$;

-- One session with its laps in driving order (at most 2000), or null when the person has no such session.
CREATE FUNCTION public.sim_v1_session(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id(); s public.sim_sessions; v_track text; v_car text;
BEGIN
  SELECT * INTO s FROM public.sim_sessions WHERE id = p_id AND user_id = v_user;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT name INTO v_track FROM public.sim_track_catalog WHERE id = s.track_id;
  SELECT name INTO v_car FROM public.sim_car_catalog WHERE id = s.car_id;
  RETURN jsonb_build_object(
    'session', public.sim_session_json(s, v_track, v_car),
    'laps', coalesce((SELECT jsonb_agg(x.j ORDER BY x.started_at, x.lap_number, x.id) FROM (
      SELECT l.id, l.started_at, l.lap_number, public.sim_lap_json(l, v_track, v_car, d.name) AS j
      FROM public.sim_laps l LEFT JOIN public.sim_devices d ON d.id = l.device_id
      WHERE l.user_id = v_user AND l.session_id = s.id
      ORDER BY l.started_at, l.lap_number, l.id LIMIT 2000) x), '[]'::jsonb));
END $$;

CREATE FUNCTION public.sim_v1_pbs(
  p_game text DEFAULT NULL, p_track uuid DEFAULT NULL, p_car uuid DEFAULT NULL,
  p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(x.j ORDER BY x.achieved_at DESC, x.lap_id DESC) FROM (
    SELECT b.achieved_at, b.lap_id,
      jsonb_build_object('game', t.game, 'track', jsonb_build_object('id', t.id, 'name', t.name), 'car', jsonb_build_object('id', c.id, 'name', c.name),
        'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at),
        '_k', public.sim_iso_us(b.achieved_at), '_i', b.lap_id) AS j
    FROM public.sim_personal_bests b
    JOIN public.sim_track_catalog t ON t.id = b.track_id
    JOIN public.sim_car_catalog c ON c.id = b.car_id
    WHERE b.user_id = v_user
      AND (p_game IS NULL OR t.game = p_game) AND (p_track IS NULL OR b.track_id = p_track) AND (p_car IS NULL OR b.car_id = p_car)
      AND (p_after_t IS NULL OR (b.achieved_at, b.lap_id) < (p_after_t, p_after_id))
    ORDER BY b.achieved_at DESC, b.lap_id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) x), '[]'::jsonb);
END $$;

-- The tracks the person has driven, most recently driven first.
CREATE FUNCTION public.sim_v1_tracks(
  p_game text DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(y.j ORDER BY y.last_driven DESC, y.id DESC) FROM (
    SELECT t.id, a.last_driven,
      jsonb_build_object('id', t.id, 'game', t.game, 'name', t.name, 'lengthM', t.length_m,
        'lapCount', a.laps, 'validLapCount', a.valid_laps, 'sessionCount', a.sessions, 'carCount', a.cars, 'bestLapMs', a.best,
        'lastDrivenAt', public.sim_iso(a.last_driven), '_k', public.sim_iso_us(a.last_driven), '_i', t.id) AS j
    FROM (
      SELECT l.track_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps,
        count(DISTINCT l.session_id) AS sessions, count(DISTINCT l.car_id) AS cars,
        min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0) AS best, max(l.started_at) AS last_driven
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id IS NOT NULL GROUP BY l.track_id
    ) a JOIN public.sim_track_catalog t ON t.id = a.track_id
    WHERE (p_game IS NULL OR t.game = p_game) AND (p_after_t IS NULL OR (a.last_driven, t.id) < (p_after_t, p_after_id))
    ORDER BY a.last_driven DESC, t.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) y), '[]'::jsonb);
END $$;

CREATE FUNCTION public.sim_v1_cars(
  p_game text DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_user uuid := public.current_app_user_id();
BEGIN
  RETURN coalesce((SELECT jsonb_agg(y.j ORDER BY y.last_driven DESC, y.id DESC) FROM (
    SELECT c.id, a.last_driven,
      jsonb_build_object('id', c.id, 'game', c.game, 'name', c.name, 'brand', c.brand, 'class', c.class,
        'lapCount', a.laps, 'validLapCount', a.valid_laps, 'sessionCount', a.sessions, 'trackCount', a.tracks, 'bestLapMs', a.best,
        'lastDrivenAt', public.sim_iso(a.last_driven), '_k', public.sim_iso_us(a.last_driven), '_i', c.id) AS j
    FROM (
      SELECT l.car_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps,
        count(DISTINCT l.session_id) AS sessions, count(DISTINCT l.track_id) AS tracks,
        min(l.time_ms) FILTER (WHERE l.valid AND l.time_ms > 0) AS best, max(l.started_at) AS last_driven
      FROM public.sim_laps l WHERE l.user_id = v_user AND l.car_id IS NOT NULL GROUP BY l.car_id
    ) a JOIN public.sim_car_catalog c ON c.id = a.car_id
    WHERE (p_game IS NULL OR c.game = p_game) AND (p_after_t IS NULL OR (a.last_driven, c.id) < (p_after_t, p_after_id))
    ORDER BY a.last_driven DESC, c.id DESC LIMIT least(greatest(p_limit, 1), 101)
  ) y), '[]'::jsonb);
END $$;

-- One track and the person's progress on it: best valid lap per day, laps per day (UTC days, the latest 1000 that have laps)
-- and the best per car. Null when the track is not in the catalog.
CREATE FUNCTION public.sim_v1_track(p_id uuid) RETURNS jsonb
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
    'bestPerCar', coalesce((SELECT jsonb_agg(z.j ORDER BY z.best_ms NULLS LAST, z.name, z.car_id) FROM (
      SELECT a.car_id, c.name, b.best_ms,
        jsonb_build_object('car', jsonb_build_object('id', c.id, 'name', c.name, 'class', c.class), 'lapCount', a.laps, 'validLapCount', a.valid_laps,
          'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at)) AS j
      FROM (SELECT l.car_id, count(*) AS laps, count(*) FILTER (WHERE l.valid AND l.time_ms > 0) AS valid_laps
            FROM public.sim_laps l WHERE l.user_id = v_user AND l.track_id = t.id AND l.car_id IS NOT NULL GROUP BY l.car_id) a
      JOIN public.sim_car_catalog c ON c.id = a.car_id
      LEFT JOIN public.sim_personal_bests b ON b.user_id = v_user AND b.track_id = t.id AND b.car_id = a.car_id
      LIMIT 200) z), '[]'::jsonb));
END $$;

CREATE FUNCTION public.sim_v1_car(p_id uuid) RETURNS jsonb
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

-- The home page in one call: the 5 latest sessions, the 5 latest personal bests, laps per game, the Companion's status.
CREATE FUNCTION public.sim_v1_overview() RETURNS jsonb
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
          'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at)) AS j
      FROM public.sim_personal_bests b JOIN public.sim_track_catalog t ON t.id = b.track_id JOIN public.sim_car_catalog c ON c.id = b.car_id
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

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  -- The server's own functions and the triggers: nobody else.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'sim_resolve_track', 'sim_resolve_car', 'sim_assign_session', 'sim_refresh_session', 'sim_refresh_best', 'sim_lap_before_insert',
    'sim_after_lap_insert', 'sim_after_lap_delete', 'sim_rate_hit', 'sim_lap_admission', 'sim_ingest_lap')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
  -- The read side runs as the signed-in person (and the server's own checks).
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'sim_norm', 'sim_iso', 'sim_iso_us', 'sim_lap_json', 'sim_session_json', 'sim_v1_laps', 'sim_v1_sessions', 'sim_v1_session',
    'sim_v1_pbs', 'sim_v1_tracks', 'sim_v1_cars', 'sim_v1_track', 'sim_v1_car', 'sim_v1_overview')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f.sig);
  END LOOP;
END $grants$;
