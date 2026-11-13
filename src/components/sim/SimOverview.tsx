import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, Loader2, Monitor, Radio } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useSimLaps } from '@/hooks/use-sim-laps';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { useGames } from '@/lib/sim/games';
import { bestLaps, gamesPlayed } from '@/lib/sim/overview';
import { groupSessions } from '@/lib/sim/sessions';
import { listDevices, type SimDevice } from '@/lib/sim/xpeed-sim-api';
import { ACCOUNT_LAPS_REFRESH_MS } from '@/lib/sim/account-laps';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

/**
 * Virtual > Overview: what Xpeed Companion has sent and what the person has driven, from lap summaries only
 * (no lap file is downloaded here).
 */
export function SimOverview() {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen();
  const { laps, serverLaps, settled } = useSimLaps();
  const devices = useQuery({ queryKey: ['sim-devices'], queryFn: listDevices, retry: false, refetchInterval: ACCOUNT_LAPS_REFRESH_MS });

  const sessions = useMemo(() => groupSessions(laps).slice(0, 5), [laps]);
  const best = useMemo(() => bestLaps(laps, 8), [laps]);
  const played = useMemo(() => gamesPlayed(laps), [laps]);
  const connected: SimDevice[] = (devices.data ?? []).filter((device) => !device.revoked_at);
  const lastReceived = useMemo(
    () => serverLaps.reduce<(typeof serverLaps)[number] | null>((last, lap) => (last === null || Date.parse(lap.createdAt) > Date.parse(last.createdAt) ? lap : last), null),
    [serverLaps],
  );

  const companion = (
    <Card className="bg-card border-border" data-testid="overview-companion">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          <SectionTitle>{t('modes.nav.xpeedSim', 'Xpeed Companion')}</SectionTitle>
        </div>
        {devices.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
          </p>
        ) : connected.length === 0 ? (
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
              {connected.map((device) => (
                <li key={device.id} className="flex flex-wrap items-center gap-2" data-testid="overview-device">
                  <Monitor className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{device.name}</span>
                  {device.last_seen_at && (
                    <span className="text-xs text-muted-foreground">
                      {t('modes.overview.lastSeen', 'seen {{when}}', { when: when(Date.parse(device.last_seen_at)) })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-sm" data-testid="overview-last-lap">
              {lastReceived ? (
                <>
                  <span className="text-muted-foreground">{t('modes.overview.lastLap', 'Last lap received')}: </span>
                  {lastReceived.track} · {lastReceived.car} ·{' '}
                  <span className="font-mono tabular-nums">{formatLapTime(lastReceived.timeMs)}</span>{' '}
                  <span className="text-xs text-muted-foreground">({when(Date.parse(lastReceived.createdAt))})</span>
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
  );

  if (!settled) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="overview">
      {companion}

      {laps.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="overview-empty">
          {t('modes.sessions.empty', 'No laps yet. Connect Xpeed Companion and drive: your laps show up here, grouped into sessions.')}{' '}
          <Link to="/virtual/companion" className="underline">{t('modes.sessions.emptyLink', 'Connect Xpeed Companion')}</Link>
        </p>
      ) : (
        <>
          <Card className="bg-card border-border" data-testid="overview-sessions">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <SectionTitle>{t('modes.overview.recent', 'Recent sessions')}</SectionTitle>
                <Link to="/virtual/sessions" className="text-sm underline">{t('modes.overview.allSessions', 'All sessions')}</Link>
              </div>
              <ul className="divide-y divide-border">
                {sessions.map((session) => (
                  <li key={session.id} data-testid="overview-session">
                    <Link to="/virtual/sessions" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 hover:bg-muted/40">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <span className="truncate">{session.trackName} ·</span>
                          <SimCarIdentity name={session.carName} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {games.name(session.game)} · {when(session.startedAt)} · {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.laps.length })}
                        </p>
                      </div>
                      {session.best && (
                        <span className="font-mono text-sm tabular-nums">{formatLapTime(session.best.summary.timeMs)}</span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="bg-card border-border" data-testid="overview-best">
            <CardContent className="space-y-3 p-4">
              <SectionTitle>{t('modes.overview.bestLaps', 'Best laps')}</SectionTitle>
              {best.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('modes.overview.noValid', 'No valid lap yet.')}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {best.map((lap) => (
                    <li key={lap.identity} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="overview-best-lap">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <span className="truncate">{lap.summary.trackName} ·</span>
                          <SimCarIdentity name={lap.summary.carName} />
                        </div>
                        <p className="text-xs text-muted-foreground">{games.name(lap.summary.game)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm tabular-nums">{formatLapTime(lap.summary.timeMs)}</span>
                        <Button asChild size="sm" variant="outline">
                          <Link to={compareUrl(lap.id)} aria-label={t('modes.overview.compare', 'Compare')} title={t('modes.overview.compare', 'Compare')}>
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
                {played.map((entry) => (
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
  );
}
