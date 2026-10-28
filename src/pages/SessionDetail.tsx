import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, RefreshCw, Download, Loader2, Share2, CheckCircle2, ChevronDown, ChevronUp, Clock, Route, Gauge,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import SessionKPIs from '@/components/SessionKPIs';
import FlagsPanel from '@/components/FlagsPanel';
import SessionCharts from '@/components/SessionCharts';
import AIAnalysisCard from '@/components/AIAnalysisCard';
import DTCPanel from '@/components/DTCPanel';
import PhotoUpload from '@/components/PhotoUpload';
import { PageLoader } from '@/components/PageLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/contexts/SettingsContext';
import {
  getSession, getSessionFlags, getSessionRows, deleteSessionFlags, insertSessionFlags, downloadSessionCSV, getCarById,
} from '@/lib/db';
import { createSharedReport } from '@/lib/db-extras';
import { evaluateRules } from '@/lib/insight-engine';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import type { DefaultRule } from '@/lib/default-rules';
import { URGENCY, describeProblem } from '@/lib/problems';
import {
  formatDistance, formatDuration, formatTripDate, publicAppUrl, tripAverageSpeed, tripDate, tripDistanceKm, tripProblems, tripTitle,
} from '@/lib/trips';
import type { Session, SessionFlag, SessionRow, SessionSummary } from '@/types/session';

type SessionWithStoredCsv = Session & { source_csv?: string | null; active_dtcs?: string[] | null };

