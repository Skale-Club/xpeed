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
  unit: DistanceUnit;
}

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const finite = (value: number) => (Number.isFinite(value) ? value : null);

function Chart({ title, data, unit, distance, series, height = 176, zero = false, digits = 0 }: {
  title: string;
  data: Array<Record<string, number | null>>;
  unit: string;
  /** The unit of the distance axis: m or ft. */
  distance: string;
  series: Array<{ key: string; color: string; dashed?: boolean; name: string }>;
  height?: number;
  zero?: boolean;
  digits?: number;
}) {
  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">
          {title} <span className="text-xs font-normal text-muted-foreground">({unit})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div style={{ height }} aria-label={title} role="img">
          <ResponsiveContainer width="100%" height="100%">
            {/* syncId: the cursor moves on every chart at once, so one distance can be read across all of them. */}
            <LineChart data={data} syncId="sim-lap" margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="d" type="number" domain={[0, 'dataMax']} tick={AXIS} tickFormatter={(v: number) => String(Math.round(v))} minTickGap={32} />
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
export function LapCharts({ grid, lap, reference, gap, unit }: Props) {
  const { t } = useTranslation();
  const rows = useMemo(() => {
    const speed = (ms: number) => finite(speedIn(ms, unit));
    return grid.map((d, i) => ({
      d: lengthIn(d, unit),
      speed: speed(lap.speed[i]),
      speedRef: reference ? speed(reference.speed[i]) : null,
      throttle: finite(lap.throttle[i] * 100),
      throttleRef: reference ? finite(reference.throttle[i] * 100) : null,
      brake: finite(lap.brake[i] * 100),
      brakeRef: reference ? finite(reference.brake[i] * 100) : null,
      gap: gap ? finite(gap[i]) : null,
    }));
  }, [grid, lap, reference, gap, unit]);

  const mine = { color: CHART_PALETTE.yellow, name: t('modes.compare.lap', 'Lap') };
  const other = { color: CHART_PALETTE.blue, name: t('modes.compare.reference', 'Reference'), dashed: true };
  const pair = (key: string) => [{ key, ...mine }, ...(reference ? [{ key: `${key}Ref`, ...other }] : [])];
  const distance = lengthLabel(unit);

  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="lap-charts">
      {gap && (
        <div className="lg:col-span-2">
          <Chart
            title={t('modes.compare.gapChart', 'Gap to the reference')}
            unit={t('modes.compare.seconds', 's')}
            distance={distance}
            data={rows}
            series={[{ key: 'gap', color: CHART_PALETTE.amber, name: t('modes.compare.gapChart', 'Gap to the reference') }]}
            zero
            digits={2}
          />
          <p className="mt-1 px-1 text-xs text-muted-foreground">
            {t('modes.compare.gapHint', 'Above zero, the lap is behind the reference at that point; below zero, ahead. Distance in {{unit}}.', { unit: distance })}
          </p>
        </div>
      )}
      <Chart title={t('modes.compare.speed', 'Speed')} unit={speedLabel(unit)} distance={distance} data={rows} series={pair('speed')} />
      <Chart title={t('modes.compare.throttle', 'Throttle')} unit="%" distance={distance} data={rows} series={pair('throttle')} />
      <Chart title={t('modes.compare.brake', 'Brake')} unit="%" distance={distance} data={rows} series={pair('brake')} />
    </div>
  );
}
