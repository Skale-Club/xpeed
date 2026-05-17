-- Migration: Maintenance log for tracking service history
-- Phase 03+: Improvement B2

CREATE TABLE IF NOT EXISTS public.maintenance_events (
  id              UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  car_profile_id  UUID NOT NULL REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'oil_change', 'coolant_flush', 'brake_pads_front', 'brake_pads_rear',
    'brake_fluid', 'transmission_fluid', 'air_filter', 'cabin_filter',
    'spark_plugs', 'battery_12v', 'battery_hv', 'tires', 'tire_rotation',
    'wheel_alignment', 'timing_belt', 'serpentine_belt', 'inspection', 'other'
  )),
  performed_at    DATE NOT NULL,
  odometer_km     INTEGER,
  cost            NUMERIC(10, 2),
  currency        TEXT DEFAULT 'USD',
  shop            TEXT,
  notes           TEXT,
  created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_car ON public.maintenance_events(car_profile_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_user ON public.maintenance_events(user_id);

-- RLS
ALTER TABLE public.maintenance_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can view own maintenance" ON public.maintenance_events
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can create own maintenance" ON public.maintenance_events
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can update own maintenance" ON public.maintenance_events
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own maintenance" ON public.maintenance_events;
CREATE POLICY "Users can delete own maintenance" ON public.maintenance_events
  FOR DELETE USING (auth.uid() = user_id);

-- Auto-set user_id on insert
DROP TRIGGER IF EXISTS set_maintenance_user_id ON public.maintenance_events;
CREATE TRIGGER set_maintenance_user_id
  BEFORE INSERT ON public.maintenance_events
  FOR EACH ROW
  EXECUTE FUNCTION public.set_user_id();

COMMENT ON TABLE public.maintenance_events IS 'Service history for a vehicle. Used to enrich AI context and surface "due soon" reminders.';
