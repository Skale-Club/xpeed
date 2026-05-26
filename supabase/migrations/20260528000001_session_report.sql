-- Add structured report column to sessions.
-- The report is generated deterministically from raw CSV data (no AI).
-- AI reads this report instead of raw CSV text.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS report JSONB;
