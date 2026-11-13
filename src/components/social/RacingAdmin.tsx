import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flag, Loader2, RefreshCw, SearchCheck, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { LoadMore, QueryGate } from '@/components/sim/SimStates';
import { useWhen } from '@/components/sim/use-when';
import { useAdminStatus } from '@/hooks/use-admin-status';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { V1Error } from '@/lib/sim/v1-client';
import {
  cleanName, recheckLaps, useAdminLap, useAdminReports, useDecideReport, type AdminReport, type AdminReportFilter, type ReportReason, type RecheckResult,
} from '@/lib/sim/social-client';
import { ErrorLine, PlainSelect } from './social-bits';
import { atHandle } from './social-utils';
import { useErrorText } from './use-error-text';

/** "Name " for a name that is safe to show, else nothing (the handle follows it). */
const nameOf = (name: string | null | undefined) => (cleanName(name) ? `${cleanName(name)} ` : '');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useReasonText(): (reason: ReportReason) => string {
  const { t } = useTranslation();
  return (reason) =>
    ({
      cheating: t('social.report.reasons.cheating', 'Cheating or an impossible time'),
      offensive_name: t('social.report.reasons.offensive_name', 'Offensive name'),
      impersonation: t('social.report.reasons.impersonation', 'Pretending to be someone else'),
      spam: t('social.report.reasons.spam', 'Spam'),
      other: t('social.report.reasons.other', 'Something else'),
    })[reason];
}

