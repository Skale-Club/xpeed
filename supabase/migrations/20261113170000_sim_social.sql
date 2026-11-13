-- Phase 2: the social side of the racing data (docs/platform/API-V1.md, docs/platform/PRIVACY-MODEL.md): driver profiles
-- (public by default, the person chooses public, friends or private), friendships, share links, leaderboards that only take
-- valid and plausible laps, reports with moderation, and the two privacy rights (export and delete).
--
-- Additive only: new tables, three new columns on sim_laps (plausible and plausibility stay NULL for the laps that exist; hidden
-- defaults to false), new functions, and a replaced sim_ingest_lap that also stores the plausibility the server computed.
-- Who may do what: only the server (service role). The server resolves the signed-in person first and passes their id, so none
-- of these functions is granted to anon or authenticated, and none of the new tables can be read through the Data API.

-- ---------------------------------------------------------------- laps: plausibility and moderation

ALTER TABLE public.sim_laps
  ADD COLUMN plausible boolean,
  ADD COLUMN plausibility jsonb,
  ADD COLUMN hidden boolean NOT NULL DEFAULT false;

-- The leaderboard reads the best valid, plausible, visible lap of every driver on one track and car.
CREATE INDEX sim_laps_board ON public.sim_laps(track_id, car_id, user_id, time_ms, started_at, id)
  WHERE valid AND plausible IS TRUE AND NOT hidden;
-- Laps whose file has not been checked yet (every lap that arrived before this migration), oldest first.
CREATE INDEX sim_laps_unchecked ON public.sim_laps(created_at, id) WHERE plausible IS NULL;

-- ---------------------------------------------------------------- profiles

-- One per person who uses the Virtual API. The handle and the display name are generated (never derived from the e-mail or the
-- account name) until the person chooses their own. `hidden` is moderation: a hidden profile is in no social answer.
CREATE TABLE public.sim_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,24}$'),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40 AND display_name !~ '[\x01-\x1f\x7f-\x9f]'),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends', 'private')),
  hidden boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Each handle change, to limit them (3 in 30 days). The first, generated handle is not a change.
CREATE TABLE public.sim_handle_changes (
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sim_handle_changes_user ON public.sim_handle_changes(user_id, changed_at DESC);

-- ---------------------------------------------------------------- friendships

-- A pair of people, stored with the lower id first. `requested_by` is who asked; a block keeps the row (status blocked,
-- blocked_by) so the other person can neither request nor see the blocker.
CREATE TABLE public.sim_friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  user_b uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'blocked')),
  blocked_by uuid REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b),
  CHECK (requested_by IN (user_a, user_b)),
  CHECK ((status = 'blocked') = (blocked_by IS NOT NULL)),
  CHECK (blocked_by IS NULL OR blocked_by IN (user_a, user_b))
);
CREATE INDEX sim_friendships_a ON public.sim_friendships(user_a, status);
CREATE INDEX sim_friendships_b ON public.sim_friendships(user_b, status);

-- ---------------------------------------------------------------- share links

-- The token is random (43 URL-safe characters) and only its sha256 is stored: it is shown once, when the link is made.
CREATE TABLE public.sim_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  lap_id uuid REFERENCES public.sim_laps(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.sim_sessions(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  CHECK ((lap_id IS NULL) <> (session_id IS NULL))
);
CREATE INDEX sim_shares_user ON public.sim_shares(created_by, created_at DESC, id DESC);
CREATE INDEX sim_shares_lap ON public.sim_shares(lap_id) WHERE lap_id IS NOT NULL;
CREATE INDEX sim_shares_session ON public.sim_shares(session_id) WHERE session_id IS NOT NULL;

-- ---------------------------------------------------------------- reports

CREATE TABLE public.sim_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('profile', 'lap')),
  -- the person's account id for a profile, the lap id for a lap (no foreign key: it can point at either)
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('cheating', 'offensive_name', 'impersonation', 'spam', 'other')),
  details text CHECK (details IS NULL OR char_length(details) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'actioned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES public.app_accounts(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX sim_reports_one_open ON public.sim_reports(reporter_id, target_kind, target_id) WHERE status = 'open';
CREATE INDEX sim_reports_status ON public.sim_reports(status, created_at DESC, id DESC);
CREATE INDEX sim_reports_target ON public.sim_reports(target_kind, target_id);

-- ---------------------------------------------------------------- access

ALTER TABLE public.sim_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_handle_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sim_profiles, public.sim_handle_changes, public.sim_friendships, public.sim_shares, public.sim_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sim_profiles, public.sim_handle_changes, public.sim_friendships, public.sim_shares, public.sim_reports TO service_role;

-- ---------------------------------------------------------------- profiles: creation, visibility, changes

-- Creates the person's profile the first time they use the Virtual API: a generated handle (driver_ plus six letters and digits,
-- no look-alikes) and a display name made from the same letters. Nothing comes from the e-mail or the account name.
CREATE FUNCTION public.sim_ensure_profile(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_alpha constant text := 'abcdefghjkmnpqrstuvwxyz23456789'; v_suffix text; v_tries integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.sim_profiles WHERE user_id = p_user) THEN RETURN; END IF;
  LOOP
    v_suffix := '';
    FOR i IN 1..6 LOOP v_suffix := v_suffix || substr(v_alpha, 1 + floor(random() * length(v_alpha))::integer, 1); END LOOP;
    BEGIN
      INSERT INTO public.sim_profiles(user_id, handle, display_name) VALUES (p_user, 'driver_' || v_suffix, 'Driver ' || upper(substr(v_suffix, 1, 4)));
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      -- a concurrent call made it, or the handle was taken: try another one
      IF EXISTS (SELECT 1 FROM public.sim_profiles WHERE user_id = p_user) THEN RETURN; END IF;
      v_tries := v_tries + 1;
      IF v_tries > 25 THEN RAISE; END IF;
    END;
  END LOOP;
END $$;

