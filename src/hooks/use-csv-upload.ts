import { useState, useCallback } from 'react';
import { parseCSV } from '@/lib/csv-parser';
import { computeParameterSummaries, evaluateRules } from '@/lib/insight-engine';
import {
  createSession, insertSessionRows, insertSessionFlags, uploadSessionCSV, removeSessionCSV, deleteSession,
  getCarById, storeSessionReport, updateSessionVersioning,
} from '@/lib/db';
import { refreshParameterBaselines } from '@/lib/db-extras';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import { downsampleSessionRows } from '@/lib/downsample';
import { generateReport, REPORT_VERSION, PROCESSING_VERSION } from '@/lib/report-generator';
import { reconcileIssues, syncAiWarnings, syncFaultCodes, type FaultCodeSync } from '@/lib/issue-reconciler';
import { useToast } from '@/hooks/use-toast';
import { sessionDuration, sessionTimes } from '@/lib/session-time';
import { csvChecksum, hasRecordedReceipt, storeRecordedSession, type RecordingIdentity } from '@/lib/recorded-session';

export class EmptyCsvError extends Error {
  constructor() {
    super('No data rows found.');
    this.name = 'EmptyCsvError';
  }
}

/** Trips shorter than this get an AI summary only if something stood out. */
const MIN_ANALYZED_TRIP_S = 3 * 60;

export interface IngestResult {
  sessionId: string;
  rows: number;
  flags: number;
  dtcs: number;
}

/**
 * Turn a CSV log into a stored session: parse, evaluate rules, save rows,
 * flags and report, reconcile issues, run the AI analysis and refresh
 * baselines. Used by file uploads and by trips recorded with the live scanner.
 * Rolls back the session on failure and rethrows.
 */
