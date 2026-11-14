import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { lengthIn, lengthLabel, speedIn, speedLabel, type DistanceUnit } from '@/lib/sim/analysis';

type Channels = Record<string, number[]>;

interface Props {
  grid: number[];
  lap: Channels;
  reference: Channels | null;
  /** The gap of the lap against the reference at each point (seconds), when they can be compared. */
  gap: number[] | null;
  /** Metres from the game's ideal line at each point (+ = left of it), when the track's layout is known. */
  offset?: { lap: number[]; reference: number[] | null } | null;
  unit: DistanceUnit;
  /** The stretch of the lap being looked at (meters from the start line); the whole lap when null. The channels given are already that stretch. */
  range?: { fromM: number; toM: number } | null;
}

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const finite = (value: number) => (Number.isFinite(value) ? value : null);

function Chart({ title, data, unit, distance, series, height = 176, zero = false, digits = 0, domain }: {
  title: string;
  data: Array<Record<string, number | null>>;
  unit: string;
  /** The unit of the distance axis: m or ft. */
  distance: string;
  series: Array<{ key: string; color: string; dashed?: boolean; name: string }>;
  height?: number;
  zero?: boolean;
  digits?: number;
  domain: [number | string, number | string];
}) {
  const { t } = useTranslation();
  // What the chart says, in words, for a screen reader: where each line goes from and to.
  const summary = useMemo(
    () =>
      series
        .flatMap((line) => {
          const values = data.map((row) => row[line.key]).filter((value): value is number => typeof value === 'number');
          return values.length === 0
            ? []
            : [t('sessionsDash.compare.chartRange', '{{name}}: from {{low}} to {{high}}', { name: line.name, low: Math.min(...values).toFixed(digits), high: Math.max(...values).toFixed(digits) })];
        })
        .join('; '),
    [series, data, digits, t],
  );
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">
          {title} <span className="text-xs font-normal text-muted-foreground">({unit})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div style={{ height }} aria-label={summary ? `${title} (${unit}). ${summary}` : title} role="img">
          <ResponsiveContainer width="100%" height="100%">
            {/* syncId: the cursor moves on every chart at once, so one distance can be read across all of them. */}
            <LineChart data={data} syncId="sim-lap" margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="d" type="number" domain={domain} allowDataOverflow tick={AXIS} tickFormatter={(v: number) => String(Math.round(v))} minTickGap={32} />
              <YAxis tick={AXIS} width={44} tickFormatter={(v: number) => v.toFixed(digits)} />
              <Tooltip
                contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                labelFormatter={(value) => `${Math.round(Number(value))} ${distance}`}
                formatter={(value: number) => (Number.isFinite(value) ? value.toFixed(digits === 0 ? 1 : digits) : '–')}
              />
              {zero && <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />}
              {series.map((s) => (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeDasharray={s.dashed ? '6 4' : undefined}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

/** Speed, pedals and the gap along the lap, one chart each, all by distance. */
export function LapCharts({ grid, lap, reference, gap, offset, unit, range = null }: Props) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const speed = (ms: number) => finite(speedIn(ms, unit));
    const length = (m: number | undefined) => (m === undefined ? null : finite(lengthIn(m, unit)));
    return grid.map((d, i) => ({
      d: lengthIn(d, unit),
      speed: speed(lap.speed[i]),
      speedRef: reference ? speed(reference.speed[i]) : null,
      throttle: finite(lap.throttle[i] * 100),
      throttleRef: reference ? finite(reference.throttle[i] * 100) : null,
      brake: finite(lap.brake[i] * 100),
      brakeRef: reference ? finite(reference.brake[i] * 100) : null,
      gap: gap ? finite(gap[i]) : null,
      offset: offset ? length(offset.lap[i]) : null,
      offsetRef: offset?.reference ? length(offset.reference[i]) : null,
    }));
  }, [grid, lap, reference, gap, offset, unit]);

  const mine = { color: CHART_PALETTE.yellow, name: t('modes.compare.lap', 'Lap') };
  const other = { color: CHART_PALETTE.blue, name: t('modes.compare.reference', 'Reference'), dashed: true };
  const pair = (key: string) => [{ key, ...mine }, ...(reference ? [{ key: `${key}Ref`, ...other }] : [])];
  const distance = lengthLabel(unit);
  const domain: [number | string, number | string] = range ? [Math.round(lengthIn(range.fromM, unit)), Math.round(lengthIn(range.toM, unit))] : [0, 'dataMax'];

  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="lap-charts" data-range={range ? `${Math.round(range.fromM)}-${Math.round(range.toM)}` : undefined}>
      {gap && (
        <div className="lg:col-span-2">
          <Chart
            title={t('modes.compare.gapChart', 'Gap to the reference')}
            unit={t('modes.compare.seconds', 's')}
            distance={distance}
            data={rows} domain={domain}
            series={[{ key: 'gap', color: CHART_PALETTE.amber, name: t('modes.compare.gapChart', 'Gap to the reference') }]}
            zero
            digits={2}
          />
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            {t('modes.compare.gapHint', 'Above zero, the lap is behind the reference at that point; below zero, ahead. Distance in {{unit}}.', { unit: distance })}
          </p>
        </div>
      )}
      {offset && (
        <div className="lg:col-span-2" data-testid="offset-chart">
          <Chart
            title={t('modes.compare.offsetChart', 'Distance from the ideal line')}
            unit={distance}
            distance={distance}
            data={rows} domain={domain}
            series={[
              { key: 'offset', ...mine },
              ...(offset.reference ? [{ key: 'offsetRef', ...other }] : []),
            ]}
            zero
            digits={1}
          />
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            {t('modes.compare.offsetHint', 'Zero is the game’s ideal line. Above zero, the car was to its left; below, to its right.')}
          </p>
        </div>
      )}
      <Chart title={t('modes.compare.speed', 'Speed')} unit={speedLabel(unit)} distance={distance} data={rows} domain={domain} series={pair('speed')} />
      <Chart title={t('modes.compare.throttle', 'Throttle')} unit="%" distance={distance} data={rows} domain={domain} series={pair('throttle')} />
      <Chart title={t('modes.compare.brake', 'Brake')} unit="%" distance={distance} data={rows} domain={domain} series={pair('brake')} />
    </div>
  );
}
