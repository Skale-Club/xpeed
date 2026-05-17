-- Migration: per-user daily usage tracking for Edge Function quotas
-- Phase 03+: Gap 7 — free-tier safeguard so a single user can't exhaust
-- Gemini's 1500 req/day or Supabase's 500K Edge Function invocations.

CREATE TABLE IF NOT EXISTS public.user_quotas (
  id          UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('chat_messages', 'analysis')),
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Composite index supports the "today's usage" query pattern:
--   WHERE user_id = ? AND kind = ? AND created_at >= today
CREATE INDEX IF NOT EXISTS idx_user_quotas_lookup
  ON public.user_quotas (user_id, kind, created_at DESC);

-- Auto-prune old rows weekly to keep the table tiny on free tier.
-- (Without pg_cron we can't schedule this; do it inline on each insert as a
--  best-effort, capped at 100 rows per delete to avoid blocking.)
CREATE OR REPLACE FUNCTION public.prune_old_user_quotas()
RETURNS TRIGGER AS $$
BEGIN
  -- 1% chance per insert: probabilistic cleanup
  IF random() < 0.01 THEN
    DELETE FROM public.user_quotas
    WHERE created_at < now() - INTERVAL '14 days'
    AND id IN (
      SELECT id FROM public.user_quotas
      WHERE created_at < now() - INTERVAL '14 days'
      LIMIT 100
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prune_user_quotas_trigger ON public.user_quotas;
CREATE TRIGGER prune_user_quotas_trigger
  AFTER INSERT ON public.user_quotas
  FOR EACH ROW EXECUTE FUNCTION public.prune_old_user_quotas();

ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;

-- Users see only their own quota rows (Edge Functions use service role to write)
DROP POLICY IF EXISTS "Users view own quota" ON public.user_quotas;
CREATE POLICY "Users view own quota" ON public.user_quotas
  FOR SELECT USING (auth.uid() = user_id);

COMMENT ON TABLE public.user_quotas IS
  'Daily per-user usage counter. Written by Edge Functions via service role.
Filter WHERE created_at >= current_date for "today" semantics. No pg_cron
needed; old rows auto-prune via probabilistic trigger.';
