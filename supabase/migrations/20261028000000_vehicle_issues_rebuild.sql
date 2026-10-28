-- The live vehicle_issues / vehicle_issue_occurrences tables predate
-- 20260528000003 (CREATE TABLE IF NOT EXISTS kept the old shape): other
-- severities and statuses, no session links, no recurrence count and no unique
-- key per car. Every write from the app failed, so both tables are empty.
-- Rebuild them in the shape the app uses, plus `details` for warnings written
-- by the AI (their plain-language meaning and what to do).
--
-- Refuses to run if either table holds rows, so nothing can be lost.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vehicle_issues' AND column_name = 'first_session_id'
  ) THEN
    RETURN; -- already in the new shape
  END IF;
  IF to_regclass('public.vehicle_issues') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.vehicle_issues) THEN
    RAISE EXCEPTION 'vehicle_issues has rows; migrate them by hand';
  END IF;
  IF to_regclass('public.vehicle_issue_occurrences') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.vehicle_issue_occurrences) THEN
    RAISE EXCEPTION 'vehicle_issue_occurrences has rows; migrate them by hand';
  END IF;
  DROP TABLE IF EXISTS public.vehicle_issue_occurrences;
  DROP TABLE IF EXISTS public.vehicle_issues;
END $$;

CREATE TABLE IF NOT EXISTS public.vehicle_issues (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  car_profile_id    UUID        NOT NULL REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canonical_key     TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  severity          TEXT        NOT NULL CHECK (severity IN ('critical', 'serious', 'warning', 'easy_fix')),
  status            TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'resolved', 'recurred', 'ignored')),
  first_seen_at     TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  first_session_id  UUID        REFERENCES public.sessions(id) ON DELETE SET NULL,
  last_session_id   UUID        REFERENCES public.sessions(id) ON DELETE SET NULL,
  resolved_at       TIMESTAMPTZ,
  resolved_note     TEXT,
  recurrence_count  INTEGER     NOT NULL DEFAULT 0,
  -- AI warnings: { "source": "ai", "meaning": "...", "action": "..." }
  details           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (car_profile_id, canonical_key)
);

CREATE TABLE IF NOT EXISTS public.vehicle_issue_occurrences (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID        NOT NULL REFERENCES public.vehicle_issues(id) ON DELETE CASCADE,
  session_id  UUID        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  severity    TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  evidence    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (issue_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_issues_car_status ON public.vehicle_issues(car_profile_id, status);
CREATE INDEX IF NOT EXISTS idx_vehicle_issues_user ON public.vehicle_issues(user_id);
CREATE INDEX IF NOT EXISTS idx_vehicle_issue_occurrences_session ON public.vehicle_issue_occurrences(session_id);

DROP TRIGGER IF EXISTS trg_vehicle_issues_updated_at ON public.vehicle_issues;
CREATE TRIGGER trg_vehicle_issues_updated_at
  BEFORE UPDATE ON public.vehicle_issues
  FOR EACH ROW EXECUTE FUNCTION public.touch_vehicle_issue_updated_at();

ALTER TABLE public.vehicle_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_issue_occurrences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "vehicle_issues_own" ON public.vehicle_issues;
CREATE POLICY "vehicle_issues_own" ON public.vehicle_issues
  FOR ALL
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND car_profile_id IN (SELECT id FROM public.car_profiles WHERE user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "vehicle_issue_occurrences_own" ON public.vehicle_issue_occurrences;
CREATE POLICY "vehicle_issue_occurrences_own" ON public.vehicle_issue_occurrences
  FOR ALL
  USING (issue_id IN (SELECT id FROM public.vehicle_issues WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (
    issue_id IN (SELECT id FROM public.vehicle_issues WHERE user_id = (SELECT auth.uid()))
    AND session_id IN (SELECT id FROM public.sessions WHERE user_id = (SELECT auth.uid()))
  );
