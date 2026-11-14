import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { progressShape } from '@/lib/sim/garage';
import { bestRange, formatTick, timeTicks, type ProgressRow } from '@/lib/sim/progress';
import { Panel, Quiet } from './overview/parts';
import { useDashFormat } from './overview/use-format';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const TOOLTIP = { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 } as const;

/**
 * Progress over the days: the fastest valid lap of each day as a line and how many laps were driven each day as bars. Days are on a time axis, so a
 * week with no driving is a gap, not a neighbour. One day is a number, not a chart (a line needs two points), and a stretch with no valid lap has
 * bars only, and says so. The chart has a sentence for the screen reader, written from the same numbers.
 */
export function ProgressChart({ rows, testId = 'progress-chart', controls, title, note }: { rows: readonly ProgressRow[]; testId?: string; controls?: ReactNode; title?: string; note?: ReactNode }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const shape = useMemo(() => progressShape(rows), [rows]);
  const range = useMemo(() => bestRange(rows), [rows]);
  const data = useMemo(() => rows.map((row) => ({ ...row })), [rows]);
  const axis = useMemo(() => (range ? timeTicks(range.low, range.high) : null), [range]);
  const showBest = range !== null;
  const heading = title ?? (showBest ? t('modes.progress.title', 'Progress') : t('modes.progress.lapsTitle', 'Laps per day'));
  const totalLaps = rows.reduce((total, row) => total + row.laps, 0);
  const { first, last, best } = shape;

  // The sentence both the eye and the screen reader get: what the line says (or, with no valid lap, what the bars say).
  const summary =
    first && last && best && shape.bestPoints > 1
      ? t('garageDash.chartAlt', 'Best valid lap per day, from {{first}} on {{firstDay}} to {{last}} on {{lastDay}}; the fastest is {{best}}. {{laps}} laps on {{days}} days.', {
          first: formatLapTime((first.bestS as number) * 1000), firstDay: format.day(first.day), last: formatLapTime((last.bestS as number) * 1000), lastDay: format.day(last.day),
          best: formatLapTime((best.bestS as number) * 1000), laps: totalLaps, days: shape.days,
        })
      : t('garageDash.chartAltLaps', 'Laps per day: {{laps}} laps on {{days}} days.', { laps: totalLaps, days: shape.days });
  const gain = first && last && shape.bestPoints > 1 ? (first.bestS as number) - (last.bestS as number) : 0;

  return (
    <Panel title={heading} action={controls} testId={testId}>
      {shape.days < 2 ? (
        <div className="space-y-1" data-testid={`${testId}-single`}>
          <Quiet>{t('garageDash.oneDay', 'Only one day of driving so far. The progress line shows once you have driven on two different days.')}</Quiet>
          {best ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('modes.progress.bestPerDay', 'Best valid lap')}: </span>
              <span className="font-mono font-semibold tabular-nums">{formatLapTime((best.bestS as number) * 1000)}</span>
              <span className="text-muted-foreground"> · {format.day(best.day, 'long')}</span>
            </p>
          ) : totalLaps > 0 ? (
            <Quiet testId={`${testId}-no-valid`}>{t('garageDash.noValidDay', 'No valid lap yet, so there is no best-lap line.')}</Quiet>
          ) : null}
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-summary`}>
            {showBest && best ? (
              <>
                {t('garageDash.bestSoFar', 'Best {{best}}', { best: formatLapTime((best.bestS as number) * 1000) })}
                {gain > 0.0005 && <> · <span className="text-success">{t('garageDash.gainSince', '{{seconds}} s faster since {{day}}', { seconds: gain.toFixed(3), day: format.day((first as ProgressRow).day) })}</span></>}
                {' · '}
              </>
            ) : null}
            {t('garageDash.lapsOnDays', '{{laps}} laps on {{days}} days', { laps: totalLaps, days: shape.days })}
          </p>
          <div className="h-56 sm:h-64" role="img" aria-label={summary} data-testid={`${testId}-chart`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS} tickFormatter={(value: number) => format.day(new Date(value).toISOString().slice(0, 10))} minTickGap={36} padding={{ left: 12, right: 12 }} />
                {showBest && range && axis && (
                  <YAxis yAxisId="best" orientation="left" tick={AXIS} width={52} domain={[range.low, range.high]} ticks={axis.ticks} allowDataOverflow tickFormatter={(value: number) => formatTick(value, axis.step)} />
                )}
                <YAxis yAxisId="laps" orientation={showBest ? 'right' : 'left'} tick={AXIS} width={36} allowDecimals={false} domain={[0, 'dataMax']} />
                <Tooltip
                  contentStyle={TOOLTIP}
                  labelFormatter={(value) => format.day(new Date(Number(value)).toISOString().slice(0, 10), 'long')}
                  formatter={(value: number, name: string) => (name === 'bestS' ? [formatLapTime(value * 1000), t('modes.progress.bestPerDay', 'Best valid lap')] : [value, t('modes.progress.lapsPerDay', 'Laps')])}
                />
                <Bar yAxisId="laps" dataKey="laps" name="laps" fill={CHART_PALETTE.blue} fillOpacity={0.35} barSize={8} isAnimationActive={false} />
                {showBest && <Line yAxisId="best" dataKey="bestS" name="bestS" type="linear" stroke={CHART_PALETTE.yellow} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {showBest && (
              <li className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: CHART_PALETTE.yellow }} aria-hidden="true" />{t('modes.progress.bestPerDay', 'Best valid lap')}</li>
            )}
            <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm opacity-60" style={{ background: CHART_PALETTE.blue }} aria-hidden="true" />{t('modes.progress.lapsPerDay', 'Laps')}</li>
          </ul>
          {!showBest && <Quiet testId={`${testId}-no-valid`}>{t('garageDash.noValidDay', 'No valid lap yet, so there is no best-lap line.')}</Quiet>}
        </>
      )}
      {note}
    </Panel>
  );
}
