-- SECURITY FIX S11-1 (Medium) — make per-user daily quota enforcement atomic.
--
-- The edge function did a non-atomic count-then-insert: N concurrent requests
-- could each read `used < limit` before any insert landed, all passing the
-- check and blowing past the daily cap (cost abuse against the shared Gemini
-- key). This function serializes the check+insert per (user, kind, day) with a
-- transaction-scoped advisory lock, so concurrent calls cannot race.
--
-- Returns the remaining allowance AFTER consuming one unit. Raises 'quota_exceeded'
-- (caught by the edge function -> 429) when the limit is already reached.
-- service_role only — never callable from PostgREST clients.

CREATE OR REPLACE FUNCTION public.consume_quota(
  p_user_id uuid,
  p_kind text,
  p_limit int
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_used int;
BEGIN
  -- Serialize all concurrent consumers of the same (user, kind) for this tx.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_kind, 0));

  SELECT count(*) INTO v_used
  FROM public.user_quotas
  WHERE user_id = p_user_id
    AND kind = p_kind
    AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc');

  IF v_used >= p_limit THEN
    RAISE EXCEPTION 'quota_exceeded' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.user_quotas (user_id, kind) VALUES (p_user_id, p_kind);

  RETURN p_limit - v_used - 1;
END $$;

REVOKE ALL ON FUNCTION public.consume_quota(uuid, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_quota(uuid, text, int) TO service_role;
