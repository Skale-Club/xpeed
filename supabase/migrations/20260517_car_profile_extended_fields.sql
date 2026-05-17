-- Migration: Extended car profile fields for onboarding wizard
-- Phase 02: Complete Car Onboarding
-- Created: 2026-05-17

-- Add structured vehicle fields to car_profiles
ALTER TABLE public.car_profiles
  ADD COLUMN IF NOT EXISTS make TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS year INTEGER,
  ADD COLUMN IF NOT EXISTS trim TEXT,
  ADD COLUMN IF NOT EXISTS vin TEXT;

-- Validate year range (1900-2100)
ALTER TABLE public.car_profiles
  DROP CONSTRAINT IF EXISTS chk_car_profile_year;
ALTER TABLE public.car_profiles
  ADD CONSTRAINT chk_car_profile_year
    CHECK (year IS NULL OR (year >= 1900 AND year <= 2100));

-- Validate VIN length (standard 17 chars, allow NULL)
ALTER TABLE public.car_profiles
  DROP CONSTRAINT IF EXISTS chk_car_profile_vin;
ALTER TABLE public.car_profiles
  ADD CONSTRAINT chk_car_profile_vin
    CHECK (vin IS NULL OR length(vin) = 17);

-- Index for make/model search
CREATE INDEX IF NOT EXISTS idx_car_profiles_make_model
  ON public.car_profiles(make, model);

-- Comment on new columns
COMMENT ON COLUMN public.car_profiles.make IS 'Vehicle manufacturer (e.g., Toyota, Honda)';
COMMENT ON COLUMN public.car_profiles.model IS 'Vehicle model (e.g., Prius, Civic)';
COMMENT ON COLUMN public.car_profiles.year IS 'Model year (e.g., 2023)';
COMMENT ON COLUMN public.car_profiles.trim IS 'Trim level (e.g., LX, Sport, Limited)';
COMMENT ON COLUMN public.car_profiles.vin IS 'Vehicle Identification Number (17 chars)';
