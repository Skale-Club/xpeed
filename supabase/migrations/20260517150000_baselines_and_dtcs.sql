-- Migration: Per-vehicle parameter baselines + DTC tracking
-- Phase 03+: Improvements D4 (anomaly detection) + A2 (DTC codes)

-- Active DTCs per session (extracted from CSV during upload)
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS active_dtcs JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.sessions.active_dtcs IS 'Array of DTC codes active during this session. Format: ["P0420", "P0301"]';

-- Per-(car, parameter) rolling baselines for anomaly detection
CREATE TABLE IF NOT EXISTS public.parameter_baselines (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  car_profile_id  UUID NOT NULL REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  canonical_key   TEXT NOT NULL,
  window_days     INTEGER NOT NULL CHECK (window_days IN (7, 30, 90)),
  mean            DOUBLE PRECISION NOT NULL,
  stddev          DOUBLE PRECISION NOT NULL,
  sample_count    INTEGER NOT NULL,
  computed_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (car_profile_id, canonical_key, window_days)
);

CREATE INDEX IF NOT EXISTS idx_baselines_car ON public.parameter_baselines(car_profile_id);

ALTER TABLE public.parameter_baselines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "baselines_read_own" ON public.parameter_baselines;
CREATE POLICY "baselines_read_own" ON public.parameter_baselines
  FOR SELECT USING (
    car_profile_id IN (SELECT id FROM public.car_profiles WHERE user_id = auth.uid())
  );

-- RPC to compute/refresh baselines for a car. Called after each upload.
CREATE OR REPLACE FUNCTION public.refresh_parameter_baselines(p_car_profile_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_window INTEGER;
BEGIN
  -- Only allow user to refresh baselines for their own car
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
      AVG(s.avg_value)::DOUBLE PRECISION AS mean,
      COALESCE(STDDEV(s.avg_value), 0)::DOUBLE PRECISION AS stddev,
      COUNT(*)::INTEGER AS sample_count,
      now()
    FROM (
      SELECT
        (summary_item ->> 'canonical_key')                AS canonical_key,
        (summary_item ->> 'avg')::DOUBLE PRECISION         AS avg_value
      FROM public.sessions sess,
           jsonb_array_elements(COALESCE(sess.summary->'summaries', '[]'::jsonb)) AS summary_item
      WHERE sess.car_profile_id = p_car_profile_id
        AND sess.uploaded_at >= now() - (v_window || ' days')::INTERVAL
        AND (summary_item->>'avg') IS NOT NULL
        AND (summary_item->>'canonical_key') IS NOT NULL
    ) s
    WHERE s.avg_value IS NOT NULL
    GROUP BY s.canonical_key
    HAVING COUNT(*) >= 3   -- need at least 3 samples for a meaningful baseline
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
