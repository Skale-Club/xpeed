import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLapTime } from '@/lib/sim/analysis';
import { sessionPath } from '@/lib/sim/routes';
import { useSessions, type SessionFilters } from '@/lib/sim/v1-client';
import { GameBadge, KindBadge } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

/** The way back from a detail page to its list. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to={to}>
        <ArrowLeft className="mr-1 h-4 w-4" /> {children}
      </Link>
    </Button>
  );
}

/** One number of a header: a small label over the value. */
export function Stat({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate font-mono text-base tabular-nums sm:text-lg" data-testid={testId}>{children}</p>
    </div>
  );
}

/**
 * The latest sessions that match a filter (a track or a car), newest first, five of them, each opening its session page; a link
 * goes on to the whole filtered list. No lap file is read.
 */
export function LatestSessions({ filters, listTo, hide }: { filters: SessionFilters; listTo: string; hide: 'track' | 'car' }) {
  const { t } = useTranslation();
  const when = useWhen();
  const query = useSessions(filters);
  const shown = query.items.slice(0, 5);
  return (
    <Card className="bg-card border-border" data-testid="latest-sessions">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.detail.latestSessions', 'Latest sessions')}</CardTitle>
        {shown.length > 0 && <Link to={listTo} className="text-sm underline">{t('modes.overview.allSessions', 'All sessions')}</Link>}
      </CardHeader>
      <CardContent className="pb-3">
        {query.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')}>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : query.isError && shown.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="latest-sessions-error">{t('modes.detail.sessionsFailed', 'The sessions could not be loaded.')}</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="latest-sessions-empty">{t('modes.detail.noSessions', 'No sessions yet.')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((session) => (
              <li key={session.id} data-testid="latest-session">
                <Link to={sessionPath(session.id)} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                      {hide === 'track' ? <SimCarIdentity name={session.car.name} /> : <span className="truncate">{session.track.name}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <KindBadge kind={session.kind} />
                      <GameBadge game={session.game} />
                      <span className="text-xs text-muted-foreground">
                        {when(Date.parse(session.startedAt))} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}
                      </span>
                    </div>
                  </div>
                  <span className="flex items-center gap-1">
                    {session.bestLapMs !== null && <span className="font-mono text-sm tabular-nums">{formatLapTime(session.bestLapMs)}</span>}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