-- Whether p_viewer may see p_owner's profile (and so their laps in a ranking and their name). The owner always sees themselves.
-- Nobody sees a hidden profile or a person on either side of a block. A friends profile is for accepted friends; a private one
-- for nobody else. Anyone can see a public one.
CREATE FUNCTION public.sim_profile_visible_to(p_viewer uuid, p_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE
    WHEN p_viewer = p_owner THEN EXISTS (SELECT 1 FROM public.sim_profiles p WHERE p.user_id = p_owner)
    ELSE EXISTS (
      SELECT 1 FROM public.sim_profiles p
      WHERE p.user_id = p_owner AND NOT p.hidden
        AND NOT EXISTS (SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, p_owner) AND f.user_b = greatest(p_viewer, p_owner) AND f.status = 'blocked')
        AND (p.visibility = 'public'
          OR (p.visibility = 'friends' AND EXISTS (SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, p_owner) AND f.user_b = greatest(p_viewer, p_owner) AND f.status = 'accepted'))))
  END
$$;

-- The person's own profile (created now if it does not exist) and how many handle changes they have left.
CREATE FUNCTION public.sim_my_profile(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.sim_profiles; v_recent timestamptz[]; v_left integer;
BEGIN
  PERFORM public.sim_ensure_profile(p_user);
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = p_user;
  SELECT array_agg(changed_at ORDER BY changed_at DESC) INTO v_recent
    FROM (SELECT changed_at FROM public.sim_handle_changes WHERE user_id = p_user AND changed_at > now() - interval '30 days' ORDER BY changed_at DESC LIMIT 3) c;
  v_left := 3 - coalesce(cardinality(v_recent), 0);
  RETURN jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'visibility', p.visibility, 'createdAt', public.sim_iso(p.created_at),
    'handleChangesLeft', v_left, 'handleChangesResetAt', CASE WHEN v_left = 0 THEN to_jsonb(public.sim_iso(v_recent[3] + interval '30 days')) END);
END $$;

-- Changes the handle (3 in 30 days), the display name and the visibility. A null leaves the field as it is.
-- {status: ok | taken | limit, retry_after}
CREATE FUNCTION public.sim_set_profile(p_user uuid, p_handle text, p_display text, p_visibility text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.sim_profiles; v_third timestamptz;
BEGIN
  PERFORM public.sim_ensure_profile(p_user);
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = p_user FOR UPDATE;
  IF p_handle IS NOT NULL AND p_handle <> p.handle THEN
    SELECT changed_at INTO v_third FROM public.sim_handle_changes
      WHERE user_id = p_user AND changed_at > now() - interval '30 days' ORDER BY changed_at DESC LIMIT 1 OFFSET 2;
    IF v_third IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'limit', 'retry_after', greatest(1, ceil(extract(epoch FROM (v_third + interval '30 days' - now())))::integer));
    END IF;
    BEGIN
      UPDATE public.sim_profiles SET handle = p_handle, updated_at = now() WHERE user_id = p_user;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('status', 'taken');
    END;
    INSERT INTO public.sim_handle_changes(user_id) VALUES (p_user);
  END IF;
  UPDATE public.sim_profiles SET display_name = coalesce(p_display, display_name), visibility = coalesce(p_visibility, visibility), updated_at = now()
    WHERE user_id = p_user;
  RETURN jsonb_build_object('status', 'ok');
END $$;

