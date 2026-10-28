-- Review fixes (2026-10-29). Idempotent: safe to run more than once, safe on live data.
--
--   1. app_settings: stop leaking system rows to anon (allow-list), drop the revoked gemini_api_key row
--   2. app_settings: unique per (user_id, key) so a user cannot squat an admin key; users cannot write admin_/system keys
--   3. car_profiles.country stays NOT NULL DEFAULT 'US' (the app now omits it when unset)
--   4. shared_reports: no public listing, insert only for the caller's own trip, minimal public payload
--   5. sessions / session_photos / chat_conversations / maintenance_events: the car must be the caller's; parameter_rules scoped
--   6. storage: owner-scoped policies for the session-csv bucket (the 2026-02 migration skipped them)
--   7. quota refund + cleanup of old rate-limit / OAuth rows
--   8. admin: exec_sql dropped, admins can no longer rewrite other users' cars, user_id and the admin car are protected
--   9. mcp_tokens: every token gets an expiry

-- ===========================================================================
-- 1 + 2. app_settings
-- ===========================================================================

-- The Gemini key was revoked and the code no longer reads it.
DELETE FROM public.app_settings WHERE setting_key = 'gemini_api_key';

-- Rows a user planted under a system-looking key (they would shadow or block the real one).
DELETE FROM public.app_settings
WHERE user_id IS NOT NULL
  AND (setting_key LIKE 'admin\_%' ESCAPE '\'
       OR setting_key LIKE 'system.%'
       OR setting_key = 'brand_config');

-- The old global UNIQUE(setting_key) let any user block an admin key by inserting it first.
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_setting_key_key;
DROP INDEX IF EXISTS public.app_settings_setting_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS app_settings_system_key_uniq
  ON public.app_settings (setting_key) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_settings_user_key_uniq
  ON public.app_settings (user_id, setting_key) WHERE user_id IS NOT NULL;

-- Public (anon) read: only the keys that are meant to be public.
--   brand_config -> read by api/brand/manifest.ts with the anon key
DROP POLICY IF EXISTS "Public read non-secret system settings" ON public.app_settings;
CREATE POLICY "Public read non-secret system settings" ON public.app_settings
  FOR SELECT TO anon, authenticated
  USING (user_id IS NULL AND setting_key IN ('brand_config'));

-- Admins read every system setting, secrets included (the admin panel shows the AI key and
-- model, and an UPDATE of a row needs SELECT access to it; "Admins manage system settings"
-- used to cover this and lost it when it was split per command).
DROP POLICY IF EXISTS "Admins read non-secret system settings" ON public.app_settings;
DROP POLICY IF EXISTS "Admins read system settings" ON public.app_settings;
CREATE POLICY "Admins read system settings" ON public.app_settings
  FOR SELECT TO authenticated
  USING (user_id IS NULL AND (SELECT public.is_admin_user()));

-- Per-user settings: the app does not write any today. Keep them possible, but only for
-- the user's own namespace, never under an admin_/system/brand key.
DROP POLICY IF EXISTS app_settings_own_user ON public.app_settings;
DROP POLICY IF EXISTS app_settings_own_user_select ON public.app_settings;
DROP POLICY IF EXISTS app_settings_own_user_write ON public.app_settings;

CREATE POLICY app_settings_own_user_select ON public.app_settings
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY app_settings_own_user_write ON public.app_settings
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND setting_key NOT LIKE 'admin\_%' ESCAPE '\'
    AND setting_key NOT LIKE 'system.%'
    AND setting_key <> 'brand_config'
  );

-- ===========================================================================
-- 3. car_profiles.country
-- ===========================================================================
UPDATE public.car_profiles SET country = 'US' WHERE country IS NULL;
ALTER TABLE public.car_profiles ALTER COLUMN country SET DEFAULT 'US';
ALTER TABLE public.car_profiles ALTER COLUMN country SET NOT NULL;

-- ===========================================================================
-- 4. shared_reports
-- ===========================================================================

-- The anon policy let anyone LIST every unexpired link. Reading goes through get_shared_report().
DROP POLICY IF EXISTS "Anyone with link can read" ON public.shared_reports;
DROP POLICY IF EXISTS "Users manage own shared reports" ON public.shared_reports;
DROP POLICY IF EXISTS shared_reports_owner_select ON public.shared_reports;
DROP POLICY IF EXISTS shared_reports_owner_insert ON public.shared_reports;
DROP POLICY IF EXISTS shared_reports_owner_update ON public.shared_reports;
DROP POLICY IF EXISTS shared_reports_owner_delete ON public.shared_reports;

