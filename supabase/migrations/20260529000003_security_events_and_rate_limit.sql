-- SECURITY FIX S09-3 + S11-2.
--
-- S09-3: durable security-event log + alerting source. Edge functions write
--        auth failures, ownership denials, token-reuse detection, and quota
--        failures here so incidents are reconstructable and alertable.
-- S11-2: DB-backed per-IP rate limiter for the public OAuth endpoints
--        (/register, /token) so they can't be flooded.

-- ── S09-3: security_events ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.security_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  text NOT NULL,
  user_id     uuid,
  ip          text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS security_events_type_time_idx
  ON public.security_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS security_events_user_idx
  ON public.security_events (user_id, created_at DESC);

ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

-- Writes are service-role only (edge functions). Admins may read.
DROP POLICY IF EXISTS security_events_admin_read ON public.security_events;
CREATE POLICY security_events_admin_read ON public.security_events
  FOR SELECT USING (public.is_admin_user());

-- ── S11-2: rate_limits ────────────────────────────────────────────────────
-- Fixed-window counter keyed by an opaque bucket string (e.g. "oauth_token:1.2.3.4").
CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket        text PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT now(),
  count         int NOT NULL DEFAULT 0
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies = deny all to PostgREST clients; only service role / SECURITY DEFINER touch it.

-- Atomic check-and-increment. Returns TRUE if the request is ALLOWED, FALSE if
-- the limit is exceeded for the current window. Window resets lazily.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_bucket text,
  p_max int,
  p_window_seconds int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count int;
  v_start timestamptz;
BEGIN
  INSERT INTO public.rate_limits (bucket, window_start, count)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE
    SET count = CASE
                  WHEN public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                  THEN 1
                  ELSE public.rate_limits.count + 1
                END,
        window_start = CASE
                  WHEN public.rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
                  THEN now()
                  ELSE public.rate_limits.window_start
                END
  RETURNING count, window_start INTO v_count, v_start;

  RETURN v_count <= p_max;
END $$;

REVOKE ALL ON FUNCTION public.check_rate_limit(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, int, int) TO service_role;
