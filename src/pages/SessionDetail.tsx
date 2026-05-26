import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import SessionKPIs from '@/components/SessionKPIs';
import FlagsPanel from '@/components/FlagsPanel';
import SessionCharts from '@/components/SessionCharts';
import { Button } from '@/components/ui/button';
import { getSession, getSessionFlags, getSessionRows, deleteSessionFlags, insertSessionFlags, downloadSessionCSV } from '@/lib/db';
import { evaluateRules } from '@/lib/insight-engine';
import { DEFAULT_PRIUS_RULES } from '@/lib/default-rules';
import { ArrowLeft, RefreshCw, Download, Loader2, Activity } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

import { PageLoader } from '@/components/PageLoader';
import { useViewMode } from '@/hooks/use-view-mode';

import AIAnalysisCard from '@/components/AIAnalysisCard';
import DTCPanel from '@/components/DTCPanel';
import PhotoUpload from '@/components/PhotoUpload';
import { createSharedReport } from '@/lib/db-extras';
import { Share2 } from 'lucide-react';
import type { Session, SessionFlag, SessionRow, SessionSummary } from '@/types/session';

type SessionWithStoredCsv = Session & { source_csv?: string | null };

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [session, setSession] = useState<SessionWithStoredCsv | null>(null);
  const [flags, setFlags] = useState<SessionFlag[]>([]);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const { toggle: toggleViewMode, isAdvanced } = useViewMode();

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [s, f, r] = await Promise.all([
        getSession(id),
        getSessionFlags(id),
        getSessionRows(id),
      ]);
      setSession(s as unknown as SessionWithStoredCsv | null);
      setFlags(f as unknown as SessionFlag[]);
      setRows(r as unknown as SessionRow[]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const handleRecompute = useCallback(async () => {
    if (!id || !session || rows.length === 0) return;

    // Build a pseudo-parsed structure from stored rows
    const summary = session.summary as (SessionSummary & { headerMapping?: Record<string, string>; timeColumn?: string }) | null;
    const headerMapping = summary?.headerMapping || {};

    // Extract unique parameters from rows
    const allKeys = new Set<string>();
    rows.forEach(r => {
      const data = r.data as Record<string, unknown>;
      if (data) Object.keys(data).forEach(k => allKeys.add(k));
    });

    const pseudoParsed = {
      headers: Array.from(allKeys),
      rows: rows.map(r => r.data as Record<string, number | string | null>),
      headerMapping,
      timeColumn: summary?.timeColumn || null,
    };

    const newFlags = evaluateRules(pseudoParsed, DEFAULT_PRIUS_RULES);

    await deleteSessionFlags(id);
    await insertSessionFlags(id, newFlags.map(f => ({
      ...f,
      evidence: f.evidence as unknown as Record<string, unknown>,
    })));

    setFlags((await getSessionFlags(id)) as unknown as SessionFlag[]);
    toast({ title: 'Re-evaluated', description: `${newFlags.length} flags after re-computation.` });
  }, [id, session, rows, toast]);

  const handleDownloadCsv = useCallback(async () => {
    if (!session?.source_file_path && !session?.source_csv) {
      toast({ title: 'CSV unavailable', description: 'This session has no stored CSV file.', variant: 'destructive' });
      return;
    }

    setDownloadingCsv(true);
    try {
      await downloadSessionCSV(session.source_file_path, session.source_filename, session.source_csv, session.id);
    } catch (error) {
      console.error('Failed to download CSV:', error);
      toast({ title: 'Download failed', description: 'Could not download the CSV file.', variant: 'destructive' });
    } finally {
      setDownloadingCsv(false);
    }
  }, [session, toast]);

  if (loading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  if (!session) {
    return (
      <AppLayout>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Session not found.</p>
          <Button variant="ghost" onClick={() => navigate('/')} className="mt-4">Go Home</Button>
        </div>
      </AppLayout>
    );
  }

  const summary = session.summary as (SessionSummary & { headerMapping?: Record<string, string> }) | null;
  const headerMapping = summary?.headerMapping || {};
  const summaries = summary?.summaries || [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h2 className="text-lg font-mono font-bold text-foreground">{session.source_filename}</h2>
              <p className="text-xs text-muted-foreground font-mono">
                {new Date(session.uploaded_at).toLocaleString()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadCsv}
              className="text-xs"
              disabled={downloadingCsv || (!session.source_file_path && !session.source_csv)}
            >
              {downloadingCsv ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
              Download CSV
            </Button>
            <Button variant="outline" size="sm" onClick={handleRecompute} className="text-xs">
              <RefreshCw className="w-3 h-3 mr-1" /> Re-evaluate
            </Button>
            <Button
              variant={isAdvanced ? 'default' : 'outline'}
              size="sm"
              className="text-xs gap-1"
              onClick={toggleViewMode}
              title={isAdvanced ? 'Switch to Simple view' : 'Switch to Advanced view'}
            >
              <Activity className="w-3 h-3" />
              {isAdvanced ? 'Simple' : 'Advanced'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={async () => {
                if (!session) return;
                try {
                  const report = await createSharedReport(session.id, 30);
                  const url = `${window.location.origin}/share/${report.id}`;
                  await navigator.clipboard.writeText(url);
                  toast({ title: 'Share link copied', description: `Expires in 30 days. ${url}` });
                } catch (err) {
                  toast({ title: 'Could not create share link', description: String(err), variant: 'destructive' });
                }
              }}
            >
              <Share2 className="w-3 h-3 mr-1" /> Share with mechanic
            </Button>
          </div>
        </div>

        <SessionKPIs
          duration={session.duration_seconds}
          rowCount={session.row_count}
          parameterCount={summaries.length}
          attentionCount={flags.filter((f) => f.severity === 'attention').length}
          criticalCount={flags.filter((f) => f.severity === 'critical').length}
        />

        {session.gemini_analysis && (
          <AIAnalysisCard analysis={session.gemini_analysis} />
        )}

        {/* Improvement A2: DTC codes panel */}
        {((session as { active_dtcs?: string[] }).active_dtcs?.length ?? 0) > 0 && (
          <div>
            <h3 className="text-sm font-mono font-semibold text-foreground mb-3">Active Trouble Codes</h3>
            <DTCPanel codes={(session as { active_dtcs?: string[] }).active_dtcs || []} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {isAdvanced && (
              <div>
                <h3 className="text-sm font-mono font-semibold text-foreground mb-3">Sensor Parameters</h3>
                <SessionCharts rows={rows} headerMapping={headerMapping} rules={DEFAULT_PRIUS_RULES} />
              </div>
            )}
            {/* Improvement C3: photo upload */}
            <PhotoUpload sessionId={session.id} />
          </div>
          <div>
            <h3 className="text-sm font-mono font-semibold text-foreground mb-3">Flags</h3>
            <FlagsPanel flags={flags} />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
