import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft, RefreshCw, Download, Loader2, CheckCircle2, ChevronDown, ChevronUp, Clock, Route, Gauge, Fuel, Sparkles,
} from 'lucide-react';
import { completeTripInspection } from '@/lib/trip-inspection';
import AppLayout from '@/components/AppLayout';
import SessionKPIs from '@/components/SessionKPIs';
import FlagsPanel from '@/components/FlagsPanel';
import { lazyChart } from '@/components/LazyChart';

const SessionCharts = lazyChart(() => import('@/components/SessionCharts'), 'h-72');
import AIAnalysisCard from '@/components/AIAnalysisCard';
import DTCPanel from '@/components/DTCPanel';
import PhotoUpload from '@/components/PhotoUpload';
import ShareReportSection from '@/components/ShareReportSection';
import { PageLoader } from '@/components/PageLoader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { litresPerUnit, fuelEconomy, economyLabel } from '@/lib/fuel-units';
import { useSettings } from '@/contexts/SettingsContext';
import {
  getSession, getSessionFlags, getSessionRows, downloadSessionCSV, getCarById,
} from '@/lib/db';
import { reprocessStoredSession } from '@/lib/reprocess-session';
import { resolveRulesetForCar } from '@/lib/rule-resolver';
import type { DefaultRule } from '@/lib/default-rules';
import { URGENCY, describeProblem } from '@/lib/problems';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import {
  formatDistance, formatDuration, formatTripDate, tripAverageSpeed, tripDate, tripDistanceKm, tripProblems, tripTitle,
} from '@/lib/trips';
import type { Session, SessionFlag, SessionRow, SessionSummary } from '@/types/session';
import { TripFuelCost } from '@/components/FuelSummary';
import { readFuelMetrics } from '@/lib/fuel-ledger';
import { tripFuel } from '@/lib/trip-fuel';
import { analyseTrip } from '@/lib/trip-analysis';
import { TripDashboards, TripStats, type TripStat } from '@/components/trip/TripDashboards';
import type { EngineType } from '@/lib/db';

type SessionWithStoredCsv = Session & { source_csv?: string | null; active_dtcs?: string[] | null };

