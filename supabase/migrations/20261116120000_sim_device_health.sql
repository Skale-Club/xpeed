-- Xpeed Companion 0.8.5: the heartbeat can also say how the run is going (laps saved, laps let go and why, laps the server refused,
-- workers that failed or restart, the games' builds), so a lap that was never written or a reader that stopped is seen by the site and
-- by the owner, not only by the person who may not notice. The server keeps the last report it heard, as one small JSON object.
-- Additive and idempotent: two new nullable columns (IF NOT EXISTS) and one new function (CREATE OR REPLACE). Nothing existing is
-- changed, dropped or renamed, and the heartbeat function itself is untouched: an older Companion sends none of this.
ALTER TABLE public.sim_devices
  ADD COLUMN IF NOT EXISTS last_health jsonb CHECK (last_health IS NULL OR (jsonb_typeof(last_health) = 'object' AND octet_length(last_health::text) <= 2048)),
  ADD COLUMN IF NOT EXISTS last_health_at timestamptz;

-- The person may read these on their own devices (the key hash is still not offered).
GRANT SELECT (last_health, last_health_at) ON public.sim_devices TO authenticated;

-- Keeps the report of the device behind the key. false: the key is unknown or revoked (nothing written).
CREATE OR REPLACE FUNCTION public.sim_device_health(p_token_hash text, p_health jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.sim_devices d SET last_health = p_health, last_health_at = now()
    WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL;
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION public.sim_device_health(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_device_health(text, jsonb) TO service_role;