-- Another driver's page, as p_viewer may see it, or NULL (no such handle, a private profile, a hidden one, a block: all the same).
-- Only laps that count (valid, plausible, not hidden) are shown.
CREATE FUNCTION public.sim_profile_page(p_viewer uuid, p_handle text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE p public.sim_profiles; f public.sim_friendships; v_relation text; v_best jsonb; v_count integer;
BEGIN
  SELECT * INTO p FROM public.sim_profiles WHERE handle = p_handle;
  IF NOT FOUND OR NOT public.sim_profile_visible_to(p_viewer, p.user_id) THEN RETURN NULL; END IF;
  IF p.user_id = p_viewer THEN v_relation := 'self';
  ELSE
    SELECT * INTO f FROM public.sim_friendships WHERE user_a = least(p_viewer, p.user_id) AND user_b = greatest(p_viewer, p.user_id);
    v_relation := CASE WHEN NOT FOUND THEN 'none' WHEN f.status = 'accepted' THEN 'friend'
      WHEN f.status = 'pending' AND f.requested_by = p_viewer THEN 'requested' WHEN f.status = 'pending' THEN 'incoming' ELSE 'none' END;
  END IF;
  SELECT count(*) INTO v_count FROM (SELECT DISTINCT l.track_id, l.car_id FROM public.sim_laps l
    WHERE l.user_id = p.user_id AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.track_id IS NOT NULL AND l.car_id IS NOT NULL) x;
  SELECT coalesce(jsonb_agg(y.item ORDER BY y.t DESC, y.lap_id DESC), '[]'::jsonb) INTO v_best FROM (
    SELECT * FROM (
      SELECT DISTINCT ON (l.track_id, l.car_id) l.started_at AS t, l.id AS lap_id, jsonb_build_object(
        'lapId', l.id, 'game', l.game, 'track', jsonb_build_object('id', l.track_id, 'name', t.name), 'car', jsonb_build_object('id', l.car_id, 'name', c.name),
        'timeMs', l.time_ms, 'achievedAt', public.sim_iso(l.started_at)) AS item
      FROM public.sim_laps l JOIN public.sim_track_catalog t ON t.id = l.track_id JOIN public.sim_car_catalog c ON c.id = l.car_id
      WHERE l.user_id = p.user_id AND l.valid AND l.plausible IS TRUE AND NOT l.hidden
      ORDER BY l.track_id, l.car_id, l.time_ms, l.started_at, l.id) per
    ORDER BY per.t DESC, per.lap_id DESC LIMIT 5) y;
  RETURN jsonb_build_object(
    'handle', p.handle, 'displayName', p.display_name, 'joinedAt', public.sim_iso(p.created_at), 'isMe', p.user_id = p_viewer, 'relation', v_relation,
    'visibility', CASE WHEN p.user_id = p_viewer THEN to_jsonb(p.visibility) END,
    'gamesPlayed', (SELECT coalesce(jsonb_agg(g.game ORDER BY g.game), '[]'::jsonb) FROM (SELECT DISTINCT game FROM public.sim_laps WHERE user_id = p.user_id AND NOT hidden) g),
    'personalBestsCount', v_count, 'bestLaps', v_best);
END $$;

-- ---------------------------------------------------------------- friends

CREATE FUNCTION public.sim_friend_count(p_user uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.sim_friendships WHERE status = 'accepted' AND (user_a = p_user OR user_b = p_user)
$$;

-- One friendship as p_viewer sees it. The name is only given when the viewer may see that profile.
CREATE FUNCTION public.sim_friend_item(p_viewer uuid, f public.sim_friendships) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'handle', op.handle,
    'displayName', CASE WHEN public.sim_profile_visible_to(p_viewer, op.user_id) THEN to_jsonb(op.display_name) END,
    'status', CASE f.status WHEN 'accepted' THEN 'accepted' WHEN 'blocked' THEN 'blocked' WHEN 'pending' THEN CASE WHEN f.requested_by = p_viewer THEN 'outgoing' ELSE 'incoming' END END,
    'since', public.sim_iso(coalesce(f.decided_at, f.created_at)))
  FROM public.sim_profiles op WHERE op.user_id = CASE WHEN f.user_a = p_viewer THEN f.user_b ELSE f.user_a END
$$;

-- p_status: accepted | incoming | outgoing | blocked (the ones the viewer blocked). Newest first, up to p_limit items with the cursor keys.
CREATE FUNCTION public.sim_friend_list(p_viewer uuid, p_status text, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.t DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT f.created_at AS t, f.id, public.sim_friend_item(p_viewer, f) || jsonb_build_object('_k', public.sim_iso_us(f.created_at), '_i', f.id) AS item
    FROM public.sim_friendships f
    JOIN public.sim_profiles op ON op.user_id = CASE WHEN f.user_a = p_viewer THEN f.user_b ELSE f.user_a END
    WHERE (f.user_a = p_viewer OR f.user_b = p_viewer) AND NOT op.hidden
      AND CASE p_status
        WHEN 'accepted' THEN f.status = 'accepted'
        WHEN 'incoming' THEN f.status = 'pending' AND f.requested_by <> p_viewer
        WHEN 'outgoing' THEN f.status = 'pending' AND f.requested_by = p_viewer
        ELSE f.status = 'blocked' AND f.blocked_by = p_viewer END
      AND (p_after_id IS NULL OR (f.created_at, f.id) < (p_after_t, p_after_id))
    ORDER BY f.created_at DESC, f.id DESC LIMIT p_limit) x
$$;

-- Asks the person with this handle to be friends. A private, hidden or unknown handle, and a person who blocked the asker, all
-- answer {status: not_found}. If that person had already asked, the two requests become a friendship.
-- {status: pending | accepted | not_found | self | blocked | already_friends | already_requested | friend_limit | pending_limit, friend}
CREATE FUNCTION public.sim_friend_request(p_me uuid, p_handle text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.sim_profiles; f public.sim_friendships; v_found boolean;
BEGIN
  PERFORM public.sim_ensure_profile(p_me);
  SELECT * INTO o FROM public.sim_profiles WHERE handle = p_handle;
  IF NOT FOUND OR o.hidden THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF o.user_id = p_me THEN RETURN jsonb_build_object('status', 'self'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:friend:' || least(p_me, o.user_id)::text || greatest(p_me, o.user_id)::text, 0));
  SELECT * INTO f FROM public.sim_friendships WHERE user_a = least(p_me, o.user_id) AND user_b = greatest(p_me, o.user_id);
  v_found := FOUND;
  IF v_found AND f.status = 'blocked' THEN
    RETURN jsonb_build_object('status', CASE WHEN f.blocked_by = p_me THEN 'blocked' ELSE 'not_found' END);
  END IF;
  -- A private profile cannot be found by handle; only a relation that already exists is still reachable.
  IF o.visibility = 'private' AND NOT (v_found AND f.status IN ('pending', 'accepted')) THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_found AND f.status = 'accepted' THEN RETURN jsonb_build_object('status', 'already_friends'); END IF;
  IF v_found AND f.status = 'pending' THEN
    IF f.requested_by = p_me THEN RETURN jsonb_build_object('status', 'already_requested'); END IF;
    IF public.sim_friend_count(p_me) >= 200 OR public.sim_friend_count(o.user_id) >= 200 THEN RETURN jsonb_build_object('status', 'friend_limit'); END IF;
    UPDATE public.sim_friendships SET status = 'accepted', decided_at = now() WHERE id = f.id RETURNING * INTO f;
    RETURN jsonb_build_object('status', 'accepted', 'friend', public.sim_friend_item(p_me, f));
  END IF;
  IF public.sim_friend_count(p_me) >= 200 THEN RETURN jsonb_build_object('status', 'friend_limit'); END IF;
  IF (SELECT count(*) FROM public.sim_friendships WHERE status = 'pending' AND requested_by = p_me) >= 50 THEN RETURN jsonb_build_object('status', 'pending_limit'); END IF;
  INSERT INTO public.sim_friendships(user_a, user_b, requested_by, status) VALUES (least(p_me, o.user_id), greatest(p_me, o.user_id), p_me, 'pending') RETURNING * INTO f;
  RETURN jsonb_build_object('status', 'pending', 'friend', public.sim_friend_item(p_me, f));
END $$;

-- Accepts or declines the request that the person with this handle sent to p_me. A decline deletes it.
-- {status: accepted | declined | not_found | friend_limit, friend}
CREATE FUNCTION public.sim_friend_decide(p_me uuid, p_handle text, p_accept boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.sim_profiles; f public.sim_friendships;
BEGIN
  SELECT * INTO o FROM public.sim_profiles WHERE handle = p_handle;
  IF NOT FOUND OR o.hidden OR o.user_id = p_me THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:friend:' || least(p_me, o.user_id)::text || greatest(p_me, o.user_id)::text, 0));
  SELECT * INTO f FROM public.sim_friendships
    WHERE user_a = least(p_me, o.user_id) AND user_b = greatest(p_me, o.user_id) AND status = 'pending' AND requested_by = o.user_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF NOT p_accept THEN
    DELETE FROM public.sim_friendships WHERE id = f.id;
    RETURN jsonb_build_object('status', 'declined');
  END IF;
  IF public.sim_friend_count(p_me) >= 200 OR public.sim_friend_count(o.user_id) >= 200 THEN RETURN jsonb_build_object('status', 'friend_limit'); END IF;
  UPDATE public.sim_friendships SET status = 'accepted', decided_at = now() WHERE id = f.id RETURNING * INTO f;
  RETURN jsonb_build_object('status', 'accepted', 'friend', public.sim_friend_item(p_me, f));
END $$;

-- Either side removes a friendship, cancels or withdraws a request; the person who blocked lifts their own block. {status: ok | not_found}
CREATE FUNCTION public.sim_friend_remove(p_me uuid, p_handle text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.sim_profiles; v_gone integer;
BEGIN
  SELECT * INTO o FROM public.sim_profiles WHERE handle = p_handle;
  IF NOT FOUND OR o.hidden OR o.user_id = p_me THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:friend:' || least(p_me, o.user_id)::text || greatest(p_me, o.user_id)::text, 0));
  DELETE FROM public.sim_friendships WHERE user_a = least(p_me, o.user_id) AND user_b = greatest(p_me, o.user_id) AND (status <> 'blocked' OR blocked_by = p_me);
  GET DIAGNOSTICS v_gone = ROW_COUNT;
  RETURN jsonb_build_object('status', CASE WHEN v_gone > 0 THEN 'ok' ELSE 'not_found' END);
END $$;

-- Blocks the person with this handle: whatever there was between them (friends, a request) is replaced by the block. Someone who
-- cannot be found by handle (private, hidden, unknown) and has no relation with p_me answers not_found. {status: ok | not_found | self, friend}
CREATE FUNCTION public.sim_friend_block(p_me uuid, p_handle text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE o public.sim_profiles; f public.sim_friendships; v_found boolean;
BEGIN
  PERFORM public.sim_ensure_profile(p_me);
  SELECT * INTO o FROM public.sim_profiles WHERE handle = p_handle;
  IF NOT FOUND OR o.hidden THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF o.user_id = p_me THEN RETURN jsonb_build_object('status', 'self'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:friend:' || least(p_me, o.user_id)::text || greatest(p_me, o.user_id)::text, 0));
  SELECT * INTO f FROM public.sim_friendships WHERE user_a = least(p_me, o.user_id) AND user_b = greatest(p_me, o.user_id);
  v_found := FOUND;
  IF NOT v_found AND o.visibility = 'private' THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_found AND f.status = 'blocked' THEN
    -- already blocked (by either of us): the pair is already hidden from each other
    IF f.blocked_by <> p_me THEN
      RETURN jsonb_build_object('status', 'ok', 'friend', jsonb_build_object('handle', o.handle, 'displayName', NULL, 'status', 'blocked', 'since', public.sim_iso(coalesce(f.decided_at, f.created_at))));
    END IF;
    RETURN jsonb_build_object('status', 'ok', 'friend', public.sim_friend_item(p_me, f));
  END IF;
  IF v_found THEN
    UPDATE public.sim_friendships SET status = 'blocked', blocked_by = p_me, decided_at = now() WHERE id = f.id RETURNING * INTO f;
  ELSE
    INSERT INTO public.sim_friendships(user_a, user_b, requested_by, status, blocked_by, decided_at)
    VALUES (least(p_me, o.user_id), greatest(p_me, o.user_id), p_me, 'blocked', p_me, now()) RETURNING * INTO f;
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'friend', public.sim_friend_item(p_me, f));
END $$;

-- ---------------------------------------------------------------- leaderboards

-- Every driver's best lap on one track and car, as p_viewer may see the board: valid, plausible and not hidden laps of people whose
-- profile is not hidden. scope public: public profiles, not blocked either way. scope friends: the viewer and their accepted friends
-- (a private friend is left out). Ranked by time (ties share a rank, the earlier lap first); gap_ms is the distance to the leader.
CREATE FUNCTION public.sim_board(p_viewer uuid, p_track uuid, p_car uuid, p_scope text)
RETURNS TABLE (rank bigint, pos bigint, lap_id uuid, user_id uuid, time_ms integer, started_at timestamptz, gap_ms integer, handle text, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH best AS (
    SELECT DISTINCT ON (l.user_id) l.user_id AS uid, l.id AS lid, l.time_ms AS ms, l.started_at AS st, p.handle AS hd, p.display_name AS dn
    FROM public.sim_laps l JOIN public.sim_profiles p ON p.user_id = l.user_id
    WHERE l.track_id = p_track AND l.car_id = p_car AND l.valid AND l.plausible IS TRUE AND NOT l.hidden AND l.time_ms > 0 AND NOT p.hidden
      AND CASE p_scope
        WHEN 'public' THEN p.visibility = 'public' AND NOT EXISTS (
          SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'blocked')
        ELSE l.user_id = p_viewer OR (p.visibility <> 'private' AND EXISTS (
          SELECT 1 FROM public.sim_friendships f WHERE f.user_a = least(p_viewer, l.user_id) AND f.user_b = greatest(p_viewer, l.user_id) AND f.status = 'accepted'))
      END
    ORDER BY l.user_id, l.time_ms, l.started_at, l.id)
  SELECT rank() OVER (ORDER BY b.ms), row_number() OVER (ORDER BY b.ms, b.st, b.lid), b.lid, b.uid, b.ms, b.st,
         b.ms - min(b.ms) OVER (), b.hd, b.dn
  FROM best b
$$;

CREATE FUNCTION public.sim_leaderboard(
  p_viewer uuid, p_track uuid, p_car uuid, p_scope text,
  p_after_ms integer DEFAULT NULL, p_after_t timestamptz DEFAULT NULL, p_after_lap uuid DEFAULT NULL, p_limit integer DEFAULT 51
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.pos), '[]'::jsonb) FROM (
    SELECT b.pos, jsonb_build_object('rank', b.rank, 'lapId', b.lap_id, 'handle', b.handle, 'displayName', b.display_name, 'timeMs', b.time_ms,
      'gapMs', b.gap_ms, 'achievedAt', public.sim_iso(b.started_at), 'isMe', b.user_id = p_viewer,
      '_ms', b.time_ms, '_t', public.sim_iso_us(b.started_at), '_i', b.lap_id) AS item
    FROM public.sim_board(p_viewer, p_track, p_car, p_scope) b
    WHERE p_after_lap IS NULL OR (b.time_ms, b.started_at, b.lap_id) > (p_after_ms, p_after_t, p_after_lap)
    ORDER BY b.pos LIMIT p_limit) x
$$;

-- The caller's own rank on a board and the two drivers above and below them.
CREATE FUNCTION public.sim_leaderboard_me(p_viewer uuid, p_track uuid, p_car uuid, p_scope text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH b AS MATERIALIZED (SELECT * FROM public.sim_board(p_viewer, p_track, p_car, p_scope)),
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

-- ---------------------------------------------------------------- share links

CREATE FUNCTION public.sim_share_item(s public.sim_shares) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', s.id, 'kind', CASE WHEN s.lap_id IS NOT NULL THEN 'lap' ELSE 'session' END, 'lapId', s.lap_id, 'sessionId', s.session_id,
    'createdAt', public.sim_iso(s.created_at), 'expiresAt', CASE WHEN s.expires_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(s.expires_at)) END,
    'revokedAt', CASE WHEN s.revoked_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(s.revoked_at)) END,
    'active', s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()))
$$;

-- Makes a link for one of the person's own laps or sessions. At most 100 active links per person.
-- {status: ok | not_found | limit, share}
CREATE FUNCTION public.sim_share_create(p_user uuid, p_token_hash text, p_lap uuid, p_session uuid, p_expires timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.sim_shares;
BEGIN
  IF p_lap IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sim_laps WHERE id = p_lap AND user_id = p_user AND NOT hidden) THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF p_session IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sim_sessions WHERE id = p_session AND user_id = p_user) THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:share:' || p_user::text, 0));
  IF (SELECT count(*) FROM public.sim_shares WHERE created_by = p_user AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) >= 100 THEN
    RETURN jsonb_build_object('status', 'limit');
  END IF;
  INSERT INTO public.sim_shares(token_hash, lap_id, session_id, created_by, expires_at) VALUES (p_token_hash, p_lap, p_session, p_user, p_expires) RETURNING * INTO s;
  RETURN jsonb_build_object('status', 'ok', 'share', public.sim_share_item(s));
END $$;

CREATE FUNCTION public.sim_share_list(p_user uuid, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.t DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT s.created_at AS t, s.id, public.sim_share_item(s) || jsonb_build_object('_k', public.sim_iso_us(s.created_at), '_i', s.id) AS item
    FROM public.sim_shares s
    WHERE s.created_by = p_user AND (p_after_id IS NULL OR (s.created_at, s.id) < (p_after_t, p_after_id))
    ORDER BY s.created_at DESC, s.id DESC LIMIT p_limit) x
$$;

CREATE FUNCTION public.sim_share_revoke(p_user uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_found integer;
BEGIN
  UPDATE public.sim_shares SET revoked_at = coalesce(revoked_at, now()) WHERE id = p_id AND created_by = p_user;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END $$;

-- What a public link shows, or NULL for a token that is unknown, revoked, expired, whose lap or profile is hidden. The driver's name
-- and handle are given unless the profile is private. No account id, e-mail, device or file path is ever part of it.
CREATE FUNCTION public.sim_share_view(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.sim_shares; p public.sim_profiles; v_driver jsonb; v_lap jsonb; v_session jsonb; ses public.sim_sessions;
BEGIN
  SELECT * INTO s FROM public.sim_shares WHERE token_hash = p_token_hash AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM public.sim_profiles WHERE user_id = s.created_by;
  IF FOUND AND p.hidden THEN RETURN NULL; END IF;
  v_driver := CASE WHEN FOUND AND p.visibility <> 'private' THEN jsonb_build_object('handle', p.handle, 'displayName', p.display_name) END;
  IF s.lap_id IS NOT NULL THEN
    SELECT jsonb_build_object('id', l.id, 'game', l.game, 'track', jsonb_build_object('name', coalesce(t.name, l.track_name), 'lengthM', t.length_m),
      'car', jsonb_build_object('name', coalesce(c.name, l.car_name), 'class', c.class), 'lapNumber', l.lap_number, 'timeMs', l.time_ms, 'valid', l.valid,
      'startedAt', public.sim_iso(l.started_at), 'sectorsMs', to_jsonb(l.sector_ms), 'topSpeedKmh', l.top_speed_kmh)
      INTO v_lap
      FROM public.sim_laps l LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
      WHERE l.id = s.lap_id AND NOT l.hidden;
    IF v_lap IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('kind', 'lap', 'createdAt', public.sim_iso(s.created_at), 'expiresAt', CASE WHEN s.expires_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(s.expires_at)) END,
      'driver', v_driver, 'lap', v_lap);
  END IF;
  SELECT * INTO ses FROM public.sim_sessions WHERE id = s.session_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT jsonb_build_object('game', ses.game, 'track', jsonb_build_object('name', t.name, 'lengthM', t.length_m), 'car', jsonb_build_object('name', c.name, 'class', c.class),
      'kind', ses.kind, 'startedAt', public.sim_iso(ses.started_at), 'endedAt', public.sim_iso(ses.ended_at), 'weather', ses.weather,
      'airTempC', ses.air_temp_c, 'trackTempC', ses.track_temp_c,
      'lapCount', (SELECT count(*) FROM public.sim_laps l WHERE l.session_id = ses.id AND NOT l.hidden),
      'bestLapMs', (SELECT min(l.time_ms) FROM public.sim_laps l WHERE l.session_id = ses.id AND NOT l.hidden AND l.valid AND l.time_ms > 0),
      'laps', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'lapNumber', x.lap_number, 'timeMs', x.time_ms, 'valid', x.valid,
          'startedAt', public.sim_iso(x.started_at), 'sectorsMs', to_jsonb(x.sector_ms), 'topSpeedKmh', x.top_speed_kmh) ORDER BY x.started_at, x.id), '[]'::jsonb)
        FROM (SELECT * FROM public.sim_laps l WHERE l.session_id = ses.id AND NOT l.hidden ORDER BY l.started_at, l.id LIMIT 500) x))
    INTO v_session
    FROM public.sim_track_catalog t, public.sim_car_catalog c WHERE t.id = ses.track_id AND c.id = ses.car_id;
  RETURN jsonb_build_object('kind', 'session', 'createdAt', public.sim_iso(s.created_at), 'expiresAt', CASE WHEN s.expires_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(s.expires_at)) END,
    'driver', v_driver, 'session', v_session);
