import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRight, Monitor, Radio } from 'lucide-react';
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
import { useWhen } from './use-when';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

/**
 * Virtual > Overview: what Xpeed Companion has sent and what the person has driven, in one cheap call (no lap file is downloaded
 * here). It is read again every minute while the page is open. Another task rebuilds this page around progress.
 */
export function SimOverview() {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen();
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
              </div>
              {devices.length === 0 ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t('modes.overview.connectBody', 'Connect Xpeed Companion on the computer you race on, and your laps arrive here by themselves.')}
                  </p>
                  <Button asChild size="sm">
                    <Link to="/virtual/companion">{t('modes.overview.connect', 'Connect Xpeed Companion')}</Link>
                  </Button>
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
              <Card className="bg-card border-border" data-testid="overview-sessions">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <SectionTitle>{t('modes.overview.recent', 'Recent sessions')}</SectionTitle>
                    <Link to="/virtual/sessions" className="text-sm underline">{t('modes.overview.allSessions', 'All sessions')}</Link>
                  </div>
                  <ul className="divide-y divide-border">
                    {overview.latestSessions.map((session) => (
                      <li key={session.id} data-testid="overview-session">
                        <Link to={sessionPath(session.id)} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 hover:bg-muted/40">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                              <span className="truncate">{session.track.name} ·</span>
                              <SimCarIdentity name={session.car.name} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {games.name(session.game)} · {when(Date.parse(session.startedAt))} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}
                            </p>
                          </div>
                          {session.bestLapMs !== null && <span className="font-mono text-sm tabular-nums">{formatLapTime(session.bestLapMs)}</span>}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>

              <Card className="bg-card border-border" data-testid="overview-best">
                <CardContent className="space-y-3 p-4">
                  <SectionTitle>{t('modes.overview.bestLaps', 'Best laps')}</SectionTitle>
                  {overview.latestPersonalBests.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('modes.overview.noValid', 'No valid lap yet.')}</p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {overview.latestPersonalBests.map((pb) => (
                        <li key={pb.lapId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="overview-best-lap">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                              <span className="truncate">{pb.track.name} ·</span>
                              <SimCarIdentity name={pb.car.name} />
                            </div>
                            <p className="text-xs text-muted-foreground">{games.name(pb.game)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm tabular-nums">{formatLapTime(pb.bestMs)}</span>
                            <Button asChild size="sm" variant="outline">
                              <Link to={compareUrl(pb.lapId)} aria-label={t('modes.overview.compare', 'Compare')} title={t('modes.overview.compare', 'Compare')}>
                                <ArrowLeftRight className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">{t('modes.overview.compare', 'Compare')}</span>
                              </Link>
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
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
            </>
          )}
        </div>
      )}
    </QueryGate>
  );
}
