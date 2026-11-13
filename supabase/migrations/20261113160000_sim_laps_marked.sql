-- A lap the person asked to keep in full detail. Retention (server/retention.ts) never reduces a marked lap.
-- Additive: one nullable-safe column with a default, no existing row changes meaning.
ALTER TABLE public.sim_laps ADD COLUMN IF NOT EXISTS marked boolean NOT NULL DEFAULT false;
