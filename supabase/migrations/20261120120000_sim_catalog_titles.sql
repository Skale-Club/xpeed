-- The names people know a car and a track by, for games that report folder names (Assetto Corsa: `ks_laguna_seca`,
-- `ks_porsche_macan`). From Companion 0.15.1 a lap header may carry `track.title` / `car.title` ("Laguna Seca",
-- "Porsche Macan Turbo") beside `name`. The name stays the identity: the catalog row is still found by its alias (the
-- folder name), the lap's identity and its track layout are keyed by it. Only the catalog's display name changes.
-- Additive: one new function, one function redefined with a wider match, no table or column changes.

-- Gives a catalog row its title when the row is still named the game's way (first come, as the catalog always was: a
-- title never replaces another title or a name someone already reads). Old laps point at the same row, so they read the
-- new name too. Called by POST /api/sim/laps after the lap is in (service role only).
CREATE OR REPLACE FUNCTION public.sim_title_catalog(p_game text, p_track_name text, p_track_title text, p_car_name text, p_car_title text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_track_title text := btrim(coalesce(p_track_title, ''));
  v_car_title text := btrim(coalesce(p_car_title, ''));
  v_id uuid;
BEGIN
  IF char_length(v_track_title) BETWEEN 1 AND 120 AND public.sim_norm(v_track_title) <> '' AND public.sim_norm(coalesce(p_track_name, '')) <> '' THEN
    SELECT track_id INTO v_id FROM public.sim_track_alias
    WHERE game = p_game AND alias_norm = left(public.sim_norm(p_track_name), 160);
    IF v_id IS NOT NULL THEN
      UPDATE public.sim_track_catalog SET name = v_track_title
      WHERE id = v_id AND public.sim_norm(name) = public.sim_norm(p_track_name) AND name <> v_track_title;
    END IF;
  END IF;

  v_id := NULL;
  IF char_length(v_car_title) BETWEEN 1 AND 120 AND public.sim_norm(v_car_title) <> '' AND public.sim_norm(coalesce(p_car_name, '')) <> '' THEN
    SELECT car_id INTO v_id FROM public.sim_car_alias
    WHERE game = p_game AND alias_norm = left(public.sim_norm(p_car_name), 160);
    IF v_id IS NOT NULL THEN
      UPDATE public.sim_car_catalog SET name = v_car_title
      WHERE id = v_id AND public.sim_norm(name) = public.sim_norm(p_car_name) AND name <> v_car_title;
    END IF;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.sim_title_catalog(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_title_catalog(text, text, text, text, text) TO service_role;

-- The layout of a catalog track (20261113190000_sim_virtual_gaps.sql), now also by the track's aliases: a catalog row
-- renamed to its title ("Brands Hatch") still finds the layouts the Companion filed under the folder name
-- (`ks_brands_hatch`, whose per-layout titles are "Brands Hatch - GP", "Brands Hatch - Indy").
CREATE OR REPLACE FUNCTION public.sim_layout_id(p_user uuid, p_game text, p_name text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT s.id FROM public.sim_tracks s
  WHERE s.user_id = p_user
    AND public.sim_norm(s.game) = public.sim_norm(CASE WHEN lower(btrim(p_game)) = 'rfactor1' THEN 'sce' ELSE p_game END)
    AND public.sim_norm(p_name) <> ''
    AND (
      public.sim_norm(p_name) IN (public.sim_norm(s.track_name), public.sim_norm(s.track_name || ' ' || coalesce(s.variant, '')), public.sim_norm(s.title))
      OR EXISTS (
        SELECT 1 FROM public.sim_track_catalog c JOIN public.sim_track_alias a ON a.track_id = c.id AND a.game = c.game
        WHERE c.game = p_game AND c.name = p_name
          AND a.alias_norm IN (left(public.sim_norm(s.track_name), 160), left(public.sim_norm(s.track_name || ' ' || coalesce(s.variant, '')), 160))
      )
    )
  ORDER BY s.updated_at DESC, s.id LIMIT 1
$$;
