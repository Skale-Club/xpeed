import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { pairRange, savedSeconds } from '@/lib/sim/dashboard';
import { formatTick, timeTicks } from '@/lib/sim/progress';
import { trackPath } from '@/lib/sim/routes';
import { useGames } from '@/lib/sim/games';
import type { V1Improvement, V1Stats, V1StatsPair } from '@/lib/sim/v1-client';
import { SimCarIdentity } from '../SimCarIdentity';
import { useWhen } from '../use-when';
import { Panel, Quiet } from './parts';
import { useDashFormat } from './use-format';

const AXIS = { fontSize: 10, fill: 'hsl(var(--muted-foreground))' } as const;
const TOOLTIP = { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 } as const;

/** "Where you got faster": the latest personal bests of the period, what each saved, and a link into the lap's analysis. */
const FIRST_ROWS = 5;

function Improvements({ items }: { items: readonly V1Improvement[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FIRST_ROWS);
  const games = useGames();
  const when = useWhen('date');
  return (
    <section className="space-y-2" aria-labelledby="improvements-title" data-testid="progress-improvements">
      <h4 id="improvements-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('modes.overview.dash.fasterTitle', 'Where you got faster')}</h4>
      {items.length === 0 ? (
        <Quiet testId="improvements-empty">{t('modes.overview.dash.fasterEmpty', 'No new personal best in this period yet.')}</Quiet>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((item) => (
            <li key={item.lapId} data-testid="improvement">
              <Link
                to={compareUrl(item.lapId)}
                title={t('modes.overview.analyze', 'Analyze this lap')}
                className="flex items-center justify-between gap-3 py-2 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{item.trackName}</p>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <SimCarIdentity name={item.carName} className="text-xs" />
                    <span>{games.name(item.game)} · {when(Date.parse(item.achievedAt))}</span>
                  </div>
                </div>
                <span className="flex shrink-0 items-center gap-3 text-right">
                  {item.savedMs !== null ? (
                    <span className="font-mono text-sm tabular-nums text-success" data-testid="improvement-saved">-{savedSeconds(item.savedMs)} s</span>
                  ) : (
                    <Badge variant="secondary" data-testid="improvement-first">{t('modes.overview.dash.firstBest', 'First valid lap')}</Badge>
                  )}
                  <span className="font-mono text-sm tabular-nums" data-testid="improvement-time">{formatLapTime(item.timeMs)}</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {items.length > FIRST_ROWS && (
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => setAll((value) => !value)} aria-expanded={all} data-testid="improvements-toggle">
          {all ? t('modes.overview.dash.showFewer', 'Show fewer') : t('modes.overview.dash.showAll', 'Show all {{total}}', { total: items.length })}
        </Button>
      )}
    </section>
  );
}

/** One small multiple: the best valid lap of each day of the period for a track and a car, in seconds, the last value written next to its dot. */
function PairChart({ pair }: { pair: V1StatsPair }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const rows = useMemo(() => pair.bestPerDay.map((entry) => ({ at: Date.parse(`${entry.day}T00:00:00.000Z`), day: entry.day, s: entry.bestMs / 1000 })), [pair]);
  const range = useMemo(() => pairRange(pair.bestPerDay.map((entry) => entry.bestMs)), [pair]);
  const axis = useMemo(() => (range ? timeTicks(range.low, range.high, 4) : null), [range]);
  const last = rows[rows.length - 1];
  const first = rows[0];
  const alt = range && first && last
    ? t('modes.overview.dash.pairAlt', 'Best valid lap per day, {{track}} with {{car}}: {{first}} on {{firstDay}}, {{last}} on {{lastDay}}, {{count}} days.', {
        track: pair.trackName, car: pair.carName, first: formatLapTime(first.s * 1000), firstDay: format.day(first.day), last: formatLapTime(last.s * 1000), lastDay: format.day(last.day), count: rows.length,
      })
    : '';

  return (
    <li className="space-y-1 rounded-lg border border-border p-3" data-testid="progress-pair">
      <Link to={trackPath(pair.trackId)} className="block min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={t('modes.overview.dash.openTrack', 'Open the track page')}>
        <p className="truncate text-sm font-medium">{pair.trackName}</p>
        <p className="truncate text-xs text-muted-foreground">{pair.carName} · {t('modes.overview.dash.lapsN', '{{count}} laps', { count: pair.laps })}</p>
      </Link>
      {range && axis && last ? (
        <div className="h-24" role="img" aria-label={alt} data-testid="pair-chart">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={rows} margin={{ top: 14, right: 54, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={[first.at, last.at]} tick={AXIS} tickFormatter={(value: number) => format.day(new Date(value).toISOString().slice(0, 10))} tickLine={false} padding={{ left: 4, right: 4 }} />
              <YAxis domain={[range.low, range.high]} ticks={axis.ticks} allowDataOverflow tick={AXIS} width={44} tickLine={false} axisLine={false} tickFormatter={(value: number) => formatTick(value, axis.step)} />
              <Tooltip
                contentStyle={TOOLTIP}
                labelFormatter={(value) => format.day(new Date(Number(value)).toISOString().slice(0, 10), 'long')}
                formatter={(value: number) => [formatLapTime(value * 1000), t('modes.progress.bestPerDay', 'Best valid lap')]}
              />
              <Line
                dataKey="s"
                type="linear"
                stroke={CHART_PALETTE.blue}
                strokeWidth={2}
                dot={{ r: 2.5, fill: CHART_PALETTE.blue, stroke: 'hsl(var(--card))', strokeWidth: 1.5 }}
                isAnimationActive={false}
                label={(props: { x?: number; y?: number; index?: number; value?: number }) =>
                  props.index === rows.length - 1 && props.x !== undefined && props.y !== undefined && props.value !== undefined ? (
                    <text key="last" x={props.x + 6} y={props.y - 6} fontSize={10} fontWeight={600} fill="hsl(var(--foreground))">{formatLapTime(props.value * 1000)}</text>
                  ) : <g key={props.index} />
                }
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Quiet testId="pair-empty">{t('modes.overview.dash.pairNotEnough', 'Not enough laps yet')}</Quiet>
      )}
    </li>
  );
}

/** Progress: where you got faster, and small multiples of the best lap per day for the four most driven track and car pairs. */
export function ProgressPanel({ stats }: { stats: V1Stats }) {
  const { t } = useTranslation();
  return (
    <Panel title={t('modes.progress.title', 'Progress')} testId="overview-progress">
      <Improvements items={stats.improvements} />
      {stats.pairs.length > 0 && (
        <section className="space-y-2" aria-labelledby="pairs-title">
          <h4 id="pairs-title" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('modes.overview.dash.pairsTitle', 'Best valid lap by track and car')}</h4>
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="progress-pairs">
            {stats.pairs.map((pair) => <PairChart key={`${pair.trackId}-${pair.carId}`} pair={pair} />)}
          </ul>
        </section>
      )}
    </Panel>
  );
}
