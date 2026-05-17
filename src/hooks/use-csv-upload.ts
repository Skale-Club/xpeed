import { useState, useCallback } from 'react';
import { parseCSV } from '@/lib/csv-parser';
import { computeParameterSummaries, evaluateRules } from '@/lib/insight-engine';
import {
  createSession, insertSessionRows, insertSessionFlags, uploadSessionCSV, removeSessionCSV, deleteSession,
  getCarById,
} from '@/lib/db';
import { refreshParameterBaselines } from '@/lib/db-extras';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import { downsampleSessionRows } from '@/lib/downsample';
import { useToast } from '@/hooks/use-toast';

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

    setUploading(true);
    setProgressValue(0);
    setProgressLabel('');
    let sourceFilePath: string | null = null;
    let createdSessionId: string | null = null;
    try {
      updateProgress(6, 'Reading file...');
      const text = await file.text();

      updateProgress(15, 'Parsing CSV...');
      const parsed = parseCSV(text);
      if (parsed.rows.length === 0) {
        toast({ title: 'Empty CSV', description: 'No data rows found.', variant: 'destructive' });
        return;
      }

      updateProgress(28, 'Computing insights...');
      const summaries = computeParameterSummaries(parsed);

      // Resolve the right ruleset for this car (make/model/year aware) instead
      // of always using Prius rules. Falls back to engine_type, then generic petrol.
      const car = await getCarById(carProfileId);
      const ruleset = resolveRulesetForCar(car);
      const flags = evaluateRules(parsed, ruleset.rules);

      // Estimate duration
      let durationSeconds: number | undefined;
      if (parsed.timeColumn?.type === 'seconds' && parsed.rows.length > 1) {
        const times = parsed.rows
          .map(r => r[parsed.timeColumn!.key])
          .filter((v): v is number => typeof v === 'number');
        if (times.length > 1) {
          durationSeconds = Math.round(times[times.length - 1] - times[0]);
        }
      }

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

      updateProgress(42, 'Saving original CSV...');
      try {
        sourceFilePath = await uploadSessionCSV(file, carProfileId);
      } catch (storageError) {
        sourceFilePath = null;
        console.warn('Storage upload unavailable, keeping CSV in database only:', storageError);
      }

      updateProgress(55, 'Saving session...');
      const session = await createSession(
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
        text,
        parsed.activeDtcs,
      );
      createdSessionId = session.id;

      updateProgress(58, 'Saving data rows (0%)...');
      const rawDbRows = parsed.rows.map((row, idx) => {
        let t_seconds: number | null = null;
        let t_timestamp: string | null = null;
        if (parsed.timeColumn) {
          const val = row[parsed.timeColumn.key];
          if (parsed.timeColumn.type === 'seconds' && typeof val === 'number') {
            t_seconds = val;
          } else if (parsed.timeColumn.type === 'timestamp' && typeof val === 'string') {
            t_timestamp = val;
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
      // preserved in storage (source_csv), so users can always re-derive
      // the original data; the DB just gets a chart-friendly summary.
      const dbRows = downsampleSessionRows(rawDbRows, 2000);

      await insertSessionRows(session.id, dbRows, (percent) => {
        const weightedProgress = 58 + (percent * 0.3);
        updateProgress(weightedProgress, `Saving data rows (${percent}%)...`);
      });

      updateProgress(90, 'Saving flags...');
      await insertSessionFlags(session.id, flags.map(f => ({
        ...f,
        evidence: f.evidence as unknown as Record<string, unknown>,
      })));

      // Analyze with Gemini via the shared admin-configured Edge Function.
      // Single provider for all users — no per-user API key path.
      // Failure here is non-fatal: the session is already saved.
      try {
        updateProgress(95, 'Analyzing with AI...');
        const { updateSessionWithGeminiAnalysis } = await import('@/lib/db');
        const { analyzeSessionViaEdge } = await import('@/lib/ai-client');

        // Compact summary payload for the Edge Function (string form keeps the
        // function generic and avoids leaking PII into a JSON dump).
        const summaryLines: string[] = [
          `File: ${file.name}`,
          `Rows: ${parsed.rows.length}`,
          durationSeconds ? `Duration: ${Math.round(durationSeconds / 60)} min` : '',
          parsed.activeDtcs.length ? `Active DTCs: ${parsed.activeDtcs.join(', ')}` : '',
          flags.length ? `Flags: ${flags.map(f => `${f.severity}/${f.canonical_key}`).join('; ')}` : 'No flags',
          'Key params:',
          ...summaries.slice(0, 10).map(s => `  - ${s.label || s.canonical_key}: avg=${s.avg.toFixed(1)} min=${s.min.toFixed(1)} max=${s.max.toFixed(1)}`),
        ].filter(Boolean);

        const analysis = await analyzeSessionViaEdge(summaryLines.join('\n'));
        if (analysis) {
          await updateSessionWithGeminiAnalysis(session.id, analysis as unknown as Record<string, unknown>);
        }
        // else: Edge Function returned null (admin hasn't configured the key,
        // user is over quota, or the call failed). Session is still saved
        // successfully — just without the AI summary.
      } catch (aiError) {
        console.warn('Gemini analysis skipped:', aiError);
      }

      // Refresh rolling baselines for this car (used by anomaly detection).
      // Best-effort; never block the upload completion.
      try {
        await refreshParameterBaselines(carProfileId);
      } catch (baselineErr) {
        console.warn('Baseline refresh skipped:', baselineErr);
      }

      updateProgress(100, 'Upload complete!');
      toast({ title: 'Upload complete!', description: `${parsed.rows.length} rows, ${flags.length} flags, ${parsed.activeDtcs.length} DTCs.` });
      onComplete(session.id);
    } catch (err) {
      console.error(err);

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

      toast({ title: 'Upload failed', description: String(err), variant: 'destructive' });
    } finally {
      setUploading(false);
      setProgressLabel('');
      setProgressValue(0);
    }
  }, [carProfileId, onComplete, toast, updateProgress]);

  return { upload, uploading, progressLabel, progressValue };
}
