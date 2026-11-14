import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Award, ChevronRight } from 'lucide-react';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { sessionPath } from '@/lib/sim/routes';
import type { V1Overview } from '@/lib/sim/v1-client';
import { SimCarIdentity } from '../SimCarIdentity';
import { GameBadge, KindBadge } from '../session-bits';
import { useWhen } from '../use-when';
import { Panel, Quiet } from './parts';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The latest sessions as a compact table: when, game, track, car, laps, the best valid lap and the kind. The track opens the session. */
export function SessionsPanel({ sessions }: { sessions: V1Overview['latestSessions'] }) {
  const { t } = useTranslation();
  const when = useWhen();
  const day = useWhen('date');
  return (
    <Panel
      title={t('modes.overview.recent', 'Latest sessions')}
      testId="overview-sessions"
      action={<Link to="/virtual/sessions" className={`text-sm underline ${FOCUS}`} data-testid="overview-all-sessions">{t('modes.overview.allSessions', 'All sessions')}</Link>}
    >
      {sessions.length === 0 ? (
        <Quiet>{t('modes.overview.dash.noSessions', 'No sessions yet.')}</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('modes.overview.dash.colWhen', 'When')}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('modes.overview.dash.colTrackCar', 'Track and car')}</th>
                <th scope="col" className="hidden py-1.5 pr-3 text-right font-medium sm:table-cell">{t('modes.overview.dash.colLaps', 'Laps')}</th>
                <th scope="col" className="py-1.5 text-right font-medium">{t('modes.cars.bestLap', 'Best valid lap')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.slice(0, 5).map((session) => (
                <tr key={session.id} data-testid="overview-session" className="hover:bg-muted/40">
                  <td className="py-2 pr-3 align-top">
                    <p className="text-xs text-muted-foreground"><span className="sm:hidden">{day(Date.parse(session.startedAt))}</span><span className="hidden sm:inline">{when(Date.parse(session.startedAt))}</span></p>
                    <div className="mt-1"><KindBadge kind={session.kind} /></div>
                  </td>
                  <td className="max-w-[8.5rem] py-2 pr-3 align-top sm:max-w-[18rem]">
                    <Link to={sessionPath(session.id)} className={`block truncate font-medium ${FOCUS}`} data-testid="overview-session-link">{session.track.name}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <SimCarIdentity name={session.car.name} className="text-xs text-muted-foreground" />
                      <GameBadge game={session.game} />
                    </div>
                  </td>
                  <td className="hidden py-2 pr-3 text-right align-top tabular-nums sm:table-cell" data-testid="overview-session-laps">{session.lapCount}</td>
                  <td className="whitespace-nowrap py-2 text-right align-top">
                    <span className="font-mono tabular-nums">{session.bestLapMs !== null ? formatLapTime(session.bestLapMs) : '–'}</span>
                    <span className="mt-1 block text-xs text-muted-foreground sm:hidden">{t('modes.overview.dash.lapsN', '{{count}} laps', { count: session.lapCount })}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/** The five personal bests set most recently, as a compact list; each opens the lap's analysis. */
export function BestsPanel({ bests }: { bests: V1Overview['latestPersonalBests'] }) {
  const { t } = useTranslation();
  const games = useGames();
  const day = useWhen('date');
  return (
    <Panel title={t('modes.overview.bestLaps', 'Recent personal bests')} testId="overview-best">
      {bests.length === 0 ? (
        <Quiet>{t('modes.overview.noValid', 'No valid lap yet.')}</Quiet>
      ) : (
        <ul className="divide-y divide-border">
          {bests.slice(0, 5).map((pb) => (
            <li key={pb.lapId} data-testid="overview-best-lap">
              <Link to={compareUrl(pb.lapId)} title={t('modes.overview.analyze', 'Analyze this lap')} className={`flex items-center justify-between gap-3 py-2 hover:bg-muted/40 ${FOCUS}`}>
                <div className="min-w-0 space-y-0.5">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><Award className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span className="truncate">{pb.track.name}</span></p>
                  <p className="truncate text-xs text-muted-foreground">{pb.car.name} · {games.name(pb.game)} · {day(Date.parse(pb.achievedAt))}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="flex flex-col items-end">
                    <span className="font-mono text-sm tabular-nums" data-testid="overview-best-time">{formatLapTime(pb.bestMs)}</span>
                    {typeof pb.improvedByMs === 'number' && pb.improvedByMs > 0 && (
                      <span className="text-xs text-success" data-testid="overview-best-gain">
                        {t('modes.overview.improvedBy', '{{seconds}} s faster than your previous best', { seconds: (pb.improvedByMs / 1000).toFixed(3) })}
                      </span>
                    )}
                  </span>
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