export async function ingestSessionCsv(
  file: File,
  carProfileId: string,
  customName?: string,
  updateProgress: (value: number, label: string) => void = () => undefined,
  /** Called once the trip, its rows and flags are in the database (before report, AI and baselines). */
  onStored?: (sessionId: string) => void | Promise<void>,
  /**
   * The car's fault codes as read live (confirmed vs pending, and whether the
   * read worked). Without it, codes in the CSV count as confirmed and nothing
   * is closed for being missing.
   */
  faultCodes?: FaultCodeSync,
  recording?: RecordingIdentity,
): Promise<IngestResult> {
  let sourceFilePath: string | null = null;
  let createdSessionId: string | null = null;
  let stored = false;
  try {
    updateProgress(6, 'Reading file...');
    const text = await file.text();

    updateProgress(15, 'Parsing CSV...');
    const parsed = parseCSV(text);
    if (parsed.rows.length === 0) throw new EmptyCsvError();

    updateProgress(28, 'Computing insights...');
    const summaries = computeParameterSummaries(parsed);

    // Resolve the right ruleset for this car (make/model/year aware) instead
    // of always using Prius rules. Falls back to engine_type, then generic petrol.
    const car = await getCarById(carProfileId);
    const ruleset = resolveRulesetForCar(car);
    const flags = evaluateRules(parsed, ruleset.rules);
    const checksum = recording ? await csvChecksum(text) : '';
    const resultFor = (sessionId: string) => ({ sessionId, rows: parsed.rows.length, flags: flags.length, dtcs: parsed.activeDtcs.length });
    if (recording && await hasRecordedReceipt(recording, carProfileId, checksum)) {
      stored = true;
      await onStored?.(recording.sessionId);
      return resultFor(recording.sessionId);
    }

    // Estimate duration
    const durationSeconds = sessionDuration(parsed);

    // Estimate start time
    let sessionStart: string | null = null;

    // 1. Try from timestamp column
    if (parsed.timeColumn?.type === 'timestamp' && parsed.rows.length > 0) {
      const firstRowTime = parsed.rows[0][parsed.timeColumn.key];
      if (typeof firstRowTime === 'string') {
        const d = new Date(firstRowTime);
        if (!isNaN(d.getTime())) {
          sessionStart = d.toISOString();
        }
      }
    }

    // 2. Try from filename (e.g. "2025-02-09 15-30-00.csv")
    if (!sessionStart) {
      const filename = file.name;
      const match = filename.match(/(\d{4})-(\d{2})-(\d{2})[\s_-](\d{2})-(\d{2})-(\d{2})/);
      if (match) {
        const [_, y, m, d, h, min, s] = match;
        const date = new Date(
          parseInt(y),
          parseInt(m) - 1,
          parseInt(d),
          parseInt(h),
          parseInt(min),
          parseInt(s)
        );
        if (!isNaN(date.getTime())) {
          sessionStart = date.toISOString();
        }
      }
    }

    // Recordings already know the exact instant; a local filename loses timezone/DST and milliseconds.
    if (recording?.startedAt) sessionStart = new Date(recording.startedAt).toISOString();

    updateProgress(42, 'Saving original CSV...');
    try {
      sourceFilePath = await uploadSessionCSV(file, carProfileId);
    } catch (storageError) {
      sourceFilePath = null;
      console.warn('Storage upload unavailable, keeping CSV in database only:', storageError);
    }

    updateProgress(55, 'Saving session...');
    const summary = { summaries, headerMapping: parsed.headerMapping, timeColumn: parsed.timeColumn, rulesetId: ruleset.id, rulesetMatchedVia: ruleset.matched_via };
    const session = recording ? { id: recording.sessionId } : await createSession(
      carProfileId,
      customName || file.name,
      parsed.rows.length,
      parsed.headers,
      {
        summaries,
        headerMapping: parsed.headerMapping,
        timeColumn: parsed.timeColumn,
        rulesetId: ruleset.id,
        rulesetMatchedVia: ruleset.matched_via,
      },
      durationSeconds,
      sessionStart,
      sourceFilePath,
      // The full CSV goes in the row only when storage didn't take it; otherwise the row stays light.
      sourceFilePath ? null : text,
      parsed.activeDtcs,
    );
    createdSessionId = session.id;

    updateProgress(58, 'Saving data rows (0%)...');
    const timeline = sessionTimes(parsed);
    const origin = timeline.find((value) => value !== null) ?? 0;
    const rawDbRows = parsed.rows.map((row, idx) => {
      let t_seconds: number | null = null;
      let t_timestamp: string | null = null;
      if (parsed.timeColumn) {
        const val = row[parsed.timeColumn.key];
        if (parsed.timeColumn.type === 'seconds' && typeof val === 'number') {
          t_seconds = val;
        } else if (parsed.timeColumn.type === 'timestamp' && typeof val === 'string') {
          t_timestamp = val;
          t_seconds = timeline[idx] == null ? null : timeline[idx]! - origin;
        }
      } else {
        t_seconds = idx;
      }

      const data: Record<string, unknown> = {};
      parsed.headers.forEach(h => {
        if (h !== parsed.timeColumn?.key && typeof row[h] === 'number') {
          data[h] = row[h];
        }
      });

      return { t_seconds, t_timestamp, data };
    });

    // Cap stored rows at 2000 via LTTB downsampling. The full CSV is still
    // preserved in storage (or, if that failed, in sessions.source_csv), so users
    // can always re-derive the original data; the DB just gets a chart-friendly summary.
    const dbRows = downsampleSessionRows(rawDbRows, 2000);

    const report = generateReport({ sessionId: session.id, filename: file.name, parsed, summaries, flags, durationSeconds, sessionStart, car, rulesetId: ruleset.id, rulesetMatchedVia: ruleset.matched_via });
    if (recording) {
      const published = await storeRecordedSession(recording, carProfileId, checksum, customName || file.name, sessionStart, sourceFilePath, text, {
        rows: dbRows, flags, report, summary, columns: parsed.headers, row_count: parsed.rows.length,
        duration_seconds: durationSeconds ?? null, active_dtcs: parsed.activeDtcs,
        ruleset_id: ruleset.id, ruleset_matched_via: ruleset.matched_via, report_version: REPORT_VERSION, processing_version: PROCESSING_VERSION,
      });
      stored = true;
      await onStored?.(session.id);
      if (!published) {
        // Another tab committed this recording first. Our unique Storage path is unused.
        if (sourceFilePath) await removeSessionCSV(sourceFilePath).catch(error => console.warn('Unused recording CSV cleanup failed:', error));
        return resultFor(session.id); // never spend AI quota twice
      }
    } else {
      await insertSessionRows(session.id, dbRows, (percent) => {
        const weightedProgress = 58 + (percent * 0.3);
        updateProgress(weightedProgress, `Saving data rows (${percent}%)...`);
      });

      updateProgress(90, 'Saving flags...');
      await insertSessionFlags(session.id, flags.map(f => ({
        ...f,
        evidence: f.evidence as unknown as Record<string, unknown>,
      })));
      // From here on the trip is kept even if a later step fails (no rollback). Reaching this
      // line means the session, every data row and the flags were saved: createSession,
      // insertSessionRows and insertSessionFlags throw on any database error, which lands in the
      // rollback below, so onStored (which lets the caller drop its backup copy) never runs early.
      stored = true;
      await onStored?.(session.id);

      // Generate structured report (deterministic, no AI).
      // Store it on the session so the edge function can read it instead of
      // receiving a raw CSV dump as a string.
      try {
        await Promise.all([
          storeSessionReport(session.id, report as unknown as Record<string, unknown>),
          updateSessionVersioning(session.id, {
            ruleset_id: ruleset.id,
            ruleset_matched_via: ruleset.matched_via,
            report_version: REPORT_VERSION,
            processing_version: PROCESSING_VERSION,
          }),
        ]);
      } catch (reportErr) {
        console.warn('Report generation skipped:', reportErr);
      }
    }

    // Reconcile flags into the persistent vehicle_issues table.
    // Non-fatal — session is already saved even if this fails.
    let userId: string | null = null;
    try {
      const { data: { user } } = await import('@/integrations/supabase/client').then(
        (m) => m.supabase.auth.getUser()
      );
      userId = user?.id ?? null;
      if (user) {
        await reconcileIssues(session.id, carProfileId, user.id, flags, sessionStart);
        await syncFaultCodes(
          carProfileId,
          user.id,
          faultCodes ?? { stored: parsed.activeDtcs, pending: [], checked: false },
          session.id,
          sessionStart ?? undefined,
        );
      }
    } catch (issueErr) {
      console.warn('Issue reconciliation skipped:', issueErr);
    }

    // Plain-language AI summary via the shared admin-configured Edge Function.
    // With always-on recording a day can hold many short hops, so a short trip
    // where nothing stood out gets no summary (saves the daily AI quota).
    // Failure here is non-fatal: the session is already saved.
    const worthAnalyzing = (durationSeconds ?? 0) >= MIN_ANALYZED_TRIP_S || flags.some((f) => f.severity !== 'normal') || parsed.activeDtcs.length > 0;
    if (worthAnalyzing) {
      try {
        updateProgress(95, 'Analyzing with AI...');
        const { updateSessionWithGeminiAnalysis } = await import('@/lib/db');
        const { analyzeSessionById } = await import('@/lib/ai-client');

        const analysis = await analyzeSessionById(session.id);
        if (analysis) {
          await updateSessionWithGeminiAnalysis(session.id, analysis as unknown as Record<string, unknown>);
          // Concerns the AI saw that no fault code or rule covers go to the problem list too.
          if (userId && analysis.warnings?.length) {
            await syncAiWarnings(carProfileId, userId, analysis.warnings, session.id, sessionStart ?? undefined);
          }
        }
      } catch (aiError) {
        console.warn('AI analysis skipped:', aiError);
      }
    }

    // Refresh rolling baselines for this car (used by anomaly detection).
    // Best-effort; never block the upload completion.
    try {
      await refreshParameterBaselines(carProfileId);
    } catch (baselineErr) {
      console.warn('Baseline refresh skipped:', baselineErr);
    }

    updateProgress(100, 'Upload complete!');
    return { sessionId: session.id, rows: parsed.rows.length, flags: flags.length, dtcs: parsed.activeDtcs.length };
  } catch (err) {
    // A lost RPC response may already have committed. Never delete by identity on uncertainty.
    if (recording) throw err;
    if (stored) throw err;
    if (createdSessionId) {
      try {
        await deleteSession(createdSessionId);
      } catch (cleanupError) {
        console.warn('Failed to rollback failed session upload:', cleanupError);
      }
    } else if (sourceFilePath) {
      try {
        await removeSessionCSV(sourceFilePath);
      } catch (cleanupError) {
        console.warn('Failed to cleanup CSV after upload error:', cleanupError);
      }
    }
    throw err;
  }
}

