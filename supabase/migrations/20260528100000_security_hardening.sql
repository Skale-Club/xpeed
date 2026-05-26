-- ============================================================
-- Security Hardening — full remediation of all advisor findings
-- ============================================================
-- Covers:
--   1. CRITICAL: exec_sql callable by anon/authenticated (arbitrary SQL execution)
--   2. RLS always-true policies replaced with user-scoped policies
--   3. Anon-callable SECURITY DEFINER functions locked down
--   4. All functions with mutable search_path fixed
--   5. Brand-assets listing: drop overly broad SELECT policy
--   6. auth_rls_initplan: wrap auth.uid() with (SELECT auth.uid())
--   7. Multiple permissive policies cleaned up
--   8. Duplicate index on mcp_tokens dropped
-- ============================================================


-- ============================================================
-- 1. CRITICAL: exec_sql — revoke & harden
-- ============================================================
-- exec_sql is a SECURITY DEFINER function that executes arbitrary SQL.
-- It must NEVER be callable by anon or authenticated via PostgREST.
REVOKE EXECUTE ON FUNCTION public.exec_sql(text) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.exec_sql(query text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  EXECUTE query;
END;
$$;


-- ============================================================
-- 2. Functions with mutable search_path — add SET search_path = ''
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_conversation_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.chat_conversations
  SET updated_at = now()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_user_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.user_id = auth.uid();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_is_admin_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION 'is_admin cannot be modified via UPDATE. Disable trigger car_profiles_lock_is_admin to change it.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_old_user_quotas()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF random() < 0.01 THEN
    DELETE FROM public.user_quotas
    WHERE created_at < now() - INTERVAL '14 days'
    AND id IN (
      SELECT id FROM public.user_quotas
      WHERE created_at < now() - INTERVAL '14 days'
      LIMIT 100
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.touch_vehicle_issue_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_parameter_baselines(p_car_profile_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.car_profiles
    WHERE id = p_car_profile_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized for this car profile';
  END IF;

  FOR v_window IN SELECT unnest(ARRAY[7, 30, 90]) LOOP
    INSERT INTO public.parameter_baselines (car_profile_id, canonical_key, window_days, mean, stddev, sample_count, computed_at)
    SELECT
      p_car_profile_id,
      s.canonical_key,
      v_window,
      AVG(s.avg_value)::DOUBLE PRECISION,
      COALESCE(STDDEV(s.avg_value), 0)::DOUBLE PRECISION,
      COUNT(*)::INTEGER,
      now()
    FROM (
      SELECT
        (summary_item ->> 'canonical_key')               AS canonical_key,
        (summary_item ->> 'avg')::DOUBLE PRECISION        AS avg_value
      FROM public.sessions sess,
           jsonb_array_elements(COALESCE(sess.summary->'summaries', '[]'::jsonb)) AS summary_item
      WHERE sess.car_profile_id = p_car_profile_id
        AND sess.uploaded_at >= now() - (v_window || ' days')::INTERVAL
        AND (summary_item->>'avg') IS NOT NULL
        AND (summary_item->>'canonical_key') IS NOT NULL
    ) s
    WHERE s.avg_value IS NOT NULL
    GROUP BY s.canonical_key
    HAVING COUNT(*) >= 3
    ON CONFLICT (car_profile_id, canonical_key, window_days)
    DO UPDATE SET
      mean = EXCLUDED.mean,
      stddev = EXCLUDED.stddev,
      sample_count = EXCLUDED.sample_count,
      computed_at = EXCLUDED.computed_at;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_parameter_baselines(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(
  p_car_profile_id UUID,
  p_date_from TIMESTAMP WITH TIME ZONE DEFAULT (now() - INTERVAL '30 days')
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSON;
BEGIN
  WITH session_scope AS (
    SELECT s.id, s.session_start, s.session_end, s.uploaded_at,
           s.duration_seconds, s.row_count, s.summary, s.active_dtcs
    FROM public.sessions s
    WHERE s.car_profile_id = p_car_profile_id
      AND s.user_id = auth.uid()
      AND (s.session_start IS NOT NULL AND s.session_start >= p_date_from
           OR s.uploaded_at >= p_date_from)
    ORDER BY COALESCE(s.session_start, s.uploaded_at) DESC
  ),
  flag_details AS (
    SELECT f.session_id, f.severity, f.canonical_key, f.resolved,
           COALESCE((f.evidence->>'pct_out_of_range')::DOUBLE PRECISION, 0) AS pct_out
    FROM public.session_flags f
    WHERE f.session_id IN (SELECT id FROM session_scope)
  ),
  flag_weights AS (
    SELECT
      session_id,
      SUM(
        CASE severity WHEN 'critical' THEN 1.0 WHEN 'attention' THEN 0.4 ELSE 0 END
        * CASE canonical_key
            WHEN 'coolant_temp'        THEN 18
            WHEN 'engine_load'         THEN 12
            WHEN 'battery_voltage_12v' THEN 10
            WHEN 'oil_temp'            THEN 14
            WHEN 'engine_rpm'          THEN 8
            WHEN 'intake_air_temp'     THEN 6
            WHEN 'stft_b1'             THEN 5
            WHEN 'ltft_b1'             THEN 5
            ELSE 7
          END
        * CASE WHEN COALESCE(resolved, false) THEN 0.2 ELSE 1.0 END
        * LEAST(1.5, GREATEST(0.3, pct_out / 50.0))
      ) AS weighted_loss,
      COUNT(*) FILTER (WHERE severity = 'attention') AS attention_count,
      COUNT(*) FILTER (WHERE severity = 'critical')  AS critical_count
    FROM flag_details
    GROUP BY session_id
  ),
  per_session AS (
    SELECT
      s.id,
      COALESCE(s.session_start, s.uploaded_at) AS effective_date,
      s.duration_seconds,
      COALESCE(fw.attention_count, 0) AS attention,
      COALESCE(fw.critical_count,  0) AS critical,
      GREATEST(0, 100 - LEAST(100, COALESCE(fw.weighted_loss, 0))::INT) AS session_score
    FROM session_scope s
    LEFT JOIN flag_weights fw ON fw.session_id = s.id
  ),
  recency_weighted AS (
    SELECT *,
      GREATEST(0.3, 1.0 - EXTRACT(EPOCH FROM (now() - effective_date))
                          / EXTRACT(EPOCH FROM INTERVAL '90 days')) AS recency_weight
    FROM per_session
  ),
  overall AS (
    SELECT
      COUNT(*) AS total_sessions,
      SUM(duration_seconds) AS total_duration_seconds,
      CASE WHEN SUM(recency_weight) > 0
        THEN COALESCE(ROUND(SUM(session_score * recency_weight) / SUM(recency_weight))::INT, 100)
        ELSE 100
      END AS health_score,
      SUM(attention) AS total_attention,
      SUM(critical)  AS total_critical,
      MAX(effective_date) AS last_upload
    FROM recency_weighted
  ),
  trend_rows AS (
    SELECT id, to_char(effective_date, 'Mon DD') AS date_label,
           attention, critical, session_score AS score
    FROM per_session
    ORDER BY effective_date DESC
    LIMIT 20
  ),
  active_dtcs_agg AS (
    SELECT COALESCE(jsonb_agg(DISTINCT dtc), '[]'::jsonb) AS dtcs
    FROM session_scope,
         jsonb_array_elements_text(COALESCE(active_dtcs, '[]'::jsonb)) AS dtc
  )
  SELECT json_build_object(
    'totalSessions',        o.total_sessions,
    'totalDurationSeconds', o.total_duration_seconds,
    'healthScore',          o.health_score,
    'totalAttention',       o.total_attention,
    'totalCritical',        o.total_critical,
    'lastUpload',           o.last_upload,
    'activeDtcs',           (SELECT dtcs FROM active_dtcs_agg),
    'status',               CASE
                              WHEN o.health_score >= 90 THEN 'Excellent'
                              WHEN o.health_score >= 70 THEN 'Good'
                              WHEN o.health_score >= 50 THEN 'Attention'
                              ELSE 'Critical'
                            END,
    'trendData',            COALESCE(
                              (SELECT json_agg(row_to_json(t)) FROM trend_rows t),
                              '[]'::json
                            )
  ) INTO v_result
  FROM overall o;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(UUID, TIMESTAMP WITH TIME ZONE) TO authenticated;


-- ============================================================
-- 3. Fix EXECUTE grants — revoke from PUBLIC, scope to correct roles
-- ============================================================
-- PostgreSQL grants EXECUTE to PUBLIC by default; REVOKE from role-specific
-- targets is a no-op when PUBLIC still holds the grant.

-- exec_sql: service_role only (never callable via PostgREST API)
REVOKE EXECUTE ON FUNCTION public.exec_sql(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

-- set_user_id: trigger function — no external role should call it via RPC
REVOKE EXECUTE ON FUNCTION public.set_user_id() FROM PUBLIC;

-- get_dashboard_stats: authenticated only
REVOKE EXECUTE ON FUNCTION public.get_dashboard_stats(UUID, TIMESTAMP WITH TIME ZONE) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_dashboard_stats(UUID, TIMESTAMP WITH TIME ZONE) TO authenticated;

-- refresh_parameter_baselines: authenticated only
REVOKE EXECUTE ON FUNCTION public.refresh_parameter_baselines(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.refresh_parameter_baselines(UUID) TO authenticated;

-- is_admin_user: authenticated only (used in RLS policies and admin UI)
REVOKE EXECUTE ON FUNCTION public.is_admin_user() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_admin_user() TO authenticated;

-- is_current_user_admin: authenticated only
REVOKE EXECUTE ON FUNCTION public.is_current_user_admin() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated;

-- get_shared_report: anon + authenticated (shared-report feature is intentionally public)
REVOKE EXECUTE ON FUNCTION public.get_shared_report(UUID) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_shared_report(UUID) TO anon, authenticated;


-- ============================================================
-- 4. Replace always-true RLS policies with user-scoped ones
-- ============================================================

-- --- car_profiles ---
DROP POLICY IF EXISTS "Allow all access to car_profiles" ON public.car_profiles;
CREATE POLICY "car_profiles_own_or_admin" ON public.car_profiles
  FOR ALL
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_admin_user())
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR (SELECT public.is_admin_user())
  );

-- --- sessions ---
DROP POLICY IF EXISTS "Allow all access to sessions" ON public.sessions;
CREATE POLICY "sessions_own" ON public.sessions
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "sessions_admin_select" ON public.sessions
  FOR SELECT
  USING ((SELECT public.is_admin_user()));

-- --- session_rows ---
DROP POLICY IF EXISTS "Allow all access to session_rows" ON public.session_rows;
CREATE POLICY "session_rows_own" ON public.session_rows
  FOR ALL
  USING (
    session_id IN (
      SELECT id FROM public.sessions WHERE user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.sessions WHERE user_id = (SELECT auth.uid())
    )
  );

-- --- session_flags ---
DROP POLICY IF EXISTS "Allow all access to session_flags" ON public.session_flags;
CREATE POLICY "session_flags_own" ON public.session_flags
  FOR ALL
  USING (
    session_id IN (
      SELECT id FROM public.sessions WHERE user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    session_id IN (
      SELECT id FROM public.sessions WHERE user_id = (SELECT auth.uid())
    )
  );

-- --- parameter_rules ---
-- Rules are reference data (not PII); SELECT open to authenticated users.
-- Writes restricted to own car rules or admin for global rules.
DROP POLICY IF EXISTS "Allow all access to parameter_rules" ON public.parameter_rules;

CREATE POLICY "parameter_rules_select" ON public.parameter_rules
  FOR SELECT USING (true);

CREATE POLICY "parameter_rules_insert" ON public.parameter_rules
  FOR INSERT WITH CHECK (
    car_profile_id IN (
      SELECT id FROM public.car_profiles WHERE user_id = (SELECT auth.uid())
    )
    OR (car_profile_id IS NULL AND (SELECT public.is_admin_user()))
  );

CREATE POLICY "parameter_rules_update" ON public.parameter_rules
  FOR UPDATE USING (
    car_profile_id IN (
      SELECT id FROM public.car_profiles WHERE user_id = (SELECT auth.uid())
    )
    OR (car_profile_id IS NULL AND (SELECT public.is_admin_user()))
  );

CREATE POLICY "parameter_rules_delete" ON public.parameter_rules
  FOR DELETE USING (
    car_profile_id IN (
      SELECT id FROM public.car_profiles WHERE user_id = (SELECT auth.uid())
    )
    OR (car_profile_id IS NULL AND (SELECT public.is_admin_user()))
  );

-- --- app_settings ---
-- Drop the wide-open policy; keep "Admins manage system settings" and
-- "Public read non-secret system settings" (added in later migrations).
-- Add a user-scoped policy for per-user settings (user_id IS NOT NULL).
DROP POLICY IF EXISTS "Allow all access to app_settings" ON public.app_settings;

DROP POLICY IF EXISTS "app_settings_own_user" ON public.app_settings;
CREATE POLICY "app_settings_own_user" ON public.app_settings
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));


-- ============================================================
-- 5. Brand-assets: remove overly broad listing SELECT policy
-- ============================================================
-- The bucket is public=true; direct CDN URLs work without RLS.
-- Dropping the broad SELECT policy removes the listing attack surface.
DROP POLICY IF EXISTS "brand_assets_read_public" ON storage.objects;


-- ============================================================
-- 6. Fix auth_rls_initplan — wrap auth.uid() with (SELECT auth.uid())
-- ============================================================

-- chat_conversations
DROP POLICY IF EXISTS "Users can view own conversations"   ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can update own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can delete own conversations" ON public.chat_conversations;

CREATE POLICY "Users can view own conversations" ON public.chat_conversations
  FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can create own conversations" ON public.chat_conversations
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can update own conversations" ON public.chat_conversations
  FOR UPDATE USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can delete own conversations" ON public.chat_conversations
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- chat_messages (subquery also needs the fix)
DROP POLICY IF EXISTS "Users can view messages in own conversations"   ON public.chat_messages;
DROP POLICY IF EXISTS "Users can create messages in own conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can delete messages in own conversations" ON public.chat_messages;

CREATE POLICY "Users can view messages in own conversations" ON public.chat_messages
  FOR SELECT USING (
    conversation_id IN (
      SELECT id FROM public.chat_conversations
      WHERE user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY "Users can create messages in own conversations" ON public.chat_messages
  FOR INSERT WITH CHECK (
    conversation_id IN (
      SELECT id FROM public.chat_conversations
      WHERE user_id = (SELECT auth.uid())
    )
  );
CREATE POLICY "Users can delete messages in own conversations" ON public.chat_messages
  FOR DELETE USING (
    conversation_id IN (
      SELECT id FROM public.chat_conversations
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- maintenance_events
DROP POLICY IF EXISTS "Users can view own maintenance"   ON public.maintenance_events;
DROP POLICY IF EXISTS "Users can create own maintenance" ON public.maintenance_events;
DROP POLICY IF EXISTS "Users can update own maintenance" ON public.maintenance_events;
DROP POLICY IF EXISTS "Users can delete own maintenance" ON public.maintenance_events;

CREATE POLICY "Users can view own maintenance" ON public.maintenance_events
  FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can create own maintenance" ON public.maintenance_events
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can update own maintenance" ON public.maintenance_events
  FOR UPDATE USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can delete own maintenance" ON public.maintenance_events
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- parameter_baselines
DROP POLICY IF EXISTS "baselines_read_own" ON public.parameter_baselines;
CREATE POLICY "baselines_read_own" ON public.parameter_baselines
  FOR SELECT USING (
    car_profile_id IN (
      SELECT id FROM public.car_profiles
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- session_photos
DROP POLICY IF EXISTS "Users can view own photos"   ON public.session_photos;
DROP POLICY IF EXISTS "Users can create own photos" ON public.session_photos;
DROP POLICY IF EXISTS "Users can delete own photos" ON public.session_photos;

CREATE POLICY "Users can view own photos" ON public.session_photos
  FOR SELECT USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can create own photos" ON public.session_photos
  FOR INSERT WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can delete own photos" ON public.session_photos
  FOR DELETE USING (user_id = (SELECT auth.uid()));

-- shared_reports (Users manage own shared reports)
DROP POLICY IF EXISTS "Users manage own shared reports" ON public.shared_reports;
CREATE POLICY "Users manage own shared reports" ON public.shared_reports
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- user_quotas
DROP POLICY IF EXISTS "Users view own quota" ON public.user_quotas;
CREATE POLICY "Users view own quota" ON public.user_quotas
  FOR SELECT USING (user_id = (SELECT auth.uid()));

-- vehicle_issues
DROP POLICY IF EXISTS "vehicle_issues_own" ON public.vehicle_issues;
CREATE POLICY "vehicle_issues_own" ON public.vehicle_issues
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- vehicle_issue_occurrences
DROP POLICY IF EXISTS "vehicle_issue_occurrences_own" ON public.vehicle_issue_occurrences;
CREATE POLICY "vehicle_issue_occurrences_own" ON public.vehicle_issue_occurrences
  FOR ALL
  USING (
    issue_id IN (
      SELECT id FROM public.vehicle_issues
      WHERE user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    issue_id IN (
      SELECT id FROM public.vehicle_issues
      WHERE user_id = (SELECT auth.uid())
    )
  );

-- mcp_tokens: fix existing mcp_tokens_owner policy
DROP POLICY IF EXISTS "mcp_tokens_owner" ON public.mcp_tokens;
CREATE POLICY "mcp_tokens_owner" ON public.mcp_tokens
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));


-- ============================================================
-- 7. Remove multiple permissive policies (keep single canonical policy)
-- ============================================================

-- mcp_tokens: drop the 4 granular per-action policies; keep only mcp_tokens_owner
DROP POLICY IF EXISTS "Users can view own MCP tokens"   ON public.mcp_tokens;
DROP POLICY IF EXISTS "Users can insert own MCP tokens" ON public.mcp_tokens;
DROP POLICY IF EXISTS "Users can update own MCP tokens" ON public.mcp_tokens;
DROP POLICY IF EXISTS "Users can delete own MCP tokens" ON public.mcp_tokens;


-- ============================================================
-- 8. Drop duplicate index on mcp_tokens
-- ============================================================
DROP INDEX IF EXISTS public.mcp_tokens_user_idx;