END $$;

-- The stored file of a lap that a live link covers (the lap itself, or any lap of the linked session), else NULL.
CREATE FUNCTION public.sim_share_file_path(p_token_hash text, p_lap uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.storage_path
  FROM public.sim_shares s JOIN public.sim_laps l ON l.user_id = s.created_by AND l.id = p_lap AND NOT l.hidden
    AND (s.lap_id = l.id OR (s.session_id IS NOT NULL AND l.session_id = s.session_id))
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
    AND NOT EXISTS (SELECT 1 FROM public.sim_profiles p WHERE p.user_id = s.created_by AND p.hidden)
$$;

-- ---------------------------------------------------------------- reports and moderation

-- {status: ok | not_found | self | duplicate | limit, id, createdAt}. A profile is reported by handle and a lap by id, and only when the
-- reporter could see it; anything else is not_found.
CREATE FUNCTION public.sim_report_create(p_reporter uuid, p_kind text, p_handle text, p_lap uuid, p_reason text, p_details text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_target uuid; v_owner uuid; v_id uuid; v_at timestamptz;
BEGIN
  PERFORM public.sim_ensure_profile(p_reporter);
  IF p_kind = 'profile' THEN
    SELECT user_id INTO v_owner FROM public.sim_profiles WHERE handle = p_handle;
    v_target := v_owner;
  ELSE
    SELECT user_id INTO v_owner FROM public.sim_laps WHERE id = p_lap AND NOT hidden;
    v_target := p_lap;
  END IF;
  IF v_owner IS NULL OR NOT public.sim_profile_visible_to(p_reporter, v_owner) THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF v_owner = p_reporter THEN RETURN jsonb_build_object('status', 'self'); END IF;
  IF (SELECT count(*) FROM public.sim_reports WHERE reporter_id = p_reporter AND status = 'open') >= 50 THEN RETURN jsonb_build_object('status', 'limit'); END IF;
  BEGIN
    INSERT INTO public.sim_reports(reporter_id, target_kind, target_id, reason, details) VALUES (p_reporter, p_kind, v_target, p_reason, p_details)
      RETURNING id, created_at INTO v_id, v_at;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'duplicate');
  END;
  RETURN jsonb_build_object('status', 'ok', 'id', v_id, 'createdAt', public.sim_iso(v_at));
END $$;

CREATE FUNCTION public.sim_report_item(r public.sim_reports) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('id', r.id, 'kind', r.target_kind, 'status', r.status, 'reason', r.reason, 'details', r.details,
    'createdAt', public.sim_iso(r.created_at), 'decidedAt', CASE WHEN r.decided_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(r.decided_at)) END,
    'reporter', (SELECT jsonb_build_object('handle', p.handle, 'displayName', p.display_name) FROM public.sim_profiles p WHERE p.user_id = r.reporter_id),
    'target', CASE r.target_kind
      WHEN 'profile' THEN (SELECT jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'visibility', p.visibility, 'hidden', p.hidden)
        FROM public.sim_profiles p WHERE p.user_id = r.target_id)
      ELSE (SELECT jsonb_build_object('lapId', l.id, 'game', l.game, 'track', coalesce(t.name, l.track_name), 'car', coalesce(c.name, l.car_name), 'timeMs', l.time_ms,
          'plausible', l.plausible, 'hidden', l.hidden, 'owner', (SELECT jsonb_build_object('handle', p.handle, 'displayName', p.display_name) FROM public.sim_profiles p WHERE p.user_id = l.user_id))
        FROM public.sim_laps l LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id WHERE l.id = r.target_id)
    END)