const URGENCY_TONE = {
  urgent: 'critical',
  soon: 'warn',
  watch: 'warn',
  later: 'neutral',
} as const satisfies Record<string, StatusTone>;

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { t, i18n } = useTranslation();
  const { volumeUnit, consumptionUnit, distanceUnit } = useSettings();
  const [session, setSession] = useState<SessionWithStoredCsv | null>(null);
  const [flags, setFlags] = useState<SessionFlag[]>([]);
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [rules, setRules] = useState<DefaultRule[]>([]);
  const [engineType, setEngineType] = useState<EngineType | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [downloadingCsv, setDownloadingCsv] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [attachmentDraft, setAttachmentDraft] = useState(false);

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
      setEngineType((car as { engine_type?: EngineType | null } | null)?.engine_type ?? null);
    } catch (err) {
      // A network error is not "trip not found": say so and let the owner retry.
      console.error('Could not load the trip:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const analysis = useMemo(() => {
    const mapping = (session?.summary as { headerMapping?: Record<string, { canonical_key: string } | null> } | null)?.headerMapping ?? {};
    return analyseTrip(rows, mapping, { hybrid: engineType === 'hybrid' });
  }, [rows, session?.summary, engineType]);

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
      toast({ title: t('tripDetail.downloadFailed', 'Download failed'), description: t('tripDetail.downloadFailedHint', 'Couldn\'t download the file.'), variant: 'destructive' });
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
  const problems = tripProblems(flags, session.active_dtcs, session.summary);
  const analysisOutdated = session.summary?.analysis_outdated === true;
  const aiSummary = !analysisOutdated && typeof session.gemini_analysis?.summary === 'string' ? session.gemini_analysis.summary : null;
  const avgSpeed = tripAverageSpeed(session);
  const metrics = readFuelMetrics(session);
  const fuel = metrics?.litres != null ? { litres: metrics.litres, coverage: metrics.coverage } : tripFuel(rows, summaries, session.duration_seconds);
  const distance = tripDistanceKm(session);
  const enoughFuel = fuel?.coverage != null && fuel.coverage >= 0.9;
  const fuelUnit = volumeUnit;
  const fuelAmount = fuel ? fuel.litres / litresPerUnit(volumeUnit) : null;
  const fuelEfficiency = enoughFuel && (!metrics || metrics.distanceCoverage >= .9) && fuel && fuel.litres > 0 && distance != null && distance > 0
    ? `${fuelEconomy(distance / fuel.litres, consumptionUnit)!.toFixed(1)} ${economyLabel(consumptionUnit)}`
    : null;
  const speedText = (kmh: number | null) => kmh == null ? null : `${Math.round(distanceUnit === 'mi' ? kmh * 0.621371 : kmh)} ${distanceUnit === 'mi' ? 'mph' : 'km/h'}`;
  const fuelText = fuelAmount == null ? null : `${fuelAmount.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 2 })} ${fuelUnit}`;
  const stats = ([
    { icon: Clock, label: t('tripDetail.duration', 'Duration'), value: formatDuration(session.duration_seconds) },
    { icon: Route, label: t('tripDetail.distance', 'Distance'), value: formatDistance(distance, distanceUnit) },
    { icon: Gauge, label: t('tripDetail.avgSpeed', 'Average speed'), value: speedText(avgSpeed) },
    { icon: Gauge, label: t('tripDash.topSpeed', 'Top speed'), value: speedText(analysis.topSpeed) },
    fuelEfficiency
      ? { icon: Fuel, label: t('tripDetail.fuelEconomy', 'Trip fuel economy'), value: fuelEfficiency, hint: fuelText }
      : { icon: Fuel, label: t('tripDash.fuelUsed', 'Fuel used'), value: fuelText, hint: fuel && !enoughFuel ? t('tripDash.partOfTrip', 'Part of the trip') : null },
  ] as (Omit<TripStat, 'value'> & { value: string | null })[]).filter((f): f is TripStat => !!f.value);

  return (
    <AppLayout refreshDisabled={attachmentDraft}>
      <div className="space-y-5">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label={t('tripDetail.back', 'Back')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="text-xl font-bold truncate">{tripTitle(session, t)}</h2>
            <p className="text-sm text-muted-foreground">{formatTripDate(tripDate(session), i18n.resolvedLanguage)}</p>
          </div>
        </div>

        {/* 1. The trip at a glance */}
        <TripStats stats={stats} />
        {(aiSummary || analysisOutdated) && (
          <Card>
            <CardContent className="flex gap-3 p-4">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <div className="space-y-1">
                {aiSummary && <p className="text-sm leading-relaxed">{aiSummary}</p>}
                {analysisOutdated && <p className="text-sm text-muted-foreground">{t('tripDetail.analysisOutdated', 'The summary below is from before the new check.')}</p>}
              </div>
            </CardContent>
          </Card>
        )}

        {/* 2. Dashboards: speed and driving, engine, hybrid system, fuel */}
        <TripDashboards
          analysis={analysis}
          avgSpeed={avgSpeed}
          extraCards={[
            <Card key="fuel" className="h-full"><CardContent className="space-y-2 p-4">
              <h3 className="flex items-center gap-2 font-semibold"><Fuel className="h-4 w-4 text-muted-foreground" aria-hidden="true" />{t('tripDetail.fuelTitle', 'Fuel consumption')}</h3>
              {fuel ? <>
                <p className="text-xl font-semibold tabular-nums">{fuelText}</p>
                <p className="text-xs text-muted-foreground">{t('tripDetail.fuelMeasured', 'Worked out from the fuel your car reported ({{coverage}} of the trip).', { coverage: fuel.coverage == null ? '—' : `${Math.round(fuel.coverage * 100)}%` })}</p>
                {!enoughFuel && <p className="text-xs text-warn">{t('tripDetail.fuelPartial', 'Only part of this trip was recorded, so this is the fuel for that part.')}</p>}
                {fuelEfficiency && <p className="font-medium">{t('tripDetail.fuelEconomy', 'Trip fuel economy')}: {fuelEfficiency}</p>}
              </> : <p className="text-sm text-muted-foreground">{t('tripDetail.fuelUnavailable', "Your car didn't report fuel use on this trip.")}</p>}
              <TripFuelCost key={session.id} session={session} />
            </CardContent></Card>,
          ]}
        />

        {/* 3. Problems in this trip */}
        <div className="space-y-2">
          <h3 className="font-semibold">{t('tripDetail.problemsTitle', 'Problems in this trip')}</h3>
          {problems.length === 0 ? (
            <Card className={completeTripInspection(session) ? 'border-success/40' : 'border-border'}>
              <CardContent className="p-4 flex items-center gap-3">
                <CheckCircle2 className={`w-5 h-5 ${completeTripInspection(session) ? 'text-success' : 'text-muted-foreground'}`} />
                <p className="text-sm">{completeTripInspection(session) ? t('tripDetail.noProblems', 'No warnings found in the recorded readings.') : t('history.incompleteCheck', 'Code reading incomplete')}</p>
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
                      <StatusBadge tone={URGENCY_TONE[urgency]}>
                        {t(`problems.urgency.${urgency}`)}
                      </StatusBadge>
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

        <PhotoUpload key={session.id} sessionId={session.id} onDraftChange={setAttachmentDraft} />
        <ShareReportSection session={session} />

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
                  <RefreshCw className="w-3 h-3 mr-1" /> {t('tripDetail.reevaluate', 'Check again')}
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