const URGENCY_STYLE = {
  urgent: 'bg-destructive/15 text-destructive border-destructive/30',
  soon: 'bg-warn/15 text-warn border-warn/30',
  watch: 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30',
  later: 'bg-muted text-muted-foreground border-border',
} as const;

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { distanceUnit } = useSettings();
  const [session, setSession] = useState<SessionWithStoredCsv | null>(null);
  const [flags, setFlags] = useState<SessionFlag[]>([]);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [rules, setRules] = useState<DefaultRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [s, f, r] = await Promise.all([getSession(id), getSessionFlags(id), getSessionRows(id)]);
      const trip = s as unknown as SessionWithStoredCsv | null;
      setSession(trip);
      setFlags(f as unknown as SessionFlag[]);
      setRows(r as unknown as SessionRow[]);
      // Same car-specific rules as when the trip was saved (not always the Prius ones).
      const car = trip?.car_profile_id ? await getCarById(trip.car_profile_id) : null;
      setRules(resolveRulesetForCar(car).rules);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleRecompute = useCallback(async () => {
    if (!id || !session || rows.length === 0) return;
    const summary = session.summary as (SessionSummary & { headerMapping?: Record<string, string>; timeColumn?: string }) | null;
    const allKeys = new Set<string>();
    rows.forEach((r) => {
      const data = r.data as Record<string, unknown>;
      if (data) Object.keys(data).forEach((k) => allKeys.add(k));
    });
    const pseudoParsed = {
      headers: Array.from(allKeys),
      rows: rows.map((r) => r.data as Record<string, number | string | null>),
      headerMapping: summary?.headerMapping || {},
      timeColumn: summary?.timeColumn || null,
    };
    const newFlags = evaluateRules(pseudoParsed as never, rules);
    await deleteSessionFlags(id);
    await insertSessionFlags(id, newFlags.map((f) => ({ ...f, evidence: f.evidence as unknown as Record<string, unknown> })));
    setFlags((await getSessionFlags(id)) as unknown as SessionFlag[]);
    toast({ title: 'Re-evaluated', description: `${newFlags.length} flags after re-computation.` });
  }, [id, session, rows, rules, toast]);

  const handleDownloadCsv = useCallback(async () => {
    if (!session?.source_file_path && !session?.source_csv) return;
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

  /** A read-only report link the owner can send to a mechanic (expires in 30 days). */
  const shareWithMechanic = async () => {
    if (!session) return;
    setSharing(true);
    try {
      const report = await createSharedReport(session.id, 30);
      const url = `${publicAppUrl()}/share/${report.id}`;
      const title = tripTitle(session, t);
      if (navigator.share) {
        await navigator.share({ title, text: t('tripDetail.shareText', 'Report of my car: {{title}}', { title }), url });
      } else {
        await navigator.clipboard.writeText(url);
        toast({ title: t('tripDetail.linkCopied', 'Link copied'), description: t('tripDetail.linkCopiedHint', 'Paste it in a message to your mechanic. It works for 30 days.') });
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // closed the share sheet
      console.error(err);
      toast({ title: t('tripDetail.shareFailed', "Couldn't create the link"), variant: 'destructive' });
    } finally {
      setSharing(false);
    }
  };

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
          <p className="text-muted-foreground">{t('tripDetail.notFound', 'Trip not found.')}</p>
          <Button variant="ghost" onClick={() => navigate('/')} className="mt-4">{t('tripDetail.home', 'Go to Home')}</Button>
        </div>
      </AppLayout>
    );
  }

  const summary = session.summary as (SessionSummary & { headerMapping?: Record<string, string> }) | null;
  const headerMapping = summary?.headerMapping || {};
  const summaries = summary?.summaries || [];
  const problems = tripProblems(flags, session.active_dtcs);
  const aiSummary = typeof session.gemini_analysis?.summary === 'string' ? session.gemini_analysis.summary : null;
  const avgSpeed = tripAverageSpeed(session);
  const facts = [
    { icon: Clock, label: t('tripDetail.duration', 'Duration'), value: formatDuration(session.duration_seconds) },
    { icon: Route, label: t('tripDetail.distance', 'Distance'), value: formatDistance(tripDistanceKm(session), distanceUnit) },
    {
      icon: Gauge,
      label: t('tripDetail.avgSpeed', 'Average speed'),
      value: avgSpeed == null ? null : `${Math.round(distanceUnit === 'mi' ? avgSpeed * 0.621371 : avgSpeed)} ${distanceUnit === 'mi' ? 'mph' : 'km/h'}`,
    },
  ].filter((f) => f.value);

  return (
    <AppLayout>
      <div className="max-w-3xl space-y-5">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label={t('tripDetail.back', 'Back')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-xl font-bold truncate">{tripTitle(session, t)}</h2>
            <p className="text-sm text-muted-foreground">{formatTripDate(tripDate(session), i18n.resolvedLanguage)}</p>
          </div>
        </div>

        {/* 1. Summary */}
        <Card>
          <CardContent className="p-4 space-y-3">
            {facts.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {facts.map(({ icon: Icon, label, value }) => (
                  <div key={label} className="text-center">
                    <Icon className="w-4 h-4 mx-auto text-muted-foreground" />
                    <p className="font-semibold tabular-nums">{value}</p>
                    <p className="text-[11px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            )}
            {aiSummary && <p className="text-sm leading-relaxed">{aiSummary}</p>}
          </CardContent>
        </Card>

        {/* 2. Problems in this trip */}
        <div className="space-y-2">
          <h3 className="font-semibold">{t('tripDetail.problemsTitle', 'Problems in this trip')}</h3>
          {problems.length === 0 ? (
            <Card className="border-success/40">
              <CardContent className="p-4 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-success" />
                <p className="text-sm">{t('tripDetail.noProblems', 'Nothing wrong was found on this trip.')}</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {problems.map((p) => {
                const text = describeProblem(p, t);
                const urgency = URGENCY[p.severity];
                return (
                  <Card key={p.canonical_key} data-testid="trip-problem">
                    <CardContent className="p-4 space-y-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${URGENCY_STYLE[urgency]}`}>
                        {t(`problems.urgency.${urgency}`)}
                      </span>
                      <h4 className="font-semibold">{text.title}</h4>
                      <p className="text-sm text-muted-foreground">{text.meaning}</p>
                      <p className="text-sm"><span className="font-medium">{t('problems.whatToDo', 'What to do')}: </span>{text.action}</p>
                    </CardContent>
                  </Card>
                );
              })}
              <Link to="/issues" className="text-sm text-primary hover:underline">{t('tripDetail.allProblems', "See all of the car's problems")}</Link>
            </>
          )}
        </div>

        {/* 3. Send to the mechanic */}
        <Button size="lg" className="w-full" onClick={() => void shareWithMechanic()} disabled={sharing}>
          {sharing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Share2 className="w-4 h-4 mr-2" />}
          {t('tripDetail.share', 'Send to the mechanic')}
        </Button>

        <PhotoUpload sessionId={session.id} />

        {/* Technical details, closed by default */}
        <div className="border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setShowTechnical((v) => !v)}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
            aria-expanded={showTechnical}
          >
            {showTechnical ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            {t('home.technical', 'Technical details')}
          </button>
          {showTechnical && (
            <div className="space-y-6 mt-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline" size="sm" className="text-xs" onClick={() => void handleDownloadCsv()}
                  disabled={downloadingCsv || (!session.source_file_path && !session.source_csv)}
                >
                  {downloadingCsv ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                  Download CSV
                </Button>
                <Button variant="outline" size="sm" className="text-xs" onClick={() => void handleRecompute()}>
                  <RefreshCw className="w-3 h-3 mr-1" /> Re-evaluate
                </Button>
              </div>
              <SessionKPIs
                duration={session.duration_seconds}
                rowCount={session.row_count}
                parameterCount={summaries.length}
                attentionCount={flags.filter((f) => f.severity === 'attention').length}
                criticalCount={flags.filter((f) => f.severity === 'critical').length}
              />
              {session.gemini_analysis && <AIAnalysisCard analysis={session.gemini_analysis as never} />}
              {(session.active_dtcs?.length ?? 0) > 0 && <DTCPanel codes={session.active_dtcs || []} />}
              <FlagsPanel flags={flags} />
              <SessionCharts rows={rows} headerMapping={headerMapping as never} rules={rules as never} />
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
