-- First-party error tracking: when the site breaks in somebody's browser, or Xpeed Companion fails on somebody's computer, the owner finds out
-- from the app's own database (no third-party error service). Reports arrive through POST /api/client-errors (site) and POST
-- /api/sim/companion-errors (Companion, device key); the Problems section of the admin page reads them.
--
-- What is stored is already scrubbed by the server (api/client-errors.ts): a message, a trimmed stack, the route WITHOUT its query string,
-- the build, a browser or OS family, a fingerprint. Never an e-mail, a phone number, a token or a person's id: who was affected is
-- counted from a one-way hash, only to say "N people".
--
-- Additive and idempotent: new tables (IF NOT EXISTS), new functions (CREATE OR REPLACE), grants that can be repeated. Nothing existing is touched.

-- One row per distinct problem (the same bug on every computer and every build is one group).
CREATE TABLE IF NOT EXISTS public.error_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('site', 'companion')),
  fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 8 AND 64),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  occurrences bigint NOT NULL DEFAULT 1,
  sample_message text NOT NULL CHECK (char_length(sample_message) <= 600),
  sample_stack text NOT NULL DEFAULT '' CHECK (char_length(sample_stack) <= 4200),
  sample_route text CHECK (char_length(sample_route) <= 200),
  version text CHECK (char_length(version) <= 64),
  agent text CHECK (char_length(agent) <= 64),
  worker text CHECK (char_length(worker) <= 64),
  affected_users integer NOT NULL DEFAULT 0,
  resolved_at timestamptz,
  reopened_count integer NOT NULL DEFAULT 0,
  UNIQUE (source, fingerprint)
);
CREATE INDEX IF NOT EXISTS error_groups_last_seen_idx ON public.error_groups (last_seen DESC);

-- Who was affected, as a one-way hash (never the account id): only to count people. Gone with the group.
CREATE TABLE IF NOT EXISTS public.error_group_users (
  group_id uuid NOT NULL REFERENCES public.error_groups (id) ON DELETE CASCADE,
  user_hash text NOT NULL CHECK (char_length(user_hash) BETWEEN 16 AND 64),
  PRIMARY KEY (group_id, user_hash)
);

-- The most recent occurrences of each group (capped at 50 a group, and deleted after 30 days by the daily job).
CREATE TABLE IF NOT EXISTS public.error_occurrences (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES public.error_groups (id) ON DELETE CASCADE,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  version text CHECK (char_length(version) <= 64),
  route text CHECK (char_length(route) <= 200),
  agent text CHECK (char_length(agent) <= 64)
);
CREATE INDEX IF NOT EXISTS error_occurrences_group_idx ON public.error_occurrences (group_id, id DESC);
CREATE INDEX IF NOT EXISTS error_occurrences_received_idx ON public.error_occurrences (received_at);

-- Only the server (service role) reads or writes these: no policy, no grant to the browser roles.
ALTER TABLE public.error_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_group_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_occurrences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.error_groups, public.error_group_users, public.error_occurrences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.error_groups, public.error_group_users, public.error_occurrences TO service_role;

