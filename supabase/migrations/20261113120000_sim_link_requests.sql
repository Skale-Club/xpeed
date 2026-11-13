-- Connecting Xpeed Companion to an account without a code: the app makes its own device key, sends only the
-- sha256 of it, and the person approves the request in the browser (a device authorization flow). The key never
-- travels and is never stored; approving creates the normal sim_devices row with that hash.
-- Additive only: the pairing codes and sim_pair_device stay for older app versions.

CREATE TABLE public.sim_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  device_name text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 60),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  decided_at timestamptz,
  user_id uuid REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.sim_devices(id) ON DELETE SET NULL
);
CREATE INDEX sim_link_requests_expires ON public.sim_link_requests(expires_at);

ALTER TABLE public.sim_link_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sim_link_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.sim_link_requests TO service_role;

-- The app starts a request. {status: ok, id, expires_at} or {status: exists} when the hash is already a device or a request.
CREATE FUNCTION public.sim_link_create(p_name text, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_expires timestamptz;
BEGIN
  DELETE FROM public.sim_link_requests WHERE expires_at < now() - interval '1 day';
  IF EXISTS (SELECT 1 FROM public.sim_devices WHERE token_hash = p_token_hash)
     OR EXISTS (SELECT 1 FROM public.sim_link_requests WHERE token_hash = p_token_hash) THEN
    RETURN jsonb_build_object('status', 'exists');
  END IF;
  INSERT INTO public.sim_link_requests(token_hash, device_name) VALUES (p_token_hash, p_name)
    RETURNING id, expires_at INTO v_id, v_expires;
  RETURN jsonb_build_object('status', 'ok', 'id', v_id, 'expires_at', v_expires);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('status', 'exists');
END $$;

-- What the page shows. A pending request past its time is "expired". Null when there is no such request.
CREATE FUNCTION public.sim_link_read(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'device_name', device_name,
    'status', CASE WHEN status = 'pending' AND expires_at <= now() THEN 'expired' ELSE status END,
    'expires_at', expires_at)
  FROM public.sim_link_requests WHERE id = p_id
$$;

-- The person approves: the device row and the decision happen together, under a lock, so a request is used once.
-- {status: ok, device_id | not_found | already_decided | expired | device_limit}. A person may have ten live devices.
CREATE FUNCTION public.sim_link_approve(p_id uuid, p_user_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.sim_link_requests; v_device uuid;
BEGIN
  SELECT * INTO r FROM public.sim_link_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF r.status <> 'pending' THEN RETURN jsonb_build_object('status', 'already_decided'); END IF;
  IF r.expires_at <= now() THEN RETURN jsonb_build_object('status', 'expired'); END IF;
  IF (SELECT count(*) FROM public.sim_devices WHERE user_id = p_user_id AND revoked_at IS NULL) >= 10 THEN
    RETURN jsonb_build_object('status', 'device_limit');
  END IF;
  INSERT INTO public.sim_devices(user_id, name, token_hash) VALUES (p_user_id, r.device_name, r.token_hash) RETURNING id INTO v_device;
  UPDATE public.sim_link_requests SET status = 'approved', decided_at = now(), user_id = p_user_id, device_id = v_device WHERE id = p_id;
  RETURN jsonb_build_object('status', 'ok', 'device_id', v_device);
END $$;

-- The person says no. {status: ok | not_found | already_decided}.
CREATE FUNCTION public.sim_link_cancel(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.sim_link_requests;
BEGIN
  SELECT * INTO r FROM public.sim_link_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
  IF r.status <> 'pending' THEN RETURN jsonb_build_object('status', 'already_decided'); END IF;
  UPDATE public.sim_link_requests SET status = 'cancelled', decided_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('status', 'ok');
END $$;

-- The app asks how its request stands, proving it made it with the hash of its key. Null on an unknown id or a wrong hash.
-- Once approved it also answers the account: its email, or its name when there is no email.
CREATE FUNCTION public.sim_link_poll(p_id uuid, p_token_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'status', CASE WHEN l.status = 'pending' AND l.expires_at <= now() THEN 'expired' ELSE l.status END,
    'account', CASE WHEN l.status = 'approved' THEN coalesce(nullif(a.email, ''), nullif(a.full_name, ''), nullif(a.phone, ''), '') END)
  FROM public.sim_link_requests l LEFT JOIN public.app_accounts a ON a.id = l.user_id
  WHERE l.id = p_id AND l.token_hash = p_token_hash
$$;

REVOKE ALL ON FUNCTION public.sim_link_create(text, text), public.sim_link_read(uuid), public.sim_link_approve(uuid, uuid),
  public.sim_link_cancel(uuid), public.sim_link_poll(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_link_create(text, text), public.sim_link_read(uuid), public.sim_link_approve(uuid, uuid),
  public.sim_link_cancel(uuid), public.sim_link_poll(uuid, text) TO service_role;
