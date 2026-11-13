-- Connecting Xpeed Companion: closing the look-alike page hole.
--  * The page shows a 4-character verification code that Xpeed Companion shows too. The code is derived by the server
--    from sha256(id + token_hash), so nothing new is stored; the read below only has to hand the server the hash
--    (it never reaches a browser).
--  * Cancelling records who decided, as approving already does.
-- Additive: sim_link_read keeps its signature and every old key; sim_link_cancel gains the person as a second argument.

CREATE OR REPLACE FUNCTION public.sim_link_read(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'device_name', device_name,
    'status', CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END,
    'expires_at', expires_at,
    'token_hash', token_hash)
  FROM public.sim_link_requests WHERE id = p_id
$$;

-- The person says no. Only while the request is still pending: once it is approved (or already cancelled) nobody can
-- cancel it, whoever they are. {status: ok | not_found | already_decided}.
DROP FUNCTION public.sim_link_cancel(uuid);
CREATE FUNCTION public.sim_link_cancel(p_id uuid, p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.sim_link_requests;
BEGIN
  SELECT * INTO r FROM public.sim_link_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF r.status <> 'pending' THEN RETURN jsonb_build_object('status', 'already_decided'); END IF;
  UPDATE public.sim_link_requests SET status = 'cancelled', decided_at = now(), user_id = p_user_id WHERE id = p_id;
  RETURN jsonb_build_object('status', 'ok');
END $$;

REVOKE ALL ON FUNCTION public.sim_link_read(uuid), public.sim_link_cancel(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_link_read(uuid), public.sim_link_cancel(uuid, uuid) TO service_role;
