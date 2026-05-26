-- Add country to car_profiles
ALTER TABLE public.car_profiles ADD COLUMN IF NOT EXISTS country TEXT;

-- Vehicle makes cache (populated from NHTSA vPIC for US, extensible for other countries)
CREATE TABLE IF NOT EXISTS public.vehicle_makes_cache (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  year INTEGER NOT NULL,
  make_id INTEGER NOT NULL,
  make_name TEXT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(country, year, make_id)
);

-- Vehicle models cache
CREATE TABLE IF NOT EXISTS public.vehicle_models_cache (
  id BIGSERIAL PRIMARY KEY,
  country TEXT NOT NULL,
  year INTEGER NOT NULL,
  make_name TEXT NOT NULL,
  model_id INTEGER NOT NULL,
  model_name TEXT NOT NULL,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(country, year, make_name, model_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_makes_lookup
  ON public.vehicle_makes_cache(country, year);

CREATE INDEX IF NOT EXISTS idx_vehicle_models_lookup
  ON public.vehicle_models_cache(country, year, make_name);

-- RLS: vehicle library data is public — anyone can read, authenticated users can populate the cache
ALTER TABLE public.vehicle_makes_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_models_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vehicle_makes_select" ON public.vehicle_makes_cache
  FOR SELECT USING (true);

CREATE POLICY "vehicle_models_select" ON public.vehicle_models_cache
  FOR SELECT USING (true);

CREATE POLICY "vehicle_makes_insert" ON public.vehicle_makes_cache
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "vehicle_models_insert" ON public.vehicle_models_cache
  FOR INSERT TO authenticated WITH CHECK (true);