$$;

CREATE FUNCTION public.sim_admin_reports(p_status text, p_after_t timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 51) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.t DESC, x.id DESC), '[]'::jsonb) FROM (
    SELECT r.created_at AS t, r.id, public.sim_report_item(r) || jsonb_build_object('_k', public.sim_iso_us(r.created_at), '_i', r.id) AS item
    FROM public.sim_reports r
    WHERE (p_status = 'all' OR r.status = p_status) AND (p_after_id IS NULL OR (r.created_at, r.id) < (p_after_t, p_after_id))
    ORDER BY r.created_at DESC, r.id DESC LIMIT p_limit) x
$$;

-- A moderator decides a report. dismiss: no action. action: the report is actioned, and the target is hidden when p_hide. unhide: the
-- target is shown again (an open report is dismissed). {status: ok | not_found | already_decided, report}
CREATE FUNCTION public.sim_admin_decide(p_id uuid, p_admin uuid, p_action text, p_hide boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.sim_reports;
BEGIN
  SELECT * INTO r FROM public.sim_reports WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF p_action <> 'unhide' AND r.status <> 'open' THEN RETURN jsonb_build_object('status', 'already_decided'); END IF;
  IF p_action = 'unhide' OR (p_action = 'action' AND p_hide) THEN
    IF r.target_kind = 'profile' THEN UPDATE public.sim_profiles SET hidden = (p_action <> 'unhide'), updated_at = now() WHERE user_id = r.target_id;
    ELSE UPDATE public.sim_laps SET hidden = (p_action <> 'unhide') WHERE id = r.target_id; END IF;
  END IF;
  IF r.status = 'open' THEN
    UPDATE public.sim_reports SET status = CASE WHEN p_action = 'action' THEN 'actioned' ELSE 'dismissed' END, decided_at = now(), decided_by = p_admin
      WHERE id = r.id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status', 'ok', 'report', public.sim_report_item(r));
END $$;

-- What a moderator needs to judge a lap: its numbers, the failed plausibility checks, who drove it (handle and name only), the reports.
CREATE FUNCTION public.sim_admin_lap(p_lap uuid) RETURNS jsonb
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
      'plausible', l.plausible, 'plausibility', l.plausibility, 'hidden', l.hidden),
    'owner', CASE WHEN p.user_id IS NULL THEN NULL ELSE jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'visibility', p.visibility, 'hidden', p.hidden) END,
    'onLeaderboard', l.valid AND l.plausible IS TRUE AND NOT l.hidden AND coalesce(p.visibility = 'public' AND NOT p.hidden, false),
    'reports', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'reason', r.reason, 'createdAt', public.sim_iso(r.created_at)) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM public.sim_reports r WHERE r.target_kind = 'lap' AND r.target_id = l.id));