CREATE POLICY shared_reports_owner_select ON public.shared_reports
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY shared_reports_owner_insert ON public.shared_reports
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND session_id IN (SELECT s.id FROM public.sessions s WHERE s.user_id = (SELECT auth.uid()))
  );

CREATE POLICY shared_reports_owner_update ON public.shared_reports
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND session_id IN (SELECT s.id FROM public.sessions s WHERE s.user_id = (SELECT auth.uid()))
  );

CREATE POLICY shared_reports_owner_delete ON public.shared_reports
  FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Public payload: only what the shared page shows (trip name/date/length, the car's
-- name/year/make/model/version/VIN, fault codes, and the readings with their numbers).
-- No source_csv, user ids, notes, report JSON, ruleset ids or is_admin.
CREATE OR REPLACE FUNCTION public.get_shared_report(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
  v_result JSON;
BEGIN
  SELECT session_id INTO v_session_id
  FROM public.shared_reports
  WHERE id = p_id AND (expires_at IS NULL OR expires_at > now());

  IF v_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.shared_reports SET view_count = view_count + 1 WHERE id = p_id;

  SELECT json_build_object(
    'session', json_build_object(
      'source_filename', s.source_filename,
      'session_start',   s.session_start,
      'uploaded_at',     s.uploaded_at,
      'duration_seconds', s.duration_seconds
    ),
    'car', CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object(
      'name',  c.name,
      'year',  c.year,
      'make',  c.make,
      'model', c.model,
      'trim',  c.trim,
      'vin',   c.vin
    ) END,
    'flags', COALESCE((
      SELECT json_agg(json_build_object(
        'severity',      f.severity,
        'canonical_key', f.canonical_key,
        'parameter_key', f.parameter_key,
        'message',       f.message,
        'evidence',      jsonb_strip_nulls(jsonb_build_object(
                           'max', f.evidence -> 'max',
                           'avg', f.evidence -> 'avg',
                           'min', f.evidence -> 'min'))
      ))
      FROM public.session_flags f WHERE f.session_id = s.id
    ), '[]'::json),
    'active_dtcs', COALESCE(s.active_dtcs, '[]'::jsonb)
  ) INTO v_result
  FROM public.sessions s
  LEFT JOIN public.car_profiles c ON c.id = s.car_profile_id
  WHERE s.id = v_session_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_shared_report(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_report(UUID) TO anon, authenticated;

-- ===========================================================================
-- 5. Rows may only point at the caller's own cars / trips
-- ===========================================================================

-- sessions: insert/update must keep car_profile_id on one of the caller's cars.
DROP POLICY IF EXISTS sessions_own ON public.sessions;
CREATE POLICY sessions_own ON public.sessions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (car_profile_id IS NULL
         OR car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid())))
  );

-- session_photos: the trip must be the caller's.
DROP POLICY IF EXISTS "Users can create own photos" ON public.session_photos;
CREATE POLICY "Users can create own photos" ON public.session_photos
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND session_id IN (SELECT s.id FROM public.sessions s WHERE s.user_id = (SELECT auth.uid()))
  );

-- chat_conversations: the car (when set) must be the caller's.
DROP POLICY IF EXISTS "Users can create own conversations" ON public.chat_conversations;
CREATE POLICY "Users can create own conversations" ON public.chat_conversations
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (car_profile_id IS NULL
         OR car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid())))
  );

DROP POLICY IF EXISTS "Users can update own conversations" ON public.chat_conversations;
CREATE POLICY "Users can update own conversations" ON public.chat_conversations
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (car_profile_id IS NULL
         OR car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid())))
  );

-- maintenance_events: same rule for the car.
DROP POLICY IF EXISTS "Users can create own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can create own maintenance" ON public.maintenance_events
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Users can update own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can update own maintenance" ON public.maintenance_events
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid()))
  );

