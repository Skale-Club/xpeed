-- Migration: Smarter dashboard stats (severity-weighted health score)
-- Phase 03+: Improvement E2 — replaces v1 from 20260517110000

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
           s.duration_seconds, s.row_count, s.summary, s.active_dtcs
    FROM public.sessions s
    WHERE s.car_profile_id = p_car_profile_id
      AND s.user_id = auth.uid()
      AND (s.session_start IS NOT NULL AND s.session_start >= p_date_from
           OR s.uploaded_at >= p_date_from)
    ORDER BY COALESCE(s.session_start, s.uploaded_at) DESC
  ),
  flag_details AS (
    SELECT
      f.session_id,
      f.severity,
      f.canonical_key,
      f.resolved,
      COALESCE((f.evidence->>'pct_out_of_range')::DOUBLE PRECISION, 0) AS pct_out
    FROM public.session_flags f
    WHERE f.session_id IN (SELECT id FROM session_scope)
  ),
  -- Severity weights per canonical_key. Coolant > engine > fuel trim.
  flag_weights AS (
    SELECT
      session_id,
      SUM(
        CASE severity
          WHEN 'critical' THEN 1.0
          WHEN 'attention' THEN 0.4
          ELSE 0
        END
        *
        CASE canonical_key
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
        *
        CASE WHEN COALESCE(resolved, false) THEN 0.2 ELSE 1.0 END
        *
        -- pct-out-of-range scaling: cap at 100, divide by 50
        LEAST(1.5, GREATEST(0.3, pct_out / 50.0))
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
  -- Recency weighting: more recent sessions count more
  recency_weighted AS (
    SELECT
      *,
      GREATEST(0.3, 1.0 - EXTRACT(EPOCH FROM (now() - effective_date)) / EXTRACT(EPOCH FROM INTERVAL '90 days')) AS recency_weight
    FROM per_session
  ),
  overall AS (
    SELECT
      COUNT(*)                                  AS total_sessions,
      SUM(duration_seconds)                     AS total_duration_seconds,
      CASE WHEN SUM(recency_weight) > 0
        THEN COALESCE(ROUND(SUM(session_score * recency_weight) / SUM(recency_weight))::INT, 100)
        ELSE 100
      END                                       AS health_score,
      SUM(attention)                            AS total_attention,
      SUM(critical)                             AS total_critical,
      MAX(effective_date)                       AS last_upload
    FROM recency_weighted
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
  ),
  active_dtcs_agg AS (
    SELECT COALESCE(jsonb_agg(DISTINCT dtc), '[]'::jsonb) AS dtcs
    FROM session_scope, jsonb_array_elements_text(COALESCE(active_dtcs, '[]'::jsonb)) AS dtc
  )
  SELECT json_build_object(
    'totalSessions',       o.total_sessions,
    'totalDurationSeconds',o.total_duration_seconds,
    'healthScore',         o.health_score,
    'totalAttention',      o.total_attention,
    'totalCritical',       o.total_critical,
    'lastUpload',          o.last_upload,
    'activeDtcs',          (SELECT dtcs FROM active_dtcs_agg),
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

GRANT EXECUTE ON FUNCTION public.get_dashboard_stats(UUID, TIMESTAMP WITH TIME ZONE)
  TO authenticated;

COMMENT ON FUNCTION public.get_dashboard_stats IS
  'V2: severity- and recency-weighted health score. Includes active DTCs aggregation.';
