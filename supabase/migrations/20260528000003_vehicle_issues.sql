-- Vehicle Issues: persistent issue records that live above session_flags.
-- A flag is per-session. An issue is per-vehicle and survives across sessions.
--
-- Severity: critical | serious | warning | easy_fix
-- Status:   active   | resolved | recurred | ignored

CREATE TABLE IF NOT EXISTS public.vehicle_issues (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  car_profile_id    UUID        NOT NULL REFERENCES public.car_profiles(id) ON DELETE CASCADE,
  user_id           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
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
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(car_profile_id, canonical_key)
);

-- Each time an issue appears in a session
CREATE TABLE IF NOT EXISTS public.vehicle_issue_occurrences (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_id    UUID        NOT NULL REFERENCES public.vehicle_issues(id) ON DELETE CASCADE,
  session_id  UUID        NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  severity    TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  evidence    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(issue_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_vehicle_issues_car_status
  ON public.vehicle_issues(car_profile_id, status);

CREATE INDEX IF NOT EXISTS idx_vehicle_issues_car_severity
  ON public.vehicle_issues(car_profile_id, severity);

CREATE INDEX IF NOT EXISTS idx_vehicle_issue_occurrences_issue
  ON public.vehicle_issue_occurrences(issue_id);

CREATE INDEX IF NOT EXISTS idx_vehicle_issue_occurrences_session
  ON public.vehicle_issue_occurrences(session_id);

-- RLS
ALTER TABLE public.vehicle_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_issue_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_issues" ON public.vehicle_issues
  FOR ALL USING (
    car_profile_id IN (
      SELECT id FROM public.car_profiles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "users_own_issue_occurrences" ON public.vehicle_issue_occurrences
  FOR ALL USING (
    issue_id IN (
      SELECT vi.id FROM public.vehicle_issues vi
      JOIN public.car_profiles cp ON cp.id = vi.car_profile_id
      WHERE cp.user_id = auth.uid()
    )
  );