-- parameter_rules: every signed-in user could read every user's rules (and so their car ids).
-- Global rules (car_profile_id IS NULL) stay readable by all; per-car rules only by the owner.
DROP POLICY IF EXISTS parameter_rules_select ON public.parameter_rules;
CREATE POLICY parameter_rules_select ON public.parameter_rules
  FOR SELECT TO authenticated
  USING (
    car_profile_id IS NULL
    OR car_profile_id IN (SELECT c.id FROM public.car_profiles c WHERE c.user_id = (SELECT auth.uid()))
  );

-- ===========================================================================
-- 6. Storage: session-csv (private bucket, objects live under <user id>/...)
-- ===========================================================================
DROP POLICY IF EXISTS "Users can upload own session CSV files" ON storage.objects;
DROP POLICY IF EXISTS "Users can read own session CSV files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own session CSV files" ON storage.objects;
DROP POLICY IF EXISTS session_csv_insert_own ON storage.objects;
DROP POLICY IF EXISTS session_csv_select_own ON storage.objects;
DROP POLICY IF EXISTS session_csv_delete_own ON storage.objects;

CREATE POLICY session_csv_insert_own ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'session-csv'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE POLICY session_csv_select_own ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'session-csv'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

CREATE POLICY session_csv_delete_own ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'session-csv'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );

-- ===========================================================================
-- 7. Quota refund + housekeeping
-- ===========================================================================

-- Gives back one unit when the AI call that the unit paid for failed (upstream 5xx, etc.).
CREATE OR REPLACE FUNCTION public.refund_quota(p_user_id uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_kind, 0));

  DELETE FROM public.user_quotas
  WHERE id = (
    SELECT id FROM public.user_quotas
    WHERE user_id = p_user_id
      AND kind = p_kind
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc')
    ORDER BY created_at DESC
    LIMIT 1
  );
END $$;

REVOKE ALL ON FUNCTION public.refund_quota(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_quota(uuid, text) TO service_role;

-- No pg_cron on this project: the OAuth function calls this now and then.
CREATE OR REPLACE FUNCTION public.cleanup_stale_security_rows()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.rate_limits WHERE window_start < now() - interval '1 day';
  DELETE FROM public.oauth_authorization_codes WHERE expires_at < now() - interval '1 day';
  DELETE FROM public.oauth_refresh_tokens
  WHERE expires_at < now() - interval '7 days'
     OR revoked_at < now() - interval '30 days';
END $$;

REVOKE ALL ON FUNCTION public.cleanup_stale_security_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_security_rows() TO service_role;

-- ===========================================================================
-- 8. Admin hardening
-- ===========================================================================

-- Arbitrary SQL for service_role; nothing in the app uses it any more.
DROP FUNCTION IF EXISTS public.exec_sql(text);

-- Admins could rewrite any user's cars (including user_id). They keep read access
-- (for support); writes are limited to the caller's own cars.
DROP POLICY IF EXISTS car_profiles_own_or_admin ON public.car_profiles;
DROP POLICY IF EXISTS car_profiles_own ON public.car_profiles;
DROP POLICY IF EXISTS car_profiles_admin_select ON public.car_profiles;

CREATE POLICY car_profiles_own ON public.car_profiles
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY car_profiles_admin_select ON public.car_profiles
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin_user()));

-- Ownership never changes through the API, and the car that carries the admin flag
-- cannot be deleted through the API (deleting it would silently remove admin rights).
-- Service-role / migration sessions and cascades from deleting a user are not affected.
CREATE OR REPLACE FUNCTION public.car_profiles_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(auth.role(), '') IN ('authenticated', 'anon')
       AND coalesce(OLD.is_admin, false)
       AND pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'the admin profile cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF coalesce(auth.role(), '') IN ('authenticated', 'anon')
     AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'car_profiles.user_id cannot be changed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS car_profiles_guard_update ON public.car_profiles;
CREATE TRIGGER car_profiles_guard_update
  BEFORE UPDATE ON public.car_profiles
  FOR EACH ROW EXECUTE FUNCTION public.car_profiles_guard();

DROP TRIGGER IF EXISTS car_profiles_guard_delete ON public.car_profiles;
CREATE TRIGGER car_profiles_guard_delete
  BEFORE DELETE ON public.car_profiles
  FOR EACH ROW EXECUTE FUNCTION public.car_profiles_guard();

-- ===========================================================================
-- 9. mcp_tokens: no token lives forever
-- ===========================================================================
UPDATE public.mcp_tokens
SET expires_at = created_at + interval '1 year'
WHERE expires_at IS NULL AND revoked_at IS NULL;