END $$;

-- ---------------------------------------------------------------- plausibility of laps that arrived before the check existed

-- Up to p_limit laps with no check yet, oldest first, and how many are left. {rows: [{id, storage_path}], remaining}
CREATE FUNCTION public.sim_unchecked_laps(p_limit integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'storage_path', x.storage_path)), '[]'::jsonb)
      FROM (SELECT id, storage_path FROM public.sim_laps WHERE plausible IS NULL ORDER BY created_at, id LIMIT p_limit) x),
    'remaining', (SELECT count(*) FROM public.sim_laps WHERE plausible IS NULL))
$$;

CREATE FUNCTION public.sim_set_plausibility(p_id uuid, p_plausible boolean, p_plausibility jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  UPDATE public.sim_laps SET plausible = p_plausible, plausibility = p_plausibility WHERE id = p_id AND plausible IS NULL
$$;

-- ---------------------------------------------------------------- the ingest, now with plausibility and the profile

-- The same transaction as before (admission, catalog, session, the row with its triggers, the device's last-lap time), plus: the
-- person's profile exists once their first lap is in, and the plausibility the server worked out from the file is stored beside the lap.
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
    plausible, plausibility)
  VALUES (p_user_id, p_device_id, p_lap->>'identity', p_lap->>'game', p_lap->>'track_name', p_lap->>'car_name',
    (p_lap->>'lap_number')::integer, v_ms, (p_lap->>'valid')::boolean, v_started,
    (p_lap->>'sample_count')::integer, (p_lap->>'size_bytes')::integer, p_lap->>'storage_path', v_track, v_car, v_session,
    v_sectors, (p_lap->>'top_speed_kmh')::real, (p_lap->>'fuel_used_l')::real,
    (p_lap->>'in_lap')::boolean, (p_lap->>'out_lap')::boolean, coalesce((p_lap->>'format_version')::smallint, 1),
    (p_lap->>'plausible')::boolean, p_lap->'plausibility')
  ON CONFLICT (user_id, identity) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.sim_refresh_session(v_session);
    SELECT id INTO v_id FROM public.sim_laps WHERE user_id = p_user_id AND identity = p_lap->>'identity';
    RETURN jsonb_build_object('status', 'duplicate', 'id', v_id);
  END IF;
  UPDATE public.sim_devices SET last_lap_at = now() WHERE id = p_device_id;
  RETURN jsonb_build_object('status', 'created', 'id', v_id);
END $$;

-- ---------------------------------------------------------------- privacy rights

-- Everything of the person's Virtual data, as one JSON document. Friends are listed by handle only; no e-mail (theirs or anyone's) and no
-- secret (device key hash, share token) is in it. The lap files are linked by the server, from the lap ids.
CREATE FUNCTION public.sim_export_me(p_user uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'profile', (SELECT jsonb_build_object('handle', p.handle, 'displayName', p.display_name, 'visibility', p.visibility,
        'createdAt', public.sim_iso(p.created_at), 'updatedAt', public.sim_iso(p.updated_at)) FROM public.sim_profiles p WHERE p.user_id = p_user),
    'friends', (SELECT coalesce(jsonb_agg(jsonb_build_object('handle', op.handle,
        'status', CASE f.status WHEN 'accepted' THEN 'accepted' WHEN 'blocked' THEN 'blocked'
                  ELSE CASE WHEN f.requested_by = p_user THEN 'outgoing' ELSE 'incoming' END END,
        'since', public.sim_iso(coalesce(f.decided_at, f.created_at))) ORDER BY f.created_at), '[]'::jsonb)
      FROM public.sim_friendships f JOIN public.sim_profiles op ON op.user_id = CASE WHEN f.user_a = p_user THEN f.user_b ELSE f.user_a END
      WHERE (f.user_a = p_user OR f.user_b = p_user) AND NOT (f.status = 'blocked' AND f.blocked_by <> p_user)),
    'sessions', (SELECT coalesce(jsonb_agg(public.sim_session_json(s, t.name, c.name) ORDER BY s.started_at, s.id), '[]'::jsonb)
      FROM public.sim_sessions s JOIN public.sim_track_catalog t ON t.id = s.track_id JOIN public.sim_car_catalog c ON c.id = s.car_id WHERE s.user_id = p_user),
    'laps', (SELECT coalesce(jsonb_agg(public.sim_lap_json(l, t.name, c.name, d.name)
          || jsonb_build_object('marked', l.marked, 'plausible', l.plausible, 'plausibility', l.plausibility) ORDER BY l.started_at, l.id), '[]'::jsonb)
      FROM public.sim_laps l LEFT JOIN public.sim_track_catalog t ON t.id = l.track_id LEFT JOIN public.sim_car_catalog c ON c.id = l.car_id
        LEFT JOIN public.sim_devices d ON d.id = l.device_id WHERE l.user_id = p_user),
    'personalBests', (SELECT coalesce(jsonb_agg(jsonb_build_object('game', t.game, 'track', jsonb_build_object('id', t.id, 'name', t.name),
        'car', jsonb_build_object('id', c.id, 'name', c.name), 'bestMs', b.best_ms, 'lapId', b.lap_id, 'achievedAt', public.sim_iso(b.achieved_at)) ORDER BY b.achieved_at, b.lap_id), '[]'::jsonb)
      FROM public.sim_personal_bests b JOIN public.sim_track_catalog t ON t.id = b.track_id JOIN public.sim_car_catalog c ON c.id = b.car_id WHERE b.user_id = p_user),
    'devices', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'pairedAt', public.sim_iso(d.created_at),
        'lastSeenAt', CASE WHEN d.last_seen_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(d.last_seen_at)) END,
        'lastLapAt', CASE WHEN d.last_lap_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(d.last_lap_at)) END,
        'revokedAt', CASE WHEN d.revoked_at IS NULL THEN NULL ELSE to_jsonb(public.sim_iso(d.revoked_at)) END) ORDER BY d.created_at), '[]'::jsonb)
      FROM public.sim_devices d WHERE d.user_id = p_user),
    'shares', (SELECT coalesce(jsonb_agg(public.sim_share_item(s) ORDER BY s.created_at, s.id), '[]'::jsonb) FROM public.sim_shares s WHERE s.created_by = p_user),
    'trackLayouts', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'game', k.game, 'track', k.track_name, 'variant', k.variant, 'title', k.title,
        'lengthM', k.length_m, 'sizeBytes', k.size_bytes, 'updatedAt', public.sim_iso(k.updated_at)) ORDER BY k.updated_at, k.id), '[]'::jsonb)
      FROM public.sim_tracks k WHERE k.user_id = p_user),
    'reportsMade', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', r.target_kind, 'reason', r.reason, 'details', r.details, 'status', r.status,
        'createdAt', public.sim_iso(r.created_at)) ORDER BY r.created_at, r.id), '[]'::jsonb) FROM public.sim_reports r WHERE r.reporter_id = p_user));
