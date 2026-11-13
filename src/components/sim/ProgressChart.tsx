import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { bestRange, formatTick, timeTicks, type ProgressRow } from '@/lib/sim/progress';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;

/**
 * Progress over the days: the fastest valid lap of each day as a line (a track page; the API gives none for a car) and how many laps
 * were driven each day as bars. Days are on a time axis, so a week with no driving is a gap, not a neighbour.
 */
export function ProgressChart({ rows, testId = 'progress-chart' }: { rows: readonly ProgressRow[]; testId?: string }) {
  const { t, i18n } = useTranslation();
  const range = useMemo(() => bestRange(rows), [rows]);
  const data = useMemo(() => rows.map((row) => ({ ...row })), [rows]);
  const showBest = range !== null;
  const axis = useMemo(() => (range ? timeTicks(range.low, range.high) : null), [range]);
  // The days are UTC dates: they are written as such, whatever the time zone of the person (a UTC midnight is the evening before in the Americas).
  const dayLabel = (ms: number, long = false) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', long ? { dateStyle: 'medium', timeZone: 'UTC' } : { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(ms);
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  };

  return (
    <Card className="bg-card border-border" data-testid={testId}>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">
          {showBest ? t('modes.progress.title', 'Progress') : t('modes.progress.lapsTitle', 'Laps per day')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="h-56 sm:h-64" role="img" aria-label={showBest ? t('modes.progress.title', 'Progress') : t('modes.progress.lapsTitle', 'Laps per day')}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="at" type="number" scale="time" domain={['dataMin', 'dataMax']} tick={AXIS} tickFormatter={(value: number) => dayLabel(value)} minTickGap={36} padding={{ left: 12, right: 12 }} />
              {showBest && range && axis && (
                <YAxis yAxisId="best" orientation="left" tick={AXIS} width={52} domain={[range.low, range.high]} ticks={axis.ticks} allowDataOverflow tickFormatter={(value: number) => formatTick(value, axis.step)} />
              )}
              <YAxis yAxisId="laps" orientation={showBest ? 'right' : 'left'} tick={AXIS} width={36} allowDecimals={false} domain={[0, 'dataMax']} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                labelFormatter={(value) => dayLabel(Number(value), true)}
                formatter={(value: number, name: string) => (name === 'bestS' ? [formatLapTime(value * 1000), t('modes.progress.bestPerDay', 'Best valid lap')] : [value, t('modes.progress.lapsPerDay', 'Laps')])}
              />
              <Bar yAxisId="laps" dataKey="laps" name="laps" fill={CHART_PALETTE.blue} fillOpacity={0.35} barSize={8} isAnimationActive={false} />
              {showBest && <Line yAxisId="best" dataKey="bestS" name="bestS" type="linear" stroke={CHART_PALETTE.yellow} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {showBest && (
            <li className="flex items-center gap-1.5"><span className="h-0.5 w-4" style={{ background: CHART_PALETTE.yellow }} aria-hidden />{t('modes.progress.bestPerDay', 'Best valid lap')}</li>
          )}
          <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm opacity-60" style={{ background: CHART_PALETTE.blue }} aria-hidden />{t('modes.progress.lapsPerDay', 'Laps')}</li>
        </ul>
      </CardContent>
    </Card>
  );
}
