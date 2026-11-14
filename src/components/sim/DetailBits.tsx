import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatLapTime } from '@/lib/sim/analysis';
import { sessionPath } from '@/lib/sim/routes';
import { useSessions, type SessionFilters } from '@/lib/sim/v1-client';
import { Panel, Quiet } from './overview/parts';
import { KindBadge } from './session-bits';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The way back from a detail page to its list. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to={to}>
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> {children}
      </Link>
    </Button>
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
    <Panel
      title={t('modes.detail.latestSessions', 'Latest sessions')}
      testId="latest-sessions"
      action={shown.length > 0 ? <Link to={listTo} className={`text-sm underline ${FOCUS}`}>{t('modes.overview.allSessions', 'All sessions')}</Link> : undefined}
    >
      {query.isPending ? (
        <div className="space-y-2" role="status" aria-label={t('common.loading', 'Loading…')}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : query.isError && shown.length === 0 ? (
        <Quiet testId="latest-sessions-error">{t('modes.detail.sessionsFailed', 'The sessions could not be loaded.')}</Quiet>
      ) : shown.length === 0 ? (
        <Quiet testId="latest-sessions-empty">{t('modes.detail.noSessions', 'No sessions yet.')}</Quiet>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((session) => (
            <li key={session.id} data-testid="latest-session">
              <Link to={sessionPath(session.id)} className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 hover:bg-muted/40 ${FOCUS}`}>
                <div className="min-w-0 space-y-1">
                  <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    {hide === 'track' ? <SimCarIdentity name={session.car.name} /> : <span className="truncate">{session.track.name}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <KindBadge kind={session.kind} />
                    <span className="text-xs text-muted-foreground">
                      {when(Date.parse(session.startedAt))} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}
                    </span>
                  </div>
                </div>
                <span className="flex items-center gap-1">
                  <span className="font-mono text-sm tabular-nums">{session.bestLapMs !== null ? formatLapTime(session.bestLapMs) : '–'}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