export function useCSVUpload(onComplete: (sessionId: string) => void, carProfileId?: string) {
  const [uploading, setUploading] = useState(false);
  const [progressLabel, setProgressLabel] = useState('');
  const [progressValue, setProgressValue] = useState(0);
  const { toast } = useToast();

  const updateProgress = useCallback((value: number, label: string) => {
    const clamped = Math.max(0, Math.min(100, Math.round(value)));
    setProgressValue((prev) => (clamped > prev ? clamped : prev));
    setProgressLabel(label);
  }, []);

  const upload = useCallback(async (file: File, customName?: string) => {
    if (!carProfileId) {
      toast({ title: 'Error', description: 'Please select a vehicle first.', variant: 'destructive' });
      return;
    }

    // S04-2: guard against oversized/pathological CSVs before reading the whole
    // file into memory and parsing it (self-DoS protection). Matches the 50 MB
    // session-csv storage bucket ceiling but stops work earlier.
    const MAX_CSV_BYTES = 25 * 1024 * 1024;
    if (file.size > MAX_CSV_BYTES) {
      toast({ title: 'File too large', description: 'CSV files must be under 25 MB.', variant: 'destructive' });
      return;
    }
    if (file.name && !/\.csv$/i.test(file.name)) {
      toast({ title: 'Invalid file', description: 'Please select a .csv file.', variant: 'destructive' });
      return;
    }

    setUploading(true);
    setProgressValue(0);
    setProgressLabel('');
    try {
      const result = await ingestSessionCsv(file, carProfileId, customName, updateProgress);
      toast({ title: 'Upload complete!', description: `${result.rows} rows, ${result.flags} flags, ${result.dtcs} DTCs.` });
      onComplete(result.sessionId);
    } catch (err) {
      if (err instanceof EmptyCsvError) {
        toast({ title: 'Empty CSV', description: 'No data rows found.', variant: 'destructive' });
      } else {
        console.error(err);
        toast({ title: 'Upload failed', description: String(err), variant: 'destructive' });
      }
    } finally {
      setUploading(false);
      setProgressLabel('');
      setProgressValue(0);
    }
  }, [carProfileId, onComplete, toast, updateProgress]);

  return { upload, uploading, progressLabel, progressValue };
}