/** The lap a moderator is looking at: its numbers, the plausibility verdict with every failed check, its owner and its reports. */
export function LapInspector({ lapId, onClose }: { lapId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  const games = useGames();
  const reasonText = useReasonText();
  const query = useAdminLap(lapId);
  const data = query.data;
  return (
    <Dialog open={lapId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl" data-testid="lap-inspector">
        <DialogHeader>
          <DialogTitle>{t('social.admin.inspectTitle', 'Lap inspector')}</DialogTitle>
          <DialogDescription>{t('social.admin.inspectBody', 'What the server knows about this lap and the checks it ran. Handles and names only, never an e-mail.')}</DialogDescription>
        </DialogHeader>
        {query.error instanceof V1Error && query.error.status === 404 ? (
          <p className="text-sm text-muted-foreground" data-testid="inspect-not-found">{t('social.admin.lapNotFound', 'There is no lap with this id.')}</p>
        ) : (
        <QueryGate query={query} empty={false}>
          {data && (
            <div className="space-y-3 text-sm">
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                <p><span className="text-muted-foreground">{t('social.admin.track', 'Track')}: </span>{data.lap.track?.name ?? '–'}</p>
                <p><span className="text-muted-foreground">{t('social.admin.car', 'Car')}: </span>{data.lap.car?.name ?? '–'}</p>
                <p><span className="text-muted-foreground">{t('social.admin.game', 'Game')}: </span>{games.name(data.lap.game)}</p>
                <p><span className="text-muted-foreground">{t('modes.compare.lap', 'Lap')}: </span>{data.lap.lapNumber}</p>
                <p><span className="text-muted-foreground">{t('modes.sessions.time', 'Time')}: </span><span className="font-mono tabular-nums" data-testid="inspect-time">{formatLapTime(data.lap.timeMs)}</span></p>
                <p><span className="text-muted-foreground">{t('social.admin.driven', 'Driven')}: </span>{when(Date.parse(data.lap.startedAt))}</p>
                <p><span className="text-muted-foreground">{t('social.admin.samples', 'Samples')}: </span>{data.lap.sampleCount}</p>
                <p><span className="text-muted-foreground">{t('social.admin.topSpeed', 'Top speed')}: </span>{data.lap.topSpeedKmh !== null ? `${Math.round(data.lap.topSpeedKmh)} km/h` : '–'}</p>
              </div>
              <div className="flex flex-wrap gap-2" data-testid="inspect-flags">
                <Badge variant={data.lap.valid ? 'secondary' : 'destructive'}>{data.lap.valid ? t('modes.compare.valid', 'valid') : t('modes.compare.notValid', 'not valid')}</Badge>
                <Badge variant={data.lap.plausible === false ? 'destructive' : 'secondary'} data-testid="inspect-plausible">
                  {data.lap.plausible === null ? t('social.admin.notChecked', 'not checked yet') : data.lap.plausible ? t('social.admin.plausible', 'plausible') : t('social.admin.implausible', 'implausible')}
                </Badge>
                {data.lap.hidden && <Badge variant="destructive">{t('social.admin.hidden', 'hidden')}</Badge>}
                <Badge variant="outline">{data.onLeaderboard ? t('social.admin.onBoard', 'on a leaderboard') : t('social.admin.offBoard', 'not on a leaderboard')}</Badge>
              </div>
              {data.owner && (
                <p data-testid="inspect-owner">
                  <span className="text-muted-foreground">{t('social.admin.owner', 'Driver')}: </span>
                  {nameOf(data.owner.displayName)}{atHandle(data.owner.handle)}
                  <span className="text-muted-foreground"> · {data.owner.visibility}{data.owner.hidden ? ` · ${t('social.admin.hidden', 'hidden')}` : ''}</span>
                </p>
              )}
              {data.lap.plausibility && data.lap.plausibility.failed.length > 0 && (
                <div className="space-y-1" data-testid="inspect-failed">
                  <p className="font-medium">{t('social.admin.failed', 'Checks that failed')}</p>
                  <ul className="space-y-1">
                    {data.lap.plausibility.failed.map((check) => (
                      <li key={check.check} className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs" data-testid="inspect-check">
                        <span className="font-mono font-semibold">{check.check}</span>
                        {check.detail && (
                          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                            {Object.entries(check.detail).map(([key, value]) => (
                              <div key={key} className="contents"><dt className="text-muted-foreground">{key}</dt><dd className="font-mono">{String(value)}</dd></div>
                            ))}
                          </dl>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {data.reports.length > 0 && (
                <div className="space-y-1" data-testid="inspect-reports">
                  <p className="font-medium">{t('social.admin.reportsOnLap', 'Reports on this lap')}</p>
                  <ul className="text-xs text-muted-foreground">
                    {data.reports.map((report) => <li key={report.id}>{reasonText(report.reason)} · {report.status}</li>)}
                  </ul>
                </div>
              )}
            </div>
          )}
        </QueryGate>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReportCard({ report, onInspect }: { report: AdminReport; onInspect: (lapId: string) => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  const errorText = useErrorText();
  const reasonText = useReasonText();
  const decide = useDecideReport();
  const target = report.target;
  const open = report.status === 'open';
  const hidden = !!target && 'hidden' in target && target.hidden;
  const run = (action: 'dismiss' | 'action' | 'unhide', hideTarget?: boolean) => decide.mutate({ id: report.id, action, hideTarget });
  return (
    <li className="space-y-2 p-3" data-testid="admin-report" data-report-id={report.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={open ? 'default' : 'secondary'}>{report.status}</Badge>
        <Badge variant="outline">{report.kind === 'lap' ? t('social.admin.kindLap', 'Lap') : t('social.admin.kindProfile', 'Profile')}</Badge>
        <span className="text-sm font-medium">{reasonText(report.reason)}</span>
        <span className="text-xs text-muted-foreground">{when(Date.parse(report.createdAt))}</span>
        {hidden && <Badge variant="destructive">{t('social.admin.hidden', 'hidden')}</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        {t('social.admin.reportedBy', 'Reported by {{who}}', { who: `${nameOf(report.reporter.displayName)}${atHandle(report.reporter.handle)}` })}
      </p>
      {report.details && <p className="rounded bg-muted/40 p-2 text-sm" data-testid="report-details-text">{report.details}</p>}
      {target ? (
        'lapId' in target ? (
          <p className="text-sm" data-testid="report-target">
            {target.track?.name ?? '–'} · {target.car?.name ?? '–'} · <span className="font-mono tabular-nums">{formatLapTime(target.timeMs)}</span> ·{' '}
            {atHandle(target.owner.handle)}
            {target.plausible === false && <Badge variant="destructive" className="ml-2">{t('social.admin.implausible', 'implausible')}</Badge>}
          </p>
        ) : (
          <p className="text-sm" data-testid="report-target">
            {nameOf(target.displayName)}{atHandle(target.handle)} <span className="text-xs text-muted-foreground">({target.visibility})</span>
          </p>
        )
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="report-target">{t('social.admin.targetGone', 'The reported item is gone.')}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {target && 'lapId' in target && (
          <Button size="sm" variant="outline" onClick={() => onInspect(target.lapId)} data-testid="report-inspect"><SearchCheck className="mr-2 h-4 w-4" /> {t('social.admin.inspect', 'Inspect lap')}</Button>
        )}
        {open && (
          <>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => run('dismiss')} data-testid="report-dismiss">{t('social.admin.dismiss', 'Dismiss')}</Button>
            <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => run('action')} data-testid="report-action">{t('social.admin.action', 'Mark as actioned')}</Button>
            {target && <Button size="sm" variant="destructive" disabled={decide.isPending} onClick={() => run('action', true)} data-testid="report-hide">{t('social.admin.hide', 'Action and hide')}</Button>}
          </>
        )}
        {hidden && (
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => run('unhide')} data-testid="report-unhide">{t('social.admin.unhide', 'Show again')}</Button>
        )}
      </div>
      {decide.isError && <ErrorLine>{errorText(decide.error)}</ErrorLine>}
    </li>
  );
}

/** The "Recheck laps" button: reads the files of laps with no verdict, 50 at a time, until none remain, with progress. */
function RecheckPanel() {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; remaining: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stop = useRef(false);

  const run = async () => {
    stop.current = false;
    setRunning(true);
    setFinished(false);
    setError(null);
    let done = 0;
    let total = 0;
    try {
      for (;;) {
        const result: RecheckResult = await recheckLaps(50);
        done += result.checked;
        total = Math.max(total, done + result.remaining);
        setProgress({ done, remaining: result.remaining, total });
        if (result.remaining === 0) {
          setFinished(true);
          break;
        }
        // Nothing was read but laps remain: asking again would not help.
        if (result.checked === 0 || stop.current) break;
      }
    } catch (failure) {
      setError(failure);
    } finally {
      setRunning(false);
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <Card className="bg-card border-border" data-testid="admin-recheck">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden /> {t('social.admin.recheckTitle', 'Recheck laps')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('social.admin.recheckBody', 'Laps that arrived before the checks existed rank nowhere until their files are read. This reads them 50 at a time until none are left.')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void run()} disabled={running} data-testid="recheck-run">
            {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('social.admin.recheck', 'Recheck laps')}
          </Button>
          {running && <Button size="sm" variant="outline" onClick={() => { stop.current = true; }} data-testid="recheck-stop">{t('social.admin.stop', 'Stop after this batch')}</Button>}
        </div>
        {progress && (
          <div className="space-y-1" role="status" data-testid="recheck-progress">
            <Progress value={finished ? 100 : percent} aria-label={t('social.admin.recheckTitle', 'Recheck laps')} />
            <p className="text-xs text-muted-foreground">
              {finished
                ? t('social.admin.recheckDone', 'Done: {{done}} laps checked, none left.', { done: progress.done })
                : t('social.admin.recheckProgress', '{{done}} checked, {{remaining}} left', { done: progress.done, remaining: progress.remaining })}
            </p>
          </div>
        )}
        {error !== null && <ErrorLine testId="recheck-error">{errorText(error)}</ErrorLine>}
      </CardContent>
    </Card>
  );
}

/**
 * Admin > Racing games: the reports to decide on (dismiss, mark as actioned, or action and hide the profile or lap, and show it again),
 * the lap inspector with the plausibility details, and "Recheck laps". Only an admin ever sees it: the check is the app's own admin check,
 * and the server refuses everybody else.
 */
export function RacingAdmin() {
  const { isAdmin, loading } = useAdminStatus();
  if (loading || !isAdmin) return null;
  return <RacingAdminBody />;
}

function RacingAdminBody() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<AdminReportFilter>('open');
  const [inspect, setInspect] = useState<string | null>(null);
  const [lapId, setLapId] = useState('');
  const reports = useAdminReports(status);
  return (
    <section className="space-y-4" data-testid="racing-admin" aria-labelledby="racing-admin-title">
      <div className="flex items-center gap-2">
        <Flag className="h-5 w-5 text-primary" aria-hidden />
        <h3 id="racing-admin-title" className="text-lg font-bold">{t('social.admin.title', 'Racing games')}</h3>
      </div>

      <Card className="bg-card border-border" data-testid="admin-reports">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="h-4 w-4" aria-hidden /> {t('social.admin.reports', 'Reports')}</CardTitle>
            <div className="w-40">
              <PlainSelect
                label={t('social.admin.show', 'Show')}
                value={status}
                onChange={(value) => setStatus(value as AdminReportFilter)}
                options={[
                  { value: 'open', label: t('social.admin.open', 'Open') },
                  { value: 'dismissed', label: t('social.admin.dismissed', 'Dismissed') },
                  { value: 'actioned', label: t('social.admin.actioned', 'Actioned') },
                  { value: 'all', label: t('social.admin.all', 'All') },
                ]}
                testId="admin-status"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <QueryGate
            query={reports}
            empty={reports.items.length === 0}
            emptyNode={<p className="p-4 text-sm text-muted-foreground" data-testid="admin-no-reports">{t('social.admin.noReports', 'No reports here.')}</p>}
          >
            <ul className="divide-y divide-border" data-testid="admin-report-list">
              {reports.items.map((report) => <ReportCard key={report.id} report={report} onInspect={setInspect} />)}
            </ul>
            <LoadMore hasNextPage={!!reports.hasNextPage} isFetchingNextPage={reports.isFetchingNextPage} onClick={() => void reports.fetchNextPage()} />
          </QueryGate>
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold"><SearchCheck className="h-4 w-4" aria-hidden /> {t('social.admin.inspectTitle', 'Lap inspector')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (UUID.test(lapId.trim())) setInspect(lapId.trim());
            }}
          >
            <label className="min-w-0 flex-1 basis-64 space-y-1 text-xs text-muted-foreground">
              {t('social.admin.lapId', 'Lap id')}
              <Input value={lapId} onChange={(event) => setLapId(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" className="font-mono text-xs" spellCheck={false} data-testid="inspect-id" />
            </label>
            <Button type="submit" size="sm" disabled={!UUID.test(lapId.trim())} data-testid="inspect-open">{t('social.admin.inspect', 'Inspect lap')}</Button>
          </form>
        </CardContent>
      </Card>

      <RecheckPanel />

      <LapInspector lapId={inspect} onClose={() => setInspect(null)} />
    </section>
  );
}
