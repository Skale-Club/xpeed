-- Migration: Dashboard stats RPC function
-- Phase 04: Performance Optimization
-- Created: 2026-05-17
-- Eliminates N+1 flag queries on dashboard by computing stats server-side

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(
  p_car_profile_id UUID,
  p_date_from TIMESTAMP WITH TIME ZONE DEFAULT (now() - INTERVAL '30 days')
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSON;
BEGIN
  WITH session_scope AS (
    SELECT s.id, s.session_start, s.session_end, s.uploaded_at,
           s.duration_seconds, s.row_count, s.summary
    FROM public.sessions s
    WHERE s.car_profile_id = p_car_profile_id
      AND s.user_id = auth.uid()
      AND (s.session_start IS NOT NULL AND s.session_start >= p_date_from
           OR s.uploaded_at >= p_date_from)
    ORDER BY COALESCE(s.session_start, s.uploaded_at) DESC
  ),
  flag_counts AS (
    SELECT
      f.session_id,
      COUNT(*) FILTER (WHERE f.severity = 'attention') AS attention_count,
      COUNT(*) FILTER (WHERE f.severity = 'critical')  AS critical_count
    FROM public.session_flags f
    WHERE f.session_id IN (SELECT id FROM session_scope)
    GROUP BY f.session_id
  ),
  per_session AS (
    SELECT
      s.id,
      COALESCE(s.session_start, s.uploaded_at) AS effective_date,
      s.duration_seconds,
      COALESCE(fc.attention_count, 0) AS attention,
      COALESCE(fc.critical_count,  0) AS critical,
      GREATEST(0,
        100
        - COALESCE(fc.critical_count,  0) * 15
        - COALESCE(fc.attention_count, 0) * 5
      ) AS session_score
    FROM session_scope s
    LEFT JOIN flag_counts fc ON fc.session_id = s.id
  ),
  overall AS (
    SELECT
      COUNT(*)                              AS total_sessions,
      SUM(duration_seconds)                 AS total_duration_seconds,
      COALESCE(AVG(session_score)::INT, 100) AS health_score,
      SUM(attention)                        AS total_attention,
      SUM(critical)                         AS total_critical,
      MAX(effective_date)                   AS last_upload
    FROM per_session
  ),
  trend_rows AS (
    SELECT
      id,
      to_char(effective_date, 'Mon DD') AS date_label,
      attention,
      critical,
      session_score AS score
    FROM per_session
    ORDER BY effective_date DESC
    LIMIT 20
  )
  SELECT json_build_object(
    'totalSessions',       o.total_sessions,
    'totalDurationSeconds',o.total_duration_seconds,
    'healthScore',         o.health_score,
    'totalAttention',      o.total_attention,
    'totalCritical',       o.total_critical,
    'lastUpload',          o.last_upload,
    'status',              CASE
                             WHEN o.health_score >= 90 THEN 'Excellent'
                             WHEN o.health_score >= 70 THEN 'Good'
                             WHEN o.health_score >= 50 THEN 'Attention'
                             ELSE 'Critical'
                           END,
    'trendData',           COALESCE(
                             (SELECT json_agg(row_to_json(t)) FROM trend_rows t),
                             '[]'::json
                           )
  ) INTO v_result
  FROM overall o;

  RETURN v_result;
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(UUID, TIMESTAMP WITH TIME ZONE)
  TO authenticated;

-- Comment
COMMENT ON FUNCTION public.get_dashboard_stats IS
  'Returns pre-aggregated dashboard stats + trend data for a car profile within a date range. Eliminates N+1 flag fetches from the browser.';
