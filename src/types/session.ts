// Domain types for OBD2 session data.
// Mirrors the shape returned by SESSION_LIST_SELECT in src/lib/db.ts
// plus the structured fields inside the `summary` JSON column.

export type SessionSeverity = 'normal' | 'attention' | 'critical';

export interface SessionFlag {
  id: string;
  session_id: string;
  severity: SessionSeverity;
  canonical_key: string;
  parameter_key: string;
  message: string;
  evidence: Record<string, unknown> | null;
  created_at: string;
  resolved?: boolean | null;
  sessions?: {
    source_filename: string;
    uploaded_at: string;
  };
}

export interface SessionRow {
  id: string;
  session_id: string;
  t_seconds: number | null;
  t_timestamp: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface SessionSummaryItem {
  canonical_key?: string | null;
  parameter_key?: string | null;
  label?: string | null;
  unit?: string | null;
  min?: number | null;
  max?: number | null;
  avg?: number | null;
  count?: number | null;
  duration_seconds?: number | null;
  [key: string]: unknown;
}

export interface SessionSummary {
  summaries?: SessionSummaryItem[];
  totals?: Record<string, number>;
  [key: string]: unknown;
}

export interface Session {
  id: string;
  car_profile_id: string | null;
  uploaded_at: string;
  source_filename: string;
  source_file_path: string | null;
  session_start: string | null;
  session_end: string | null;
  duration_seconds: number | null;
  row_count: number;
  columns: string[] | null;
  summary: SessionSummary | null;
  created_at: string;
  user_id: string | null;
  gemini_analysis: Record<string, unknown> | null;
}

export interface DashboardProblem {
  id: string;
  severity: SessionSeverity;
  message: string;
  parameter_key: string;
  canonical_key: string;
  session_id: string;
  uploaded_at?: string;
  source_filename?: string;
  resolved?: boolean | null;
}
