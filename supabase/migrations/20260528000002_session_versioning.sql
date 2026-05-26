-- Traceability columns: each session records the exact ruleset and report
-- version that produced its diagnostic output. Future reprocessing can filter
-- sessions that need to be re-run by comparing these against the current versions.

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS ruleset_id           TEXT,
  ADD COLUMN IF NOT EXISTS ruleset_matched_via  TEXT,
  ADD COLUMN IF NOT EXISTS report_version       INTEGER,
  ADD COLUMN IF NOT EXISTS processing_version   TEXT;

-- Indexes support queries like "all sessions processed with an old ruleset"
CREATE INDEX IF NOT EXISTS idx_sessions_ruleset_id
  ON public.sessions(ruleset_id) WHERE ruleset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_processing_version
  ON public.sessions(processing_version) WHERE processing_version IS NOT NULL;
