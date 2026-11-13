import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowLeftRight, Award, LineChart, Loader2, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useDeleteLaps } from '@/lib/sim/lap-delete';
import { reconcileSession } from '@/lib/sim/library';
import { carPath, trackPath } from '@/lib/sim/routes';
import { bestLapOf, bestSectors, consistency, inDrivingOrder, sectorTone, theoreticalBest, type SectorTone } from '@/lib/sim/session-stats';
import { V1Error, isSignedOut, usePbs, useSession, type V1Lap } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { ShareButton } from '@/components/social/ShareDialog';
import { SessionLapChart } from './SessionLapChart';
import { GameBadge, KindBadge } from './session-bits';
import { useConditions, useOrigin } from './use-session-text';
import { ListSkeleton, QueryGate } from './SimStates';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

const TONE_CLASS: Record<SectorTone, string> = {
  purple: 'font-semibold text-purple-500',
  green: 'font-semibold text-green-500',
  yellow: 'text-yellow-500',
  none: 'text-muted-foreground',
};

/** A sector time: `32.145` seconds. */
const sector = (ms: number) => (ms / 1000).toFixed(3);

type Pending = { kind: 'session' } | { kind: 'lap'; lap: V1Lap } | null;

/**
 * One session: its laps against each other. A chart of the lap times, a table with the gap to the best lap and the sector times
 * coloured the usual way, the theoretical best lap and how steady the driving was. Everything comes from the lap list of the
 * session (no lap file is read here); "Analyze" and the comparisons open the Compare screen with the laps' ids.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const when = useWhen();
  const conditions = useConditions();
  const origin = useOrigin();
  const userId = useAuth().user?.id ?? null;
  const query = useSession(id);
  const session = query.data?.session ?? null;
  const laps = useMemo(() => inDrivingOrder(query.data?.laps ?? []), [query.data?.laps]);
  const pbQuery = usePbs({ game: session?.game, track: session?.track.id, car: session?.car.id }, { enabled: !!session });
  const pb = pbQuery.items.find((entry) => entry.track.id === session?.track.id && entry.car.id === session?.car.id) ?? null;
  const remove = useDeleteLaps();
  const [pending, setPending] = useState<Pending>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // A lap cached on this device that the server no longer lists in this session was deleted elsewhere: it is dropped.
  const lapIds = useMemo(() => laps.map((lap) => lap.id).join('\n'), [laps]);
  useEffect(() => {
    if (userId && session) void reconcileSession(userId, session.id, lapIds ? lapIds.split('\n') : []);
  }, [userId, session, lapIds]);

  const best = useMemo(() => bestLapOf(laps), [laps]);
  const sectors = useMemo(() => bestSectors(laps), [laps]);
  const theoretical = theoreticalBest(sectors);
  const steady = useMemo(() => consistency(laps), [laps]);

  const confirm = async () => {
    const what = pending;
    setPending(null);
    if (!what) return;
    setProblem(null);
    const ids = what.kind === 'session' ? laps.map((lap) => lap.id) : [what.lap.id];
    const result = await remove.mutateAsync(ids);
    if (result.failed.length > 0) {
      setProblem(
        isSignedOut(result.failed[0].error)
          ? t('modes.states.signedOut', 'You are signed out. Sign in again to see your laps.')
          : t('modes.session.deleteFailed', '{{count}} laps could not be deleted. Try again.', { count: result.failed.length }),
      );
    } else if (what.kind === 'session' || result.deleted.length >= laps.length) navigate('/virtual/sessions', { replace: true });
  };

  const notFound = query.error instanceof V1Error && query.error.code === 'session_not_found';

  return (
    <div className="space-y-4" data-testid="session-page">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/virtual/sessions">
          <ArrowLeft className="mr-1 h-4 w-4" /> {t('modes.session.back', 'All sessions')}
        </Link>
      </Button>

      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="session-not-found">
          {t('modes.session.notFound', 'This session is not in your account any more. It may have been deleted.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!session} skeleton={<ListSkeleton rows={3} />}>
          {session && (
            <>
              <Card className="bg-card border-border" data-testid="session-header">
                <CardContent className="space-y-2 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-bold">
                        <Link to={trackPath(session.track.id)} className="hover:underline" data-testid="session-track-link">{session.track.name}</Link>
                      </h2>
                      <Link to={carPath(session.car.id)} className="inline-flex min-w-0 hover:underline" data-testid="session-car-link">
                        <SimCarIdentity name={session.car.name} className="text-sm text-muted-foreground" />
                      </Link>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <KindBadge kind={session.kind} />
                      <GameBadge game={session.game} />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {when(Date.parse(session.startedAt))}
                    {conditions(session) ? ` · ${conditions(session)}` : ''} · {origin(session.origin)}
                  </p>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <p className="text-sm">
                      {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: laps.length })}
                      {best && (
                        <>
                          {' · '}
                          <span className="text-xs text-muted-foreground">{t('modes.sessions.bestLabel', 'Best valid lap')}: </span>
                          <span className="font-mono tabular-nums" data-testid="session-best">{formatLapTime(best.timeMs)}</span>
                        </>
                      )}
                    </p>
                    <span className="flex flex-wrap items-center gap-2">
                      <ShareButton target={{ sessionId: session.id }} label={t('social.share.sessionButton', 'Share session')} />
                      <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'session' })} disabled={remove.isPending}>
                        <Trash2 className="mr-2 h-4 w-4" /> {t('modes.session.delete', 'Delete session')}
                      </Button>
                    </span>
                  </div>
                </CardContent>
              </Card>

              {problem && (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="session-problem">
                  {problem}
                </p>
              )}

              {laps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('modes.session.noLaps', 'This session has no laps.')}</p>
              ) : (
                <>
                  <Card className="bg-card border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold">{t('modes.session.chartTitle', 'Lap times')}</CardTitle>
                    </CardHeader>
                    <CardContent className="pb-3">
                      <SessionLapChart laps={laps} bestId={best?.id ?? null} />
                    </CardContent>
                  </Card>

                  <Card className="bg-card border-border" data-testid="consistency">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold">{t('modes.session.consistency', 'Consistency')}</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3 pb-4 sm:grid-cols-3">
                      <div>
                        <p className="text-xs text-muted-foreground">{t('modes.session.spread', 'Spread of the valid laps')}</p>
                        <p className="font-mono text-lg tabular-nums" data-testid="spread">{steady.spreadS !== null ? `±${steady.spreadS.toFixed(3)} s` : '–'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('modes.session.clean', 'Clean laps')}</p>
                        <p className="font-mono text-lg tabular-nums" data-testid="clean">{steady.cleanPercent !== null ? `${Math.round(steady.cleanPercent)} %` : '–'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">{t('modes.session.bestThree', 'Average of the best 3')}</p>
                        <p className="font-mono text-lg tabular-nums" data-testid="best-three">{steady.bestThreeMs !== null ? formatLapTime(steady.bestThreeMs) : '–'}</p>
                      </div>
                      <p className="text-xs text-muted-foreground sm:col-span-3">
                        {t('modes.session.consistencyHint', 'Laps through the pits (out and in laps) are left out of the spread and of the clean-lap share; the spread is the standard deviation of the valid laps.')}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="bg-card border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold">{t('modes.session.lapsTitle', 'Laps')}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3 pb-4">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs sm:text-sm" data-testid="session-laps">
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground">
                              <th scope="col" className="sticky left-0 z-10 bg-card pr-2 font-normal">{t('modes.compare.lap', 'Lap')}</th>
                              <th scope="col" className="pr-3 text-right font-normal">{t('modes.sessions.time', 'Time')}</th>
                              <th scope="col" className="whitespace-nowrap pr-3 text-right font-normal">{t('modes.sessions.gap', 'Gap to best')}</th>
                              {sectors.map((_, i) => (
                                <th key={i} scope="col" className="pr-3 text-right font-normal">{`S${i + 1}`}</th>
                              ))}
                              <th scope="col" className="pr-3 font-normal">{t('modes.sessions.status', 'Status')}</th>
                              <th scope="col" className="bg-card font-normal sm:sticky sm:right-0 sm:z-10"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {laps.map((lap) => {
                              const isBest = best?.id === lap.id;
                              const isPb = pb?.lapId === lap.id;
                              return (
                                <tr key={lap.id} className="border-t border-border" data-testid="session-lap" data-lap-id={lap.id}>
                                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card py-1.5 pr-2">{lap.lapNumber}</td>
                                  <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{formatLapTime(lap.timeMs)}</td>
                                  <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground" data-testid="lap-gap">
                                    {best && !isBest && lap.valid ? formatGap((lap.timeMs - best.timeMs) / 1000) : '–'}
                                  </td>
                                  {sectors.map((_, i) => {
                                    const ms = lap.sectorsMs?.[i];
                                    const tone = sectorTone(lap, i, sectors, pb);
                                    return (
                                      <td
                                        key={i}
                                        className={cn('whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums', TONE_CLASS[tone])}
                                        data-testid="lap-sector"
                                        data-tone={tone}
                                        title={tone === 'purple' ? t('modes.session.tonePurple', 'Best of the session in this sector') : tone === 'green' ? t('modes.session.toneGreen', 'Your personal best lap') : tone === 'yellow' ? t('modes.session.toneYellow', 'Slower than the session best') : undefined}
                                      >
                                        {typeof ms === 'number' && ms > 0 ? sector(ms) : '–'}
                                      </td>
                                    );
                                  })}
                                  <td className="py-1.5 pr-3">
                                    <span className="flex flex-wrap gap-1" data-testid="lap-tags">
                                      {isBest && <Badge>{t('modes.sessions.isBest', 'Best lap')}</Badge>}
                                      {isPb && <Badge variant="secondary" className="gap-1"><Award className="h-3 w-3" />{t('modes.session.pb', 'Personal best')}</Badge>}
                                      {lap.outLap && <Badge variant="outline">{t('modes.session.outLap', 'Out lap')}</Badge>}
                                      {lap.inLap && <Badge variant="outline">{t('modes.session.inLap', 'In lap')}</Badge>}
                                      {!lap.valid && <Badge variant="destructive">{t('modes.compare.notValid', 'not valid')}</Badge>}
                                    </span>
                                  </td>
                                  <td className="whitespace-nowrap bg-card py-1.5 pl-2 text-right sm:sticky sm:right-0 sm:z-10">
                                    <span className="inline-flex items-center gap-0.5 sm:gap-1">
                                      <Button asChild size="sm" variant="outline" className="h-8 px-2 xl:px-4">
                                        <Link to={compareUrl(lap.id)} aria-label={`${t('modes.session.analyze', 'Analyze')} ${lap.lapNumber}`} title={t('modes.session.analyze', 'Analyze')}>
                                          <LineChart className="h-4 w-4 xl:mr-2" />
                                          <span className="hidden xl:inline">{t('modes.session.analyze', 'Analyze')}</span>
                                        </Link>
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                        disabled={!pb || isPb}
                                        aria-label={t('modes.session.vsMyBest', 'Compare with my best')}
                                        title={t('modes.session.vsMyBest', 'Compare with my best')}
                                        onClick={() => pb && navigate(compareUrl(lap.id, pb.lapId))}
                                      >
                                        <Award className="h-4 w-4" />
                                      </Button>
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                        disabled={!best || isBest}
                                        aria-label={t('modes.session.vsSessionBest', 'Compare with the session best')}
                                        title={t('modes.session.vsSessionBest', 'Compare with the session best')}
                                        onClick={() => best && navigate(compareUrl(lap.id, best.id))}
                                      >
                                        <ArrowLeftRight className="h-4 w-4" />
                                      </Button>
                                      <ShareButton compact target={{ lapId: lap.id }} label={`${t('social.share.lapButton', 'Share lap')} ${lap.lapNumber}`} title={t('social.share.titleLap', 'Share this lap')} />
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8"
                                        disabled={remove.isPending}
                                        aria-label={`${t('modes.session.deleteLap', 'Delete lap')} ${lap.lapNumber}`}
                                        title={t('modes.session.deleteLap', 'Delete lap')}
                                        onClick={() => setPending({ kind: 'lap', lap })}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          {sectors.length > 0 && (
                            <tfoot>
                              <tr className="border-t border-border text-muted-foreground" data-testid="best-sectors">
                                <td className="sticky left-0 z-10 bg-card" />
                                <th scope="row" colSpan={2} className="whitespace-nowrap py-1.5 pr-3 text-right font-normal">{t('modes.session.bestSectors', 'Best sectors')}</th>
                                {sectors.map((ms, i) => (
                                  <td key={i} className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums text-purple-500">{ms !== null ? sector(ms) : '–'}</td>
                                ))}
                                <td />
                                <td className="bg-card sm:sticky sm:right-0 sm:z-10" />
                              </tr>
                            </tfoot>
                          )}
                        </table>
                      </div>

                      {sectors.length > 0 && (
                        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="sector-legend">
                          <li><span className="font-semibold text-purple-500">{t('modes.session.legendPurple', 'Purple')}</span>: {t('modes.session.tonePurple', 'Best of the session in this sector')}</li>
                          <li><span className="font-semibold text-green-500">{t('modes.session.legendGreen', 'Green')}</span>: {t('modes.session.toneGreen', 'Your personal best lap')}</li>
                          <li><span className="text-yellow-500">{t('modes.session.legendYellow', 'Yellow')}</span>: {t('modes.session.toneYellow', 'Slower than the session best')}</li>
                        </ul>
                      )}

                      {theoretical !== null && (
                        <p className="text-sm" data-testid="theoretical-best">
                          <span className="text-muted-foreground">{t('modes.session.theoretical', 'Theoretical best lap (the best sectors put together)')}: </span>
                          <span className="font-mono tabular-nums">{formatLapTime(theoretical)}</span>
                          {best && theoretical < best.timeMs && (
                            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">({formatGap((theoretical - best.timeMs) / 1000)} s)</span>
                          )}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                </>
              )}
            </>
          )}
        </QueryGate>
      )}

      {remove.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('modes.session.deleting', 'Deleting…')}
        </p>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={pending?.kind === 'lap' ? t('modes.session.confirmLapTitle', 'Delete this lap?') : t('modes.session.confirmTitle', 'Delete this session?')}
        description={
          pending?.kind === 'lap'
            ? t('modes.session.confirmLapBody', 'Lap {{lap}} is deleted from your account, with its file. This cannot be undone.', { lap: pending.lap.lapNumber })
            : t('modes.session.confirmBody', 'The {{count}} laps of this session are deleted from your account, with their files. This cannot be undone.', { count: laps.length })
        }
        confirmLabel={t('modes.session.confirmDelete', 'Delete')}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}