-- One report, in one call: finds the device behind the key (companion), counts the hit (per IP for the site, per device for
-- the Companion, in the database like the upload limiter so every server instance shares it), then records the occurrence in its group.
-- A flood of made-up messages cannot grow the table without end: past p_max_groups groups, new problems are dropped.
-- Answers
--   null                                  a Companion key that is unknown or revoked,
--   {status: 'rate', wait}                too many in this minute (nothing is written),
--   {status: 'full'}                      a new problem, but the table already holds p_max_groups: dropped,
--   {status: 'ok', group, isNew, reopened} recorded.
-- A resolved group reopens when an occurrence that happened after it was resolved arrives.
CREATE OR REPLACE FUNCTION public.error_report_record(
  p_source text, p_rate_key text, p_rate_max integer, p_token_hash text, p_user_hash text, p_fingerprint text,
  p_message text, p_stack text, p_route text, p_version text, p_agent text, p_worker text, p_occurred_at timestamptz,
  p_max_groups integer DEFAULT 2000
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_key text := p_rate_key; v_user text := p_user_hash; v_wait integer; v_device uuid; v_owner uuid;
  v_group uuid; v_new boolean := false; v_reopened boolean := false; v_resolved timestamptz; v_added integer;
  v_at timestamptz := least(greatest(coalesce(p_occurred_at, now()), now() - interval '1 day'), now());
BEGIN
  IF p_source NOT IN ('site', 'companion') THEN RAISE EXCEPTION 'invalid source'; END IF;
  IF p_source = 'companion' THEN
    SELECT id, user_id INTO v_device, v_owner FROM public.sim_devices WHERE token_hash = p_token_hash AND revoked_at IS NULL;
    IF v_device IS NULL THEN RETURN NULL; END IF;
    v_key := 'cerr:' || v_device::text;
    -- The same one-way hash the site's reports use (api/client-errors.ts), so a person is one person in both.
    v_user := encode(sha256(convert_to('xpeed-errors:' || v_owner::text, 'UTF8')), 'hex');
  END IF;

  v_wait := public.sim_rate_hit(v_key, p_rate_max, 60);
  IF v_wait > 0 THEN RETURN jsonb_build_object('status', 'rate', 'wait', v_wait); END IF;

  SELECT id, resolved_at INTO v_group, v_resolved FROM public.error_groups WHERE source = p_source AND fingerprint = p_fingerprint FOR UPDATE;
  IF v_group IS NULL THEN
    IF (SELECT count(*) FROM public.error_groups) >= p_max_groups THEN RETURN jsonb_build_object('status', 'full'); END IF;
    INSERT INTO public.error_groups (source, fingerprint, sample_message, sample_stack, sample_route, version, agent, worker, first_seen, last_seen)
    VALUES (p_source, p_fingerprint, p_message, p_stack, p_route, p_version, p_agent, p_worker, now(), now())
    ON CONFLICT (source, fingerprint) DO NOTHING RETURNING id INTO v_group;
    v_new := v_group IS NOT NULL;
    IF v_group IS NULL THEN
      SELECT id, resolved_at INTO v_group, v_resolved FROM public.error_groups WHERE source = p_source AND fingerprint = p_fingerprint FOR UPDATE;
    END IF;
  END IF;
  IF NOT v_new THEN
    v_reopened := v_resolved IS NOT NULL AND v_at > v_resolved;
    UPDATE public.error_groups SET
      occurrences = occurrences + 1, last_seen = now(),
      version = coalesce(p_version, version), agent = coalesce(p_agent, agent), worker = coalesce(p_worker, worker),
      resolved_at = CASE WHEN v_reopened THEN NULL ELSE resolved_at END,
      reopened_count = reopened_count + CASE WHEN v_reopened THEN 1 ELSE 0 END
    WHERE id = v_group;
  END IF;

  IF v_user IS NOT NULL THEN
    INSERT INTO public.error_group_users (group_id, user_hash) VALUES (v_group, v_user) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_added = ROW_COUNT;
    IF v_added > 0 THEN UPDATE public.error_groups SET affected_users = affected_users + 1 WHERE id = v_group; END IF;
  END IF;

  INSERT INTO public.error_occurrences (group_id, occurred_at, version, route, agent) VALUES (v_group, v_at, p_version, p_route, p_agent);
  -- Keep the latest 50 occurrences of the group.
  DELETE FROM public.error_occurrences WHERE group_id = v_group AND id < (
    SELECT min(id) FROM (SELECT id FROM public.error_occurrences WHERE group_id = v_group ORDER BY id DESC LIMIT 50) latest);

  RETURN jsonb_build_object('status', 'ok', 'group', v_group, 'isNew', v_new, 'reopened', v_reopened);
END $$;

-- The groups for the admin page, newest first. p_status: 'open' (default), 'resolved' or 'all'; p_source: null for both.
CREATE OR REPLACE FUNCTION public.error_groups_list(p_status text DEFAULT 'open', p_source text DEFAULT NULL, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.last_seen DESC, x.id), '[]'::jsonb) FROM (
    SELECT g.id, g.last_seen, jsonb_build_object(
      'id', g.id, 'source', g.source, 'fingerprint', g.fingerprint,
      'firstSeen', g.first_seen, 'lastSeen', g.last_seen, 'count', g.occurrences,
      'message', g.sample_message, 'stack', g.sample_stack, 'route', g.sample_route,
      'version', g.version, 'agent', g.agent, 'worker', g.worker,
      'affectedUsers', g.affected_users, 'resolvedAt', g.resolved_at, 'reopenedCount', g.reopened_count,
      'last24h', (SELECT count(*) FROM public.error_occurrences o WHERE o.group_id = g.id AND o.received_at > now() - interval '24 hours')) AS j
    FROM public.error_groups g
    WHERE (p_status = 'all' OR (p_status = 'resolved' AND g.resolved_at IS NOT NULL) OR (p_status = 'open' AND g.resolved_at IS NULL))
      AND (p_source IS NULL OR g.source = p_source)
    ORDER BY g.last_seen DESC, g.id LIMIT least(greatest(p_limit, 1), 200)) x
$$;

-- Marks a group resolved (or open again). Answers the new state, or null when there is no such group.
CREATE OR REPLACE FUNCTION public.error_group_set_resolved(p_id uuid, p_resolved boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_at timestamptz;
BEGIN
  UPDATE public.error_groups SET resolved_at = CASE WHEN p_resolved THEN now() ELSE NULL END WHERE id = p_id RETURNING resolved_at INTO v_at;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', p_id, 'resolvedAt', v_at);
END $$;

-- The daily retention job: occurrences older than p_days go; a resolved group that has not been seen for p_group_days goes with its people.
CREATE OR REPLACE FUNCTION public.error_retention(p_days integer DEFAULT 30, p_group_days integer DEFAULT 90) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_occ integer; v_groups integer;
BEGIN
  DELETE FROM public.error_occurrences WHERE received_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS v_occ = ROW_COUNT;
  DELETE FROM public.error_groups WHERE resolved_at IS NOT NULL AND last_seen < now() - make_interval(days => p_group_days);
  GET DIAGNOSTICS v_groups = ROW_COUNT;
  RETURN jsonb_build_object('occurrencesDeleted', v_occ, 'groupsDeleted', v_groups);
END $$;

REVOKE ALL ON FUNCTION public.error_report_record(text, text, integer, text, text, text, text, text, text, text, text, text, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.error_groups_list(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.error_group_set_resolved(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.error_retention(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.error_report_record(text, text, integer, text, text, text, text, text, text, text, text, text, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.error_groups_list(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.error_group_set_resolved(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.error_retention(integer, integer) TO service_role;
