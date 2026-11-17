-- The username is chosen by the person, not left to chance: the generated handle (driver_ plus six letters) is only a placeholder until
-- the person picks one, and the site asks for it before any Virtual screen. `handle_chosen` says whether that happened.
-- The first pick replaces the placeholder and is not one of the 3 changes in 30 days; every later change is.
-- Additive and idempotent: one new column (IF NOT EXISTS, default false) and two functions replaced with the same signatures, so
-- their grants stay. Nothing is dropped or renamed.
ALTER TABLE public.sim_profiles ADD COLUMN IF NOT EXISTS handle_chosen boolean NOT NULL DEFAULT false;

-- Someone who already changed their handle chose it.
UPDATE public.sim_profiles p SET handle_chosen = true
  WHERE NOT p.handle_chosen AND EXISTS (SELECT 1 FROM public.sim_handle_changes c WHERE c.user_id = p.user_id);

-- The person's own profile (created now if it does not exist), whether they chose their handle, and how many changes they have left.
CREATE OR REPLACE FUNCTION public.sim_my_profile(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.sim_profiles; v_recent timestamptz[]; v_left integer;
BEGIN
  PERFORM public.sim_ensure_profile(p_user);
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = p_user;
  SELECT array_agg(changed_at ORDER BY changed_at DESC) INTO v_recent
    FROM (SELECT changed_at FROM public.sim_handle_changes WHERE user_id = p_user AND changed_at > now() - interval '30 days' ORDER BY changed_at DESC LIMIT 3) c;
  v_left := 3 - coalesce(cardinality(v_recent), 0);
  RETURN jsonb_build_object('handle', p.handle, 'handleChosen', p.handle_chosen, 'displayName', p.display_name, 'visibility', p.visibility,
    'createdAt', public.sim_iso(p.created_at), 'handleChangesLeft', v_left,
    'handleChangesResetAt', CASE WHEN v_left = 0 THEN to_jsonb(public.sim_iso(v_recent[3] + interval '30 days')) END);
END $$;

-- Changes the handle, the display name and the visibility. A null leaves the field as it is.
-- The first handle the person sends is their choice (even the generated one, kept on purpose) and is free; after that a different
-- handle is a change, 3 in 30 days. {status: ok | taken | limit, retry_after}
CREATE OR REPLACE FUNCTION public.sim_set_profile(p_user uuid, p_handle text, p_display text, p_visibility text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.sim_profiles; v_third timestamptz;
BEGIN
  PERFORM public.sim_ensure_profile(p_user);
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = p_user FOR UPDATE;
  IF p_handle IS NOT NULL AND p_handle <> p.handle THEN
    IF p.handle_chosen THEN
      SELECT changed_at INTO v_third FROM public.sim_handle_changes
        WHERE user_id = p_user AND changed_at > now() - interval '30 days' ORDER BY changed_at DESC LIMIT 1 OFFSET 2;
      IF v_third IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'limit', 'retry_after', greatest(1, ceil(extract(epoch FROM (v_third + interval '30 days' - now())))::integer));
      END IF;
    END IF;
    BEGIN
      UPDATE public.sim_profiles SET handle = p_handle, updated_at = now() WHERE user_id = p_user;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'taken');
    END;
    IF p.handle_chosen THEN INSERT INTO public.sim_handle_changes(user_id) VALUES (p_user); END IF;
  END IF;
  UPDATE public.sim_profiles SET display_name = coalesce(p_display, display_name), visibility = coalesce(p_visibility, visibility),
    handle_chosen = handle_chosen OR p_handle IS NOT NULL, updated_at = now()
    WHERE user_id = p_user;
  RETURN jsonb_build_object('status', 'ok');
END $$;
