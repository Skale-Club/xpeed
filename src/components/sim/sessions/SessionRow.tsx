import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { GameCover } from '../GameCover';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { sessionPath } from '@/lib/sim/routes';
import { consistency } from '@/lib/sim/session-stats';
import { flyingLaps } from '@/lib/sim/session-detail';
import { lapSparkPath, lapTally, pbStanding } from '@/lib/sim/sessions-view';
import type { V1Pb, V1Session } from '@/lib/sim/v1-client';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { cn } from '@/lib/utils';
import { GameBadge, KindBadge, PbBadge } from '../session-bits';
import { SimCarIdentity } from '../SimCarIdentity';
import { TrackLayoutThumb } from '../TrackLayoutThumb';
import { useDashFormat } from '../overview/use-format';
import { useConditions } from '../use-session-text';
import { useInView } from './use-in-view';
import { useTimeOfDay } from './use-time-of-day';
import { useSessionPreview } from './use-session-preview';

const SPARK = { width: 104, height: 30 } as const;

/**
 * One number of the card's lower row: its label and, under it, the value. Every value sits in the middle of a band as tall as the lap-time line
 * (the tallest value), so the labels of a row share one line and so do the values. On a phone the row is two by two: only the pair that holds the
 * line needs the tall band (`tall`); from `sm` up the four are one row and all take it.
 */
function Metric({ label, children, testId, tall = false }: { label: string; children: React.ReactNode; testId?: string; tall?: boolean }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 flex items-center text-sm sm:min-h-[30px]', tall && 'min-h-[30px]')}>{children}</dd>
    </div>
  );
}

