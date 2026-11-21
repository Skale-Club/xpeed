import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { useIsMobile } from '@/hooks/use-mobile';
import { sessionPath } from '@/lib/sim/routes';
import type { V1Overview, V1Session } from '@/lib/sim/v1-client';
import { SimCarIdentity } from '../SimCarIdentity';
import { KindBadge, PbBadge } from '../session-bits';
import { TrackLayoutThumb } from '../TrackLayoutThumb';
import { useWhen } from '../use-when';
import { Panel, Quiet } from './parts';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One line of an Overview list, the same shape in both lists and at every width: the track's map, then the track and what was driven (it takes the
 * room it is given and truncates), then the time on the right, which never pushes the names out.
 */
function OverviewRow({ to, title, trackId, trackName, head, lines, time, below, testId, linkTestId, chevron = true }: {
  to: string;
  title?: string;
  trackId: string;
  trackName: string;
  /** The first line, around the track's name (an award icon before, a kind badge after). */
  head?: { before?: ReactNode; after?: ReactNode };
  /** The quiet lines under the track's name. */
  lines: ReactNode;
  time: ReactNode;
  /** Under the time (the laps, the gain). */
  below?: ReactNode;
  testId: string;
  linkTestId?: string;
  /** The arrow at the end; a narrow column leaves it out (the whole row is the link) so the names keep their room. */
  chevron?: boolean;
}) {
  return (
    <li data-testid={testId}>
      <Link to={to} title={title} className={`group -mx-2 flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-muted/40 ${FOCUS}`} data-testid={linkTestId}>
        <TrackLayoutThumb trackId={trackId} name={trackName} className="h-10 w-10" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
            {head?.before}
            <span className="truncate">{trackName}</span>
            {head?.after}
          </p>
          {lines}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
          {time}
          {below}
        </div>
        {chevron && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />}
      </Link>
    </li>
  );
}

/** The latest sessions as a short list: the track, the car, when and in which game, the kind, the best valid lap (with a PB mark) and the laps. */
export function SessionsPanel({ sessions, bests = [] }: { sessions: V1Overview['latestSessions']; bests?: V1Overview['latestPersonalBests'] }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const games = useGames();
  const when = useWhen();
  // A session shows the PB badge when its best lap is one of the recent personal bests (same game, track and car, same time).
  const isPb = (session: V1Session) => session.bestLapMs !== null && bests.some((pb) => pb.game === session.game && pb.track.id === session.track.id && pb.car.id === session.car.id && pb.bestMs === session.bestLapMs);
  return (
    <Panel
      title={t('modes.overview.recent', 'Latest sessions')}
      testId="overview-sessions"
      action={<Link to="/virtual/sessions" className={`text-sm underline ${FOCUS}`} data-testid="overview-all-sessions">{t('modes.overview.allSessions', 'All sessions')}</Link>}
    >
      {sessions.length === 0 ? (
        <Quiet>{t('modes.overview.dash.noSessions', 'No sessions yet.')}</Quiet>
      ) : (
        <ul className="divide-y divide-border" data-testid="overview-session-cards">
          {sessions.slice(0, mobile ? 3 : 5).map((session) => (
            <OverviewRow
              key={session.id}
              to={sessionPath(session.id)}
              trackId={session.track.id}
              trackName={session.track.name}
              lines={(
                <>
                  <SimCarIdentity name={session.car.name} className="max-w-full text-xs text-muted-foreground" logoClassName="h-5 w-7" />
                  {/* The kind leads the quiet line, so the track's name never gives up its room to a badge. */}
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <KindBadge kind={session.kind} />
                    <span className="truncate">{when(Date.parse(session.startedAt))} · <span data-testid="session-game">{games.name(session.game)}</span></span>
                  </p>
                </>
              )}
              time={<span className="font-mono text-sm font-semibold tabular-nums" data-testid="overview-session-best">{session.bestLapMs !== null ? formatLapTime(session.bestLapMs) : '–'}</span>}
              below={(
                <span className="flex items-center gap-1.5">
                  {isPb(session) && <PbBadge testId="overview-session-pb" />}
                  <span className="text-xs tabular-nums text-muted-foreground" data-testid="overview-session-laps">{t('modes.overview.dash.lapsN', '{{count}} laps', { count: session.lapCount })}</span>
                </span>
              )}
              testId="overview-session"
              linkTestId="overview-session-link"
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The five personal bests set most recently, as a short list in the same shape (it sits in the narrow column: no arrow, no award icon, the title says
 * what they are); each opens the lap's analysis. */
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
          {bests.slice(0, 5).map((pb) => {
            const gain = typeof pb.improvedByMs === 'number' && pb.improvedByMs > 0 ? (pb.improvedByMs / 1000).toFixed(3) : null;
            const gainText = gain ? t('modes.overview.improvedBy', '{{seconds}} s faster than your previous best', { seconds: gain }) : '';
            return (
              <OverviewRow
                key={pb.lapId}
                to={compareUrl(pb.lapId)}
                title={t('modes.overview.analyze', 'Analyze this lap')}
                trackId={pb.track.id}
                trackName={pb.track.name}
                chevron={false}
                lines={(
                  <>
                    <SimCarIdentity name={pb.car.name} className="max-w-full text-xs text-muted-foreground" logoClassName="h-5 w-7" />
                    <p className="truncate text-xs text-muted-foreground">{day(Date.parse(pb.achievedAt))} · {games.name(pb.game)}</p>
                  </>
                )}
                time={<span className="font-mono text-sm font-semibold tabular-nums" data-testid="overview-best-time">{formatLapTime(pb.bestMs)}</span>}
                below={gain && (
                  // Short on screen (a gain is always "faster"); the whole sentence for screen readers and as a tooltip.
                  <span className="font-mono text-xs tabular-nums text-success" title={gainText} data-testid="overview-best-gain">
                    <span aria-hidden="true">−{gain} s</span>
                    <span className="sr-only">{gainText}</span>
                  </span>
                )}
                testId="overview-best-lap"
              />
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