$$;

-- Deletes the person's Virtual data (not the account): laps, sessions, personal bests, track layouts, shares, friendships, the reports
-- they made and the ones about them, the profile, the devices and their pairing codes. Answers the stored files to remove (the server
-- removes them) and what was deleted.
CREATE FUNCTION public.sim_delete_my_data(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_lap_ids uuid[]; v_lap_paths text[]; v_track_paths text[];
  v_laps integer; v_sessions integer; v_tracks integer; v_shares integer; v_friends integer; v_reports integer; v_devices integer; v_profile integer;
BEGIN
  -- the same lock as an upload takes: a lap in flight finishes before this starts, or starts after it
  PERFORM pg_advisory_xact_lock(hashtextextended('sim:' || p_user::text, 0));
  v_lap_ids := ARRAY(SELECT id FROM public.sim_laps WHERE user_id = p_user);
  -- counted first: deleting the laps already takes their sessions and links with it
  v_sessions := (SELECT count(*) FROM public.sim_sessions WHERE user_id = p_user);
  v_shares := (SELECT count(*) FROM public.sim_shares WHERE created_by = p_user OR lap_id = ANY (v_lap_ids));
  WITH gone AS (DELETE FROM public.sim_laps WHERE user_id = p_user RETURNING storage_path)
    SELECT coalesce(array_agg(storage_path), '{}') INTO v_lap_paths FROM gone;
  v_laps := cardinality(v_lap_ids);
  DELETE FROM public.sim_sessions WHERE user_id = p_user;
  DELETE FROM public.sim_personal_bests WHERE user_id = p_user;
  WITH gone AS (DELETE FROM public.sim_tracks WHERE user_id = p_user RETURNING storage_path)
    SELECT coalesce(array_agg(storage_path), '{}') INTO v_track_paths FROM gone;
  v_tracks := cardinality(v_track_paths);
  DELETE FROM public.sim_shares WHERE created_by = p_user OR lap_id = ANY (v_lap_ids);
  DELETE FROM public.sim_friendships WHERE user_a = p_user OR user_b = p_user;
  GET DIAGNOSTICS v_friends = ROW_COUNT;
  DELETE FROM public.sim_reports WHERE reporter_id = p_user OR (target_kind = 'profile' AND target_id = p_user) OR (target_kind = 'lap' AND target_id = ANY (v_lap_ids));
  GET DIAGNOSTICS v_reports = ROW_COUNT;
  DELETE FROM public.sim_handle_changes WHERE user_id = p_user;
  DELETE FROM public.sim_profiles WHERE user_id = p_user;
  GET DIAGNOSTICS v_profile = ROW_COUNT;
  DELETE FROM public.sim_link_requests WHERE user_id = p_user;
  DELETE FROM public.sim_pairing_codes WHERE user_id = p_user;
  DELETE FROM public.sim_devices WHERE user_id = p_user;
  GET DIAGNOSTICS v_devices = ROW_COUNT;
  RETURN jsonb_build_object('lapPaths', to_jsonb(v_lap_paths), 'trackPaths', to_jsonb(v_track_paths),
    'deleted', jsonb_build_object('laps', v_laps, 'sessions', v_sessions, 'trackLayouts', v_tracks, 'shares', v_shares, 'friendships', v_friends,
      'reports', v_reports, 'devices', v_devices, 'profile', v_profile > 0));
END $$;

-- ---------------------------------------------------------------- who may call what

DO $grants$
DECLARE f record;
BEGIN
  -- Only the server: it resolves the signed-in person first and passes their id.
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'sim_ensure_profile', 'sim_profile_visible_to', 'sim_my_profile', 'sim_set_profile', 'sim_profile_page', 'sim_friend_count', 'sim_friend_item',
    'sim_friend_list', 'sim_friend_request', 'sim_friend_decide', 'sim_friend_remove', 'sim_friend_block', 'sim_board', 'sim_leaderboard',
    'sim_leaderboard_me', 'sim_share_item', 'sim_share_create', 'sim_share_list', 'sim_share_revoke', 'sim_share_view', 'sim_share_file_path',
    'sim_report_create', 'sim_report_item', 'sim_admin_reports', 'sim_admin_decide', 'sim_admin_lap', 'sim_unchecked_laps', 'sim_set_plausibility',
    'sim_export_me', 'sim_delete_my_data', 'sim_ingest_lap')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $grants$;
