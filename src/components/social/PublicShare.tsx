import { Suspense, lazy, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Award, Ban, CloudOff, LineChart, Loader2, RefreshCw, UserRound } from 'lucide-react';
import { BrandLockup } from '@/components/BrandLockup';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { GameBadge, KindBadge } from '@/components/sim/session-bits';
import { useWhen } from '@/components/sim/use-when';
import { formatLapTime } from '@/lib/sim/analysis';
import { cleanName, usePublicShare, type PublicLapShare, type PublicSessionShare, type PublicShare } from '@/lib/sim/social-client';
import { V1Error } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { atHandle } from './social-utils';

// The speed trace is a separate chunk (the chart library and the lap reader): the page itself is text and a few boxes.
const SpeedTrace = lazy(() => import('./SpeedTrace'));

const sector = (ms: number) => (ms / 1000).toFixed(3);

/** The sectors of a lap as a strip: each one as wide as it was long, with its time. */
export function SectorStrip({ sectorsMs }: { sectorsMs: number[] }) {
  const { t } = useTranslation();
  const total = sectorsMs.reduce((sum, ms) => sum + ms, 0);
  if (sectorsMs.length < 2 || total <= 0) return null;
  return (
    <div className="space-y-1" data-testid="sector-strip">
      <p className="text-xs font-medium text-muted-foreground">{t('social.public.sectors', 'Sectors')}</p>
      <ol className="flex overflow-hidden rounded-md border border-border text-xs" aria-label={t('social.public.sectors', 'Sectors')}>
        {sectorsMs.map((ms, i) => (
          <li
            key={i}
            className={cn('min-w-0 px-2 py-1.5 text-center', i % 2 === 0 ? 'bg-primary/15' : 'bg-primary/5', i > 0 && 'border-l border-border')}
            style={{ flexGrow: ms, flexBasis: 0 }}
            data-testid="sector"
          >
            <span className="block text-[10px] text-muted-foreground">{`S${i + 1}`}</span>
            <span className="block truncate font-mono tabular-nums">{sector(ms)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Who drove it: the name and the handle, or "Anonymous driver" when the owner's profile is private (the server sends no driver). */
function Driver({ driver }: { driver: PublicShare['driver'] }) {
  const { t } = useTranslation();
  const name = cleanName(driver?.displayName);
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="share-driver">
      <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
      {!driver ? (
        <span className="text-muted-foreground" data-testid="driver-anonymous">{t('social.public.anonymous', 'Anonymous driver')}</span>
      ) : (
        <>
          {name && <span className="font-medium" data-testid="driver-display-name">{name}</span>}
          <span className={name ? 'text-xs text-muted-foreground' : 'font-medium'} data-testid="driver-handle">{atHandle(driver.handle)}</span>
        </>
      )}
    </p>
  );
}

function Trace({ token, lapId }: { token: string; lapId: string }) {
  return (
    <Suspense fallback={<Skeleton className="h-40 w-full rounded-lg" />}>
      <SpeedTrace token={token} lapId={lapId} />
    </Suspense>
  );
}

function LapView({ share, token }: { share: PublicLapShare; token: string }) {
  const { t } = useTranslation();
  const when = useWhen();
  const { lap } = share;
  return (
    <Card className="bg-card border-border" data-testid="public-lap">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold" data-testid="public-track">{lap.track.name}</h1>
            <p className="text-sm text-muted-foreground" data-testid="public-car">{lap.car.name}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <GameBadge game={lap.game} />
            {!lap.valid && <Badge variant="destructive">{t('modes.compare.notValid', 'not valid')}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
          <p className="font-mono text-4xl font-semibold tabular-nums" data-testid="public-time">{formatLapTime(lap.timeMs)}</p>
          <p className="pb-1 text-sm text-muted-foreground">
            {t('modes.compare.lapN', 'Lap {{n}}', { n: lap.lapNumber })} · {when(Date.parse(lap.startedAt))}
            {lap.topSpeedKmh !== null && ` · ${t('social.public.topSpeed', 'top speed {{speed}} km/h', { speed: Math.round(lap.topSpeedKmh) })}`}
          </p>
        </div>
        <Driver driver={share.driver} />
        {lap.sectorsMs && <SectorStrip sectorsMs={lap.sectorsMs} />}
        <Trace token={token} lapId={lap.id} />
      </CardContent>
    </Card>
  );
}

function SessionView({ share, token }: { share: PublicSessionShare; token: string }) {
  const { t } = useTranslation();
  const when = useWhen();
  const { session } = share;
  const best = useMemo(() => session.laps.filter((lap) => lap.valid).sort((p, q) => p.timeMs - q.timeMs)[0] ?? null, [session.laps]);
  const [picked, setPicked] = useState<string | null>(null);
  const traceLap = picked ?? best?.id ?? session.laps[0]?.id ?? null;
  const sectorCount = Math.max(0, ...session.laps.map((lap) => lap.sectorsMs?.length ?? 0));
  const weather = [session.weather, session.airTempC !== null ? `${session.airTempC} °C` : null, session.trackTempC !== null ? `${session.trackTempC} °C` : null].filter(Boolean);
  return (
    <div className="space-y-4" data-testid="public-session">
      <Card className="bg-card border-border">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-xl font-bold" data-testid="public-track">{session.track.name}</h1>
              <p className="text-sm text-muted-foreground" data-testid="public-car">{session.car.name}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <KindBadge kind={session.kind as 'practice' | 'qualifying' | 'race' | 'unknown'} />
              <GameBadge game={session.game} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {when(Date.parse(session.startedAt))}
            {weather.length > 0 ? ` · ${weather.join(' · ')}` : ''}
          </p>
          <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
            {session.bestLapMs !== null && (
              <p>
                <span className="block text-xs text-muted-foreground">{t('modes.sessions.bestLabel', 'Best valid lap')}</span>
                <span className="font-mono text-3xl font-semibold tabular-nums" data-testid="public-best">{formatLapTime(session.bestLapMs)}</span>
              </p>
            )}
            <p className="pb-1 text-sm text-muted-foreground">{t('modes.sessions.lapCount', 'Laps: {{count}}', { count: session.lapCount })}</p>
          </div>
          <Driver driver={share.driver} />
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="px-3 pb-1 sm:px-6">
          <CardTitle className="text-sm font-semibold">{t('modes.session.lapsTitle', 'Laps')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 px-3 pb-4 sm:px-6">
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm" data-testid="public-laps">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="pr-2 font-normal">{t('modes.compare.lap', 'Lap')}</th>
                  <th scope="col" className="pr-2 text-right font-normal">{t('modes.sessions.time', 'Time')}</th>
                  {Array.from({ length: sectorCount }, (_, i) => (
                    <th key={i} scope="col" className="pr-2 text-right font-normal">{`S${i + 1}`}</th>
                  ))}
                  <th scope="col" className="font-normal"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
                </tr>
              </thead>
              <tbody>
                {session.laps.map((lap) => (
                  <tr key={lap.id} className={cn('border-t border-border', lap.id === traceLap && 'bg-primary/5')} data-testid="public-lap-row">
                    <td className="py-1.5 pr-2">
                      {/* The state of a lap is an icon (with its words for screen readers), so the table fits a phone. */}
                      <span className="flex items-center gap-1">
                        {lap.lapNumber}
                        {best?.id === lap.id && <><Award className="h-3.5 w-3.5 text-primary" aria-hidden /><span className="sr-only">{t('modes.sessions.isBest', 'Best lap')}</span></>}
                        {!lap.valid && <><Ban className="h-3.5 w-3.5 text-destructive" aria-hidden /><span className="sr-only">{t('modes.compare.notValid', 'not valid')}</span></>}
                      </span>
                    </td>
                    <td className={cn('whitespace-nowrap py-1.5 pr-2 text-right font-mono tabular-nums', !lap.valid && 'text-muted-foreground line-through')}>{formatLapTime(lap.timeMs)}</td>
                    {Array.from({ length: sectorCount }, (_, i) => (
                      <td key={i} className="whitespace-nowrap py-1.5 pr-2 text-right font-mono tabular-nums text-muted-foreground">{lap.sectorsMs?.[i] ? sector(lap.sectorsMs[i]) : '–'}</td>
                    ))}
                    <td className="whitespace-nowrap py-1.5 text-right">
                      <Button
                        size="icon"
                        variant={lap.id === traceLap ? 'secondary' : 'ghost'}
                        className="h-8 w-8"
                        aria-pressed={lap.id === traceLap}
                        aria-label={`${t('social.public.showTrace', 'Speed trace')} ${lap.lapNumber}`}
                        title={t('social.public.showTrace', 'Speed trace')}
                        onClick={() => setPicked(lap.id)}
                        data-testid="public-trace-pick"
                      >
                        <LineChart className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="public-legend">
            <span className="flex items-center gap-1"><Award className="h-3.5 w-3.5 text-primary" aria-hidden />{t('modes.sessions.isBest', 'Best lap')}</span>
            <span className="flex items-center gap-1"><Ban className="h-3.5 w-3.5 text-destructive" aria-hidden />{t('modes.compare.notValid', 'not valid')}</span>
          </p>
          {traceLap && (
            <>
              {(() => {
                const lap = session.laps.find((entry) => entry.id === traceLap);
                return lap?.sectorsMs ? <SectorStrip sectorsMs={lap.sectorsMs} /> : null;
              })()}
              <Trace key={traceLap} token={token} lapId={traceLap} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** The call to action under every shared lap: the person who opened the link may want their own laps. */
export function CompanionBanner() {
  const { t } = useTranslation();
  return (
    <aside className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 p-4" data-testid="companion-banner">
      <p className="text-sm font-medium">{t('social.public.banner', 'Want to record your own laps? Get Xpeed Companion')}</p>
      <Button asChild size="sm">
        <Link to="/companion">{t('modes.states.install', 'Get Xpeed Companion')}</Link>
      </Button>
    </aside>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2">
          <Link to="/companion" aria-label="Xpeed"><BrandLockup logoClassName="h-7 w-7" nameClassName="text-base" /></Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-4 p-4">{children}</main>
    </div>
  );
}

/**
 * `/s/:token`, open to anybody with the link, signed in or not: a shared lap or session (track, car, game, times, sectors, the driver
 * or "Anonymous driver", a speed trace read lazily) and a banner for Xpeed Companion. A link that is revoked, expired or never was is
 * one neutral page. Nothing here knows who is looking.
 */
export function PublicSharePage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const query = usePublicShare(token);
  const share = query.data ?? null;
  const gone = query.error instanceof V1Error && query.error.status === 404;
  const limited = query.error instanceof V1Error && query.error.status === 429;

  return (
    <Frame>
      {query.isPending ? (
        <div className="space-y-3" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="public-loading">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      ) : gone ? (
        <div className="space-y-3 rounded-lg border border-dashed border-border p-6 text-center" data-testid="public-unavailable">
          <h1 className="text-lg font-semibold">{t('social.public.unavailable', 'This link is not available')}</h1>
          <p className="text-sm text-muted-foreground">{t('social.public.unavailableBody', 'It may have been turned off by the person who shared it, or it has expired.')}</p>
        </div>
      ) : query.isError ? (
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" data-testid="public-error">
          <p className="flex items-center gap-2 font-medium">
            <CloudOff className="h-4 w-4 shrink-0" />
            {limited ? t('social.public.limited', 'Too many people are opening links from this address. Wait a minute and try again.') : t('social.public.failed', 'The page could not be loaded. Check your connection and try again.')}
          </p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('modes.states.retry', 'Try again')}
          </Button>
        </div>
      ) : share ? (
        share.kind === 'lap' ? <LapView share={share} token={token} /> : <SessionView share={share} token={token} />
      ) : null}
      <CompanionBanner />
    </Frame>
  );
}
