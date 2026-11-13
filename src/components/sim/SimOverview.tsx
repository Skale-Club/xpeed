import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Award, ChevronRight, Download, Monitor, Radio } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { sessionPath } from '@/lib/sim/routes';
import { useGames } from '@/lib/sim/games';
import { useOverview } from '@/lib/sim/v1-client';
import { SimCarIdentity } from './SimCarIdentity';
import { CompanionInvite, QueryGate } from './SimStates';
import { GameBadge, KindBadge } from './session-bits';
import { useWhen } from './use-when';
import { WorkOnCard } from './WorkOnCard';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

/**
 * Virtual > Overview, the home of the mode: whether Xpeed Companion is connected and what it sent last, the latest personal bests and
 * sessions, the games played and, once the page is up, what to work on. All of it comes from one cheap call (no lap file is read for a
 * list); it is read again every minute while the page is open. "What to work on" is the only part that reads lap files, and only those
 * of one session, after the rest is already on screen.
 */
export function SimOverview() {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen();
  const day = useWhen('date');
  const query = useOverview();
  const overview = query.data;
  const devices = overview?.companion.devices ?? [];
  const lastLap = overview?.companion.lastLap ?? null;

  return (
    <QueryGate query={query} empty={false}>
      {overview && (
        <div className="space-y-4" data-testid="overview">
          <Card className="bg-card border-border" data-testid="overview-companion">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center gap-2">
                <Radio className="h-4 w-4 text-primary" />
                <SectionTitle>{t('modes.nav.xpeedSim', 'Xpeed Companion')}</SectionTitle>
                {devices.length > 0 && <Badge variant="secondary" data-testid="overview-connected">{t('modes.overview.connected', 'Connected')}</Badge>}
              </div>
              {devices.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t('modes.overview.connectBody', 'Connect Xpeed Companion on the computer you race on, and your laps arrive here by themselves.')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button asChild size="sm">
                      <Link to="/companion" data-testid="overview-download"><Download className="mr-2 h-4 w-4" />{t('modes.states.install', 'Get Xpeed Companion')}</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/virtual/companion">{t('modes.overview.connect', 'Connect Xpeed Companion')}</Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <ul className="space-y-1 text-sm">
                    {devices.map((device) => (
                      <li key={device.id} className="flex flex-wrap items-center gap-2" data-testid="overview-device">
                        <Monitor className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{device.name}</span>
                        {device.lastSeenAt && (
                          <span className="text-xs text-muted-foreground">{t('modes.overview.lastSeen', 'seen {{when}}', { when: when(Date.parse(device.lastSeenAt)) })}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="text-sm" data-testid="overview-last-lap">
                    {lastLap ? (
                      <>
                        <span className="text-muted-foreground">{t('modes.overview.lastLap', 'Last lap received')}: </span>
                        {lastLap.track?.name ?? '–'} · {lastLap.car?.name ?? '–'} · <span className="font-mono tabular-nums">{formatLapTime(lastLap.timeMs)}</span>{' '}
                        <span className="text-xs text-muted-foreground">({when(Date.parse(lastLap.createdAt))})</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t('modes.overview.noLapYet', 'No lap received yet. Drive a lap with a game open.')}</span>
                    )}
                  </p>
                  <Link to="/virtual/companion" className="text-sm underline">{t('modes.overview.manage', 'Manage Xpeed Companion')}</Link>
                </>
              )}
            </CardContent>
          </Card>

          {overview.lapsPerGame.length === 0 ? (
            <CompanionInvite testId="overview-empty" />
          ) : (
            <>
              <Card className="bg-card border-border" data-testid="overview-best">
                <CardContent className="space-y-3 p-4">
                  <SectionTitle>{t('modes.overview.bestLaps', 'Recent personal bests')}</SectionTitle>
                  {overview.latestPersonalBests.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('modes.overview.noValid', 'No valid lap yet.')}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {overview.latestPersonalBests.slice(0, 5).map((pb) => (
                        <li key={pb.lapId} data-testid="overview-best-lap">
                          <Link
                            to={compareUrl(pb.lapId)}
                            className="flex items-center justify-between gap-3 py-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            title={t('modes.overview.analyze', 'Analyze this lap')}
                          >
                            <div className="min-w-0 space-y-0.5">
                              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                                <Award className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                                <span className="truncate">{pb.track.name}</span>
                              </div>
                              <SimCarIdentity name={pb.car.name} className="text-sm text-muted-foreground" />
                              <p className="text-xs text-muted-foreground">{games.name(pb.game)} · {day(Date.parse(pb.achievedAt))}</p>
                            </div>
                            <span className="flex shrink-0 items-center gap-1">
                              <span className="font-mono text-sm tabular-nums" data-testid="overview-best-time">{formatLapTime(pb.bestMs)}</span>
                              <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card border-border" data-testid="overview-sessions">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <SectionTitle>{t('modes.overview.recent', 'Latest sessions')}</SectionTitle>
                    <Link to="/virtual/sessions" className="text-sm underline">{t('modes.overview.allSessions', 'All sessions')}</Link>
                  </div>
                  <ul className="divide-y divide-border">
                    {overview.latestSessions.slice(0, 5).map((session) => (
                      <li key={session.id} data-testid="overview-session">
                        <Link to={sessionPath(session.id)} className="flex items-center justify-between gap-3 py-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          <div className="min-w-0 space-y-1">
                            <p className="truncate text-sm font-medium">{session.track.name}</p>
                            <SimCarIdentity name={session.car.name} className="text-sm text-muted-foreground" />
                            <div className="flex flex-wrap items-center gap-2">
                              <KindBadge kind={session.kind} />
                              <GameBadge game={session.game} />
                              <span className="text-xs text-muted-foreground">
                                {when(Date.parse(session.startedAt))} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}
                              </span>
                            </div>
                          </div>
                          {session.bestLapMs !== null && <span className="shrink-0 font-mono text-sm tabular-nums">{formatLapTime(session.bestLapMs)}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card className="bg-card border-border" data-testid="overview-games">
                <CardContent className="space-y-3 p-4">
                  <SectionTitle>{t('modes.overview.games', 'Games played')}</SectionTitle>
                  <ul className="flex flex-wrap gap-3">
                    {overview.lapsPerGame.map((entry) => (
                      <li key={entry.game} className="flex items-center gap-2 rounded-lg border border-border p-2" data-testid="overview-game">
                        {games.cover(entry.game) && <img src={games.cover(entry.game)!} alt="" className="h-10 w-10 rounded-md object-cover" loading="lazy" />}
                        <div>
                          <p className="text-sm font-medium">{games.name(entry.game)}</p>
                          <Badge variant="secondary">{t('modes.sessions.lapCount', 'Laps: {{count}}', { count: entry.laps })}</Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <WorkOnCard sessions={overview.latestSessions} />
            </>
          )}
        </div>
      )}
    </QueryGate>
  );
}
