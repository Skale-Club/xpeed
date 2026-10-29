import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, RefreshCw, Download, Loader2, CheckCircle2, ChevronDown, ChevronUp, Clock, Route, Gauge,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import SessionKPIs from '@/components/SessionKPIs';
import FlagsPanel from '@/components/FlagsPanel';
import SessionCharts from '@/components/SessionCharts';
import AIAnalysisCard from '@/components/AIAnalysisCard';
import DTCPanel from '@/components/DTCPanel';
import PhotoUpload from '@/components/PhotoUpload';
import ShareReportSection from '@/components/ShareReportSection';
import { PageLoader } from '@/components/PageLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/contexts/SettingsContext';
import {
  getSession, getSessionFlags, getSessionRows, downloadSessionCSV, getCarById,
} from '@/lib/db';
import { reprocessStoredSession } from '@/lib/reprocess-session';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import type { DefaultRule } from '@/lib/default-rules';
import { URGENCY, describeProblem } from '@/lib/problems';
import {
  formatDistance, formatDuration, formatTripDate, tripAverageSpeed, tripDate, tripDistanceKm, tripProblems, tripTitle,
} from '@/lib/trips';
import type { Session, SessionFlag, SessionRow, SessionSummary } from '@/types/session';
import { tripFuel } from '@/lib/trip-fuel';

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
  const [loadFailed, setLoadFailed] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [s, f, r] = await Promise.all([getSession(id), getSessionFlags(id), getSessionRows(id)]);
      const trip = s as unknown as SessionWithStoredCsv | null;
      setSession(trip);
      setFlags(f as unknown as SessionFlag[]);
      setRows(r as unknown as SessionRow[]);
      // Same car-specific rules as when the trip was saved (not always the Prius ones).
      const car = trip?.car_profile_id ? await getCarById(trip.car_profile_id) : null;
      setRules(resolveRulesetForCar(car).rules);
    } catch (err) {
      // A network error is not "trip not found": say so and let the owner retry.
      console.error('Could not load the trip:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleRecompute = useCallback(async () => {
    if (!id || !session || recomputing) return;
    setRecomputing(true);
    try {
      const count = await reprocessStoredSession(session);
      await load();
      toast({
        title: t('tripDetail.reevaluated', 'Checked again'),
        variant: 'success',
        description: t('tripDetail.reevaluatedCount', { count, defaultValue: '{{count}} readings out of range' }),
      });
    } catch (error) {
      console.error('Failed to re-evaluate the trip:', error);
      toast({ title: t('tripDetail.reevaluateFailed', "Couldn't check the trip again"), description: t('tripDetail.reevaluateFailedHint', 'The trip was left as it was. Try again.'), variant: 'destructive' });
    } finally {
      setRecomputing(false);
    }
  }, [id, session, recomputing, toast, t, load]);

  const handleDownloadCsv = useCallback(async () => {
    if (!session?.source_file_path && !session?.source_csv) return;
    setDownloadingCsv(true);
    try {
      await downloadSessionCSV(session.source_file_path, session.source_filename, session.source_csv, session.id);
    } catch (error) {
      console.error('Failed to download CSV:', error);
      toast({ title: t('tripDetail.downloadFailed', 'Download failed'), description: t('tripDetail.downloadFailedHint', 'Could not download the CSV file.'), variant: 'destructive' });
    } finally {
      setDownloadingCsv(false);
    }
  }, [session, toast, t]);

  if (loading) {
    return (
      <AppLayout>
        <PageLoader fullScreen={false} />
      </AppLayout>
    );
  }

  if (loadFailed) {
    return (
      <AppLayout>
        <div className="text-center py-12 space-y-4" role="alert">
          <p className="font-semibold">{t('tripDetail.loadFailed', "Couldn't load this trip")}</p>
          <p className="text-sm text-muted-foreground">{t('problems.checkFailedHint', 'Check your connection and try again.')}</p>
          <div className="flex justify-center gap-2">
            <Button onClick={() => void load()}>
              <RefreshCw className="w-4 h-4 mr-2" /> {t('problems.retry', 'Try again')}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/')}>{t('tripDetail.home', 'Go to Home')}</Button>
          </div>
        </div>
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
  const analysisOutdated = session.summary?.analysis_outdated === true;
  const aiSummary = !analysisOutdated && typeof session.gemini_analysis?.summary === 'string' ? session.gemini_analysis.summary : null;
  const avgSpeed = tripAverageSpeed(session);
  const fuel = tripFuel(rows, summaries, session.duration_seconds);
  const distance = tripDistanceKm(session);
  const enoughFuel = fuel?.coverage != null && fuel.coverage >= 0.9;
  const fuelUnit = distanceUnit === 'mi' ? 'US gal' : 'L';
  const fuelAmount = fuel ? fuel.litres / (distanceUnit === 'mi' ? 3.785411784 : 1) : null;
  const fuelEfficiency = enoughFuel && fuel && fuel.litres > 0 && distance != null && distance > 0
    ? distanceUnit === 'mi' ? `${(distance * 0.621371 / (fuel.litres / 3.785411784)).toFixed(1)} MPG` : `${(distance / fuel.litres).toFixed(1)} km/L`
    : null;
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
            {analysisOutdated && <p className="text-sm text-muted-foreground">{t('tripDetail.analysisOutdated', 'Readings were checked again. The previous AI summary has not been regenerated.')}</p>}
          </CardContent>
        </Card>

        {/* 2. Problems in this trip */}
        <Card><CardContent className="space-y-2 p-4">
          <h3 className="font-semibold">{t('tripDetail.fuelTitle', 'Fuel consumption')}</h3>
          {fuel ? <>
            <p className="text-xl font-semibold tabular-nums">{fuelAmount!.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 2 })} {fuelUnit}</p>
            <p className="text-xs text-muted-foreground">{t('tripDetail.fuelMeasured', 'Calculated from recorded fuel-flow readings. Coverage: {{coverage}}.', { coverage: fuel.coverage == null ? '—' : `${Math.round(fuel.coverage * 100)}%` })}</p>
            {!enoughFuel && <p className="text-xs text-warn">{t('tripDetail.fuelPartial', 'Partial recording: this is only the fuel covered by the readings, not the whole trip.')}</p>}
            {fuelEfficiency && <p className="font-medium">{t('tripDetail.fuelEconomy', 'Trip fuel economy')}: {fuelEfficiency}</p>}
          </> : <p className="text-sm text-muted-foreground">{t('tripDetail.fuelUnavailable', 'No usable fuel-flow readings were recorded for this trip.')}</p>}
          <p className="text-xs text-muted-foreground">{t('tripDetail.fuelCostHint', 'A monetary cost also needs the fuel price paid. No cost has been assumed.')}</p>
        </CardContent></Card>
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
        <ShareReportSection session={session} />

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
                  {t('tripDetail.downloadCsv', 'Download CSV')}
                </Button>
                <Button variant="outline" size="sm" className="text-xs" disabled={recomputing} onClick={() => void handleRecompute()}>
                  <RefreshCw className="w-3 h-3 mr-1" /> {t('tripDetail.reevaluate', 'Re-evaluate')}
                </Button>
              </div>
              <SessionKPIs
                duration={session.duration_seconds}
                rowCount={session.row_count}
                parameterCount={summaries.length}
                attentionCount={flags.filter((f) => f.severity === 'attention').length}
                criticalCount={flags.filter((f) => f.severity === 'critical').length}
              />
              {session.gemini_analysis && !analysisOutdated && <AIAnalysisCard analysis={session.gemini_analysis} />}
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
