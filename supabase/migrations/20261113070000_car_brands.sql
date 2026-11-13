-- Shared, public vehicle marque catalog. Brand names on car_profiles remain user data;
-- aliases in this catalog resolve spelling variants without rewriting those profiles.
CREATE TABLE public.car_brands (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  aliases text[] NOT NULL DEFAULT '{}',
  logo_base64 text NOT NULL,
  logo_type text NOT NULL CHECK (logo_type = 'image/png'),
  logo_sha256 text NOT NULL CHECK (logo_sha256 ~ '^[0-9a-f]{64}$'),
  logo_bytes integer NOT NULL CHECK (logo_bytes BETWEEN 1 AND 1048576),
  source_url text NOT NULL,
  source_revision text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(decode(logo_base64, 'base64')) = logo_bytes),
  CHECK (encode(sha256(decode(logo_base64, 'base64')), 'hex') = logo_sha256)
);
ALTER TABLE public.car_brands ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_car_brands ON public.car_brands FOR SELECT USING (true);
REVOKE ALL ON public.car_brands FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.car_brands TO anon, authenticated;
GRANT ALL ON public.car_brands TO service_role;