/** The lap times of the session as a small line (faster is lower, as on the chart of the session), with the fastest lap as a dot. */
function LapSparkline({ laps }: { laps: Parameters<typeof lapSparkPath>[0] }) {
  const { t } = useTranslation();
  const spark = useMemo(() => lapSparkPath(laps, SPARK.width, SPARK.height), [laps]);
  if (spark.points === 0) return <span className="text-muted-foreground">–</span>;
  return (
    <svg
      viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
      className="h-[30px] w-full max-w-[104px]"
      role="img"
      aria-label={t('sessionsDash.row.sparkLabel', { count: spark.points, defaultValue_one: 'Lap times through the session: {{count}} flying lap, marked as the fastest.', defaultValue_other: 'Lap times through the session: {{count}} flying laps, the fastest marked.' })}
      data-testid="session-spark"
      data-points={spark.points}
    >
      {spark.d && <path d={spark.d} fill="none" stroke="hsl(var(--muted-foreground))" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {spark.best && <circle cx={spark.best.x} cy={spark.best.y} r={3} fill={CHART_PALETTE.green} />}
    </svg>
  );
}

/**
 * One session, as a card that opens its page: the game's cover, the track and the car, when and what kind, the laps (and how many were valid, once the
 * laps are read), the best valid lap with how it stands against the personal best on that track and car (a "PB" badge, or the gap), how steady the
 * laps were and their trend as a line. The laps are read once, when the row is about to be seen.
 */
function SessionRowView({ session, pb, pbsReady }: { session: V1Session; pb: V1Pb | undefined; pbsReady: boolean }) {
  const { t } = useTranslation();
  const timeOfDay = useTimeOfDay();
  const format = useDashFormat();
  const conditions = useConditions();
  const { ref, seen } = useInView<HTMLLIElement>();
  const preview = useSessionPreview(session.id, seen);
  const laps = preview.data?.laps ?? null;
  const tally = useMemo(() => (laps ? lapTally(laps) : null), [laps]);
  // A spread needs three clean laps to mean anything, as on the Overview (the server's spread of a session says nothing under three).
  const steady = useMemo(() => (laps && flyingLaps(laps).length >= 3 ? consistency(laps) : null), [laps]);
  const weather = conditions(session);
  const standing = pbsReady ? pbStanding(session, pb) : ({ kind: 'none' } as const);

  return (
    <li ref={ref}>
      <Link to={sessionPath(session.id)} className="group block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="session-link">
        <Card className="border-border bg-card transition-colors group-hover:bg-muted/30" data-testid="session">
          {/* Two rows that know nothing of each other: the head (cover, track, car, when) and, under a line, the numbers across the card's full width. */}
          <div className="space-y-3 p-3 sm:p-4">
            {/*
              The cover is exactly as tall as the head's text: its top is the top of the track name's capitals and its base the baseline of the
              last line (the time), because those two lines are trimmed to their letters (`text-box`; a browser without it is a few pixels off).
              Its width is two thirds of that height (the covers are 2 : 3), so the picture is whole.
            */}
            <div className="flex gap-3" data-testid="session-head">
              <GameCover game={session.game} className="w-12 self-stretch aspect-auto sm:w-11" testId="session-cover" />
              {/* A phone keeps the track and the car on the first line and puts the kind at the end of the time line; the game's name is the cover's. */}
              <div className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
                <TrackLayoutThumb trackId={session.track.id} name={session.track.name} className="col-start-1 row-start-1 h-11 w-11" />
                <div className="col-span-2 col-start-2 row-start-1 min-w-0 sm:col-span-1">
                  {/* Cut sideways only (not `truncate`): trimmed to its capitals, an accent above them (Ö, Á) must not be cut off. */}
                  <h3 className="overflow-x-clip text-ellipsis whitespace-nowrap text-sm font-semibold [text-box:trim-start_cap_alphabetic] sm:text-base">{session.track.name}</h3>
                  <SimCarIdentity name={session.car.name} className="text-sm text-muted-foreground" logoClassName="h-7 w-10" />
                </div>
                <div className="col-start-3 row-start-2 flex shrink-0 items-center gap-1.5 justify-self-end sm:row-start-1 sm:self-start">
                  <span className="hidden sm:contents"><GameBadge game={session.game} cover={false} /></span>
                  <KindBadge kind={session.kind} />
                  <ChevronRight className="hidden h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 sm:block" aria-hidden="true" />
                </div>
                <div className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:col-span-3 [&>span]:[text-box:trim-end_cap_alphabetic]">
                  <span data-testid="session-time">{timeOfDay(Date.parse(session.startedAt))}</span>
                  {weather && <span data-testid="session-conditions">{weather}</span>}
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-2 items-start gap-x-4 gap-y-2.5 border-t border-border pt-3 sm:grid-cols-4" data-testid="session-numbers">
              <Metric label={t('sessionsDash.row.laps', 'Laps')} testId="session-laps-metric">
                <span>
                  <span className="tabular-nums" data-testid="session-lap-count">{format.number(session.lapCount)}</span>
                  {tally && (
                    <span className="ml-1.5 text-xs text-muted-foreground" data-testid="session-valid">
                      {t('sessionsDash.row.validOf', '{{valid}} valid', { valid: tally.valid })}
                    </span>
                  )}
                </span>
              </Metric>
              <Metric label={t('modes.sessions.bestLabel', 'Best valid lap')} testId="session-best">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-mono font-semibold tabular-nums">{session.bestLapMs !== null ? formatLapTime(session.bestLapMs) : '–'}</span>
                  {session.bestLapMs === null && (
                    <span className="text-xs text-muted-foreground" data-testid="session-no-valid">{t('sessionsDash.row.noValid', 'no valid lap')}</span>
                  )}
                  {standing.kind === 'pb' && <PbBadge title={t('sessionsDash.row.pbHint', 'This is your personal best on this track in this car.')} testId="session-pb" />}
                  {standing.kind === 'behind' && (
                    <span
                      className="font-mono text-xs tabular-nums text-muted-foreground"
                      title={t('sessionsDash.row.behindHint', 'Slower than your personal best on this track in this car by this much.')}
                      data-testid="session-delta"
                    >
                      {formatGap(standing.deltaMs / 1000)}
                      <span className="sr-only"> {t('sessionsDash.row.vsPb', 'against your personal best')}</span>
                    </span>
                  )}
                </span>
              </Metric>
              <Metric tall label={t('sessionsDash.row.consistency', 'Consistency')} testId="session-spread">
                {steady?.spreadS != null ? (
                  <span className="font-mono tabular-nums" title={t('sessionsDash.row.spreadHint', 'Spread of the valid laps (standard deviation), pit laps left out.')}>±{steady.spreadS.toFixed(2)} s</span>
                ) : (
                  <span className="text-muted-foreground">–</span>
                )}
              </Metric>
              <Metric tall label={t('sessionsDash.row.trend', 'Lap times')} testId="session-trend">
                {laps ? <LapSparkline laps={laps} /> : <span className="block h-[30px] w-full max-w-[104px] rounded bg-muted/50" aria-hidden="true" />}
              </Metric>
            </dl>
          </div>
        </Card>
      </Link>
    </li>
  );
}

export const SessionRow = memo(SessionRowView);
