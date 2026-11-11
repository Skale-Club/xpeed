-- Track layouts (.xtrk.gz) that Xpeed Sim builds from a game's own files and sends once per track. The contract is
-- docs/telemetria-virtual-2026-11-10/ENVIO-DE-VOLTAS.md (and the file itself, FORMATO-DE-PISTA.md). One layout per
-- account per game, track and layout: track_key is the reader's trackKey (game|name|variant, trimmed, lower case), and a
-- second upload of the same track replaces the first. The server (service role) does the writes; a signed-in person
-- may only read their own rows (and deletes them through the server).

CREATE TABLE public.sim_tracks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_accounts(id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.sim_devices(id) ON DELETE SET NULL,
  track_key text NOT NULL CHECK (char_length(track_key) <= 300),
  game text NOT NULL CHECK (char_length(game) <= 32),
  track_name text NOT NULL CHECK (char_length(track_name) BETWEEN 1 AND 120),
  variant text CHECK (char_length(variant) BETWEEN 1 AND 120),
  title text CHECK (char_length(title) BETWEEN 1 AND 120),
  length_m double precision,
  size_bytes integer NOT NULL,
  -- Of the stored gzip bytes: what the person downloads is exactly what was sent.
  sha256 text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, track_key)
);
CREATE INDEX sim_tracks_user_updated ON public.sim_tracks(user_id, updated_at DESC);

ALTER TABLE public.sim_tracks ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_sim_tracks ON public.sim_tracks FOR SELECT TO authenticated USING (user_id = public.current_app_user_id());
REVOKE ALL ON public.sim_tracks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sim_tracks TO authenticated;
GRANT ALL ON public.sim_tracks TO service_role;

-- The files: a private bucket only the server reads and writes (files under <user id>/<hash of the track key>.xtrk.gz).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sim-tracks', 'sim-tracks', false, 33554432, ARRAY['application/gzip'])
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
