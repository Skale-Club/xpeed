-- Public, attributed presentation assets; private owner photos stay in car-photos.
CREATE TABLE public.vehicle_visuals (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  make text NOT NULL,
  model text NOT NULL,
  model_aliases text[] NOT NULL DEFAULT '{}',
  year_from integer NOT NULL CHECK (year_from BETWEEN 1886 AND 2100),
  year_to integer NOT NULL CHECK (year_to BETWEEN year_from AND 2100),
  model_path text CHECK (model_path = '/vehicle-visuals/' || key || '.glb'),
  poster_path text CHECK (poster_path = '/vehicle-visuals/' || key || '.png'),
  author text NOT NULL,
  source_url text NOT NULL,
  license text NOT NULL,
  license_url text NOT NULL,
  changes text NOT NULL,
  source_revision text NOT NULL,
  model_sha256 text CHECK (model_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (model_path IS NOT NULL OR poster_path IS NOT NULL)
);
ALTER TABLE public.vehicle_visuals ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_vehicle_visuals ON public.vehicle_visuals FOR SELECT USING (true);
REVOKE ALL ON public.vehicle_visuals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.vehicle_visuals TO anon, authenticated;
GRANT ALL ON public.vehicle_visuals TO service_role;
