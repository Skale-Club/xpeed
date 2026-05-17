-- Migration: Rule library schema for make/model-aware diagnostics
-- Phase 03+: Improvement A1

-- Vehicle ruleset definitions (e.g. "Toyota Prius Gen 3", "Honda Civic Gen 10")
CREATE TABLE IF NOT EXISTS public.vehicle_rulesets (
  id          TEXT PRIMARY KEY,                  -- slug: 'toyota-prius-g3-2009-2015'
  name        TEXT NOT NULL,                      -- human label
  applies_to  JSONB NOT NULL DEFAULT '{}',        -- { make, model_prefixes[], year_min, year_max, engine? }
  base_ruleset_id TEXT REFERENCES public.vehicle_rulesets(id) ON DELETE SET NULL,
  is_builtin  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Extend parameter_rules with ruleset linkage + structured action messages
ALTER TABLE public.parameter_rules
  ADD COLUMN IF NOT EXISTS ruleset_id TEXT REFERENCES public.vehicle_rulesets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS what_happened TEXT,
  ADD COLUMN IF NOT EXISTS why_it_matters TEXT,
  ADD COLUMN IF NOT EXISTS what_to_do TEXT;

CREATE INDEX IF NOT EXISTS idx_parameter_rules_ruleset
  ON public.parameter_rules(ruleset_id);

-- Seed: generic fallback rulesets (petrol / hybrid / diesel)
INSERT INTO public.vehicle_rulesets (id, name, applies_to, is_builtin) VALUES
  ('generic-petrol', 'Generic Petrol Vehicle',
    '{"engine_type": ["petrol", "gasoline"]}', true),
  ('generic-hybrid', 'Generic Hybrid Vehicle',
    '{"engine_type": ["hybrid"]}', true),
  ('generic-diesel', 'Generic Diesel Vehicle',
    '{"engine_type": ["diesel"]}', true),
  ('toyota-prius-g3', 'Toyota Prius (2009–2015)',
    '{"make": "Toyota", "model_prefixes": ["Prius"], "year_min": 2009, "year_max": 2015}', true),
  ('toyota-prius-g4', 'Toyota Prius (2016–2022)',
    '{"make": "Toyota", "model_prefixes": ["Prius"], "year_min": 2016, "year_max": 2022}', true),
  ('honda-civic-g10', 'Honda Civic (2016–2021)',
    '{"make": "Honda", "model_prefixes": ["Civic"], "year_min": 2016, "year_max": 2021}', true),
  ('ford-f150-13gen', 'Ford F-150 (2015–2020)',
    '{"make": "Ford", "model_prefixes": ["F-150", "F150"], "year_min": 2015, "year_max": 2020}', true),
  ('subaru-wrx-vab', 'Subaru WRX (2015–2021)',
    '{"make": "Subaru", "model_prefixes": ["WRX", "Impreza WRX"], "year_min": 2015, "year_max": 2021}', true),
  ('tesla-model3', 'Tesla Model 3',
    '{"make": "Tesla", "model_prefixes": ["Model 3"]}', true)
ON CONFLICT (id) DO NOTHING;

-- Optional: link car profiles to an explicit ruleset (override resolver)
ALTER TABLE public.car_profiles
  ADD COLUMN IF NOT EXISTS ruleset_id TEXT REFERENCES public.vehicle_rulesets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS engine_type TEXT;

COMMENT ON COLUMN public.car_profiles.ruleset_id IS 'Override the auto-resolved ruleset for this car. NULL = auto-resolve from make/model/year.';
COMMENT ON COLUMN public.car_profiles.engine_type IS 'petrol | diesel | hybrid | electric. Used as a fallback when no specific ruleset matches.';

-- RLS: rulesets are global read-only for authenticated users
ALTER TABLE public.vehicle_rulesets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "vehicle_rulesets_read_all" ON public.vehicle_rulesets;
CREATE POLICY "vehicle_rulesets_read_all" ON public.vehicle_rulesets
  FOR SELECT USING (true);
