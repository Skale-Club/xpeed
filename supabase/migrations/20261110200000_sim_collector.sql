-- Racing laps from the Windows collector (Virtual mode): paired devices, pairing codes, and the laps they send.
-- The contract is docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md. Only hashes of secrets are stored:
-- a device key or a pairing code can be checked but never read back. The server (service role) does the
-- writes; a signed-in person may only read their own devices (never the key hash) and laps.

CREATE TABLE public.sim_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  last_lap_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX sim_devices_user ON public.sim_devices(user_id, created_at DESC);

CREATE TABLE public.sim_pairing_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX sim_pairing_codes_user ON public.sim_pairing_codes(user_id, expires_at);

CREATE TABLE public.sim_laps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.sim_devices(id) ON DELETE SET NULL,
  -- game|track|car|startedAt|lapNumber|timeMs|sampleCount: the same identity the app uses on the device.
  identity text NOT NULL CHECK (char_length(identity) <= 600),
  game text NOT NULL,
  track_name text NOT NULL,
  car_name text NOT NULL,
  lap_number integer NOT NULL,
  time_ms integer NOT NULL,
  valid boolean NOT NULL,
  started_at timestamptz NOT NULL,
  sample_count integer NOT NULL,
  size_bytes integer NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, identity)
);
CREATE INDEX sim_laps_user_started ON public.sim_laps(user_id, started_at DESC);

ALTER TABLE public.sim_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sim_laps ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sim_devices ON public.sim_devices FOR SELECT TO authenticated USING (user_id = public.current_app_user_id());
CREATE POLICY own_sim_laps ON public.sim_laps FOR SELECT TO authenticated USING (user_id = public.current_app_user_id());
REVOKE ALL ON public.sim_devices, public.sim_pairing_codes, public.sim_laps FROM PUBLIC, anon, authenticated;
-- Column by column: token_hash is not offered.
GRANT SELECT (id, user_id, name, created_at, last_seen_at, last_lap_at, revoked_at) ON public.sim_devices TO authenticated;
GRANT SELECT ON public.sim_laps TO authenticated;
GRANT ALL ON public.sim_devices, public.sim_pairing_codes, public.sim_laps TO service_role;

-- A pairing code lives 10 minutes and works once. Returns when it expires, or null when the person already
-- has five open codes.
CREATE FUNCTION public.sim_create_pairing_code(p_user_id uuid, p_code_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  DELETE FROM public.sim_pairing_codes WHERE expires_at < now() - interval '1 day';
  IF (SELECT count(*) FROM public.sim_pairing_codes WHERE user_id = p_user_id AND used_at IS NULL AND expires_at > now()) >= 5 THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.sim_pairing_codes(code_hash, user_id, expires_at) VALUES (p_code_hash, p_user_id, v_expires);
  RETURN v_expires;
END $$;

-- Trades a valid code for a device, in one step: the row is locked, so two computers cannot use the same code.
-- Answers {status: ok | invalid | device_limit, device_id}. A person may have ten live devices.
CREATE FUNCTION public.sim_pair_device(p_code_hash text, p_name text, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; v_id uuid;
BEGIN
  SELECT user_id INTO v_user FROM public.sim_pairing_codes
    WHERE code_hash = p_code_hash AND used_at IS NULL AND expires_at > now() FOR UPDATE;
  IF v_user IS NULL THEN RETURN jsonb_build_object('status', 'invalid'); END IF;
  IF (SELECT count(*) FROM public.sim_devices WHERE user_id = v_user AND revoked_at IS NULL) >= 10 THEN
    RETURN jsonb_build_object('status', 'device_limit');
  END IF;
  UPDATE public.sim_pairing_codes SET used_at = now() WHERE code_hash = p_code_hash;
  INSERT INTO public.sim_devices(user_id, name, token_hash) VALUES (v_user, p_name, p_token_hash) RETURNING id INTO v_id;
  RETURN jsonb_build_object('status', 'ok', 'device_id', v_id);
END $$;

-- Who a device key belongs to, or null when the key is unknown or revoked. Notes that the device was seen.
CREATE FUNCTION public.sim_authenticate_device(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid; v_id uuid;
BEGIN
  UPDATE public.sim_devices SET last_seen_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL
    RETURNING user_id, id INTO v_user, v_id;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('user_id', v_user, 'device_id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.sim_create_pairing_code(uuid, text), public.sim_pair_device(text, text, text), public.sim_authenticate_device(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sim_create_pairing_code(uuid, text), public.sim_pair_device(text, text, text), public.sim_authenticate_device(text) TO service_role;

-- The lap files themselves: a private bucket only the server reads and writes (files under <user id>/<hash>.xlap.gz).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sim-laps', 'sim-laps', false, 16777216, ARRAY['application/gzip'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
