import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { compareUrl } from '@/lib/sim/compare-url';
import { useDeleteLaps } from '@/lib/sim/lap-delete';
import { reconcileSession } from '@/lib/sim/library';
import { sessionKpis } from '@/lib/sim/session-detail';
import { bestLapOf, consistency, inDrivingOrder } from '@/lib/sim/session-stats';
import { V1Error, isSignedOut, usePbs, useSession, type V1Lap } from '@/lib/sim/v1-client';
import { SessionLapChart } from './SessionLapChart';
import { SessionHero } from './session/Hero';
import { SessionKpiTiles } from './session/Kpis';
import { LapsTable } from './session/LapsTable';
import { SectorHeatTable } from './session/SectorHeat';
import { StoodOutCard } from './session/Stood';
import { Panel } from './overview/parts';
import { ListSkeleton, QueryGate } from './SimStates';

type Pending = { kind: 'session' } | { kind: 'lap'; lap: V1Lap } | null;

/** Stands in for the session dashboard while the first read runs: the hero, the tiles and the chart, in the places they will be. */
function SessionSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="space-y-4" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="session-skeleton">
      <Skeleton className="h-36 w-full rounded-lg" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
      </div>
      <Skeleton className="h-72 w-full rounded-lg" />
    </div>
  );
}

/**
 * One session as a dashboard: a hero with the track, car, game, kind, date and conditions (and the share and delete buttons), tiles (best lap against the
 * personal best, average, spread, valid share, theoretical best, top speed, fuel), a chart of the lap times (click a bar to open that lap), the sectors as a heat
 * map, the laps in a sortable table with their actions, and what stood out. Everything comes from the lap list of the session (no lap file is read here); the
 * analysis and the comparisons open the Compare screen with the laps' ids.
 */
export function SessionPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const kpis = useMemo(() => sessionKpis(laps), [laps]);
  const bestThree = useMemo(() => consistency(laps).bestThreeMs, [laps]);

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

  // The share buttons' sentences are written here, with the rest of the social sentences that the session page carries.
  const share = {
    session: t('social.share.sessionButton', 'Share session'),
    lap: t('social.share.lapButton', 'Share lap'),
    lapTitle: t('social.share.titleLap', 'Share this lap'),
  };

  const notFound = query.error instanceof V1Error && query.error.code === 'session_not_found';

  return (
    <div className="space-y-4" data-testid="session-page">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/virtual/sessions">
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> {t('modes.session.back', 'All sessions')}
        </Link>
      </Button>

      {notFound ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="session-not-found">
          {t('modes.session.notFound', 'This session is not in your account any more. It may have been deleted.')}
        </p>
      ) : (
        <QueryGate query={query} empty={!session} skeleton={<SessionSkeleton />}>
          {session && (
            <>
              <SessionHero session={session} lapCount={laps.length} shareLabel={share.session} onDelete={() => setPending({ kind: 'session' })} deleting={remove.isPending} />

              {problem && (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="session-problem">
                  {problem}
                </p>
              )}

              {laps.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('modes.session.noLaps', 'This session has no laps.')}</p>
              ) : (
                <>
                  <SessionKpiTiles kpis={kpis} pb={pb} bestThreeMs={bestThree} />

                  <div className="grid gap-4 lg:grid-cols-12">
                    <div className="min-w-0 lg:col-span-8">
                      <Panel title={t('modes.session.chartTitle', 'Lap times')} testId="lap-chart-panel" className="h-full">
                        <SessionLapChart laps={laps} bestId={best?.id ?? null} onOpenLap={(lapId) => navigate(compareUrl(lapId))} />
                      </Panel>
                    </div>
                    <div className="min-w-0 lg:col-span-4">
                      <StoodOutCard sessionId={session.id} version={`${session.lapCount}:${session.bestLapMs ?? ''}`} kpis={kpis} />
                    </div>
                  </div>

                  <SectorHeatTable laps={laps} pb={pb} bestId={best?.id ?? null} />

                  <LapsTable laps={laps} best={best} pb={pb} shareLabel={share.lap} shareTitle={share.lapTitle} deleting={remove.isPending} onDeleteLap={(lap) => setPending({ kind: 'lap', lap })} />
                </>
              )}
            </>
          )}
        </QueryGate>
      )}

      {remove.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('modes.session.deleting', 'Deleting…')}
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
