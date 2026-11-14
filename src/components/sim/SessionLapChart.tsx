import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { lapTrend } from '@/lib/sim/session-detail';
import { chartRows, isPitLap, plotRange, type ChartRow } from '@/lib/sim/session-stats';
import type { V1Lap } from '@/lib/sim/v1-client';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const VOID_PATTERN = 'session-void-hatch';

interface Plotted extends ChartRow { plot: number; clamped: boolean; trend: number | null }

/** The look of a bar: the best lap green, a valid lap blue, a lap through the pits the same but lighter with a dashed edge, a voided lap hatched grey. */
function barStyle(row: ChartRow): { fill: string; stroke: string; opacity: number; dash?: string } {
  if (row.kind === 'invalid') return { fill: `url(#${VOID_PATTERN})`, stroke: 'hsl(var(--muted-foreground) / 0.7)', opacity: 1 };
  const color = row.kind === 'best' ? CHART_PALETTE.green : CHART_PALETTE.blue;
  return row.pit ? { fill: color, stroke: color, opacity: 0.35, dash: '3 2' } : { fill: color, stroke: color, opacity: 1 };
}

/** What sits above a bar that is a pit lap (OUT or IN) and, when it is far slower than the rest and was cut off at the top, its real time. */
function BarLabel({ x, y, width, index, rows }: { x?: number; y?: number; width?: number; index?: number; rows: Plotted[] }) {
  const row = index === undefined ? undefined : rows[index];
  if (!row || !row.pit || x === undefined || y === undefined || width === undefined) return null;
  return (
    <text x={x + width / 2} y={y - (row.clamped ? 16 : 5)} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: 'hsl(var(--muted-foreground))' }} data-testid="bar-pit-label">
      <tspan x={x + width / 2}>{row.pit === 'out' ? 'OUT' : 'IN'}</tspan>
      {row.clamped && <tspan x={x + width / 2} dy={11}>{formatLapTime(row.seconds * 1000)}</tspan>}
    </text>
  );
}

function Swatch({ kind, label }: { kind: 'valid' | 'best' | 'void' | 'pit' | 'trend'; label: string }) {
  const style = {
    valid: { background: CHART_PALETTE.blue },
    best: { background: CHART_PALETTE.green },
    void: { background: 'repeating-linear-gradient(45deg, hsl(var(--muted-foreground) / 0.7) 0 2px, transparent 2px 4px)', border: '1px solid hsl(var(--muted-foreground) / 0.7)' },
    pit: { background: `${CHART_PALETTE.blue}59`, border: `1px dashed ${CHART_PALETTE.blue}` },
    trend: { background: CHART_PALETTE.amber, height: 2, borderRadius: 1, width: 14 },
  }[kind];
  return <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={style} aria-hidden="true" />{label}</li>;
}

/**
 * The lap times of a session in the order they were driven, one bar per lap: the best lap green and marked with a line, valid laps blue, voided laps hatched
 * grey, laps through the pits lighter with OUT or IN above them, a trend line through the flying laps (where the driving is heading), and a tooltip with the time and
 * the gap to the best lap. A click on a bar opens that lap's analysis; the table under the chart has the same link for each lap, for keyboard and screen readers.
 */
export function SessionLapChart({ laps, bestId, onOpenLap }: { laps: readonly V1Lap[]; bestId: string | null; onOpenLap?: (lapId: string) => void }) {
  const { t } = useTranslation();
  const rows = useMemo(() => chartRows(laps, bestId), [laps, bestId]);
  const range = useMemo(() => (rows.length > 0 ? plotRange(rows) : { low: 0, high: 1 }), [rows]);
  const trend = useMemo(() => lapTrend(rows), [rows]);
  const plotted = useMemo<Plotted[]>(() => {
    // A lap outside the range sits just inside its edge, so its bar is whole and its label has room.
    const edge = (range.high - range.low) * 0.05;
    return rows.map((row, i) => ({
      ...row,
      plot: Math.max(range.low + edge, Math.min(row.seconds, range.high - edge)),
      clamped: row.seconds > range.high - edge || row.seconds < range.low + edge,
      trend: trend?.values[i] ?? null,
    }));
  }, [rows, range, trend]);
  const best = rows.find((row) => row.kind === 'best');
  const hasPit = laps.some(isPitLap);
  const hasVoid = rows.some((row) => row.kind === 'invalid');
  const title = t('modes.session.chartTitle', 'Lap times');
  const flying = rows.filter((row) => row.kind !== 'invalid' && row.pit === null);
  const summary = best
    ? t('sessionsDash.session.chartSummary', {
        title, count: rows.length, n: best.lap, time: formatLapTime(best.seconds * 1000), slow: formatLapTime((flying.length > 0 ? Math.max(...flying.map((row) => row.seconds)) : best.seconds) * 1000),
        defaultValue_one: '{{title}}: {{count}} lap, the best, {{time}}. It has an Analyze link in the table below.',
        defaultValue_other: '{{title}}: {{count}} laps; the best is lap {{n}} in {{time}}; the slowest flying lap is {{slow}}. Each lap has an Analyze link in the table below.',
      })
    : t('sessionsDash.session.chartSummaryNoBest', {
        title, count: rows.length,
        defaultValue_one: '{{title}}: {{count}} lap, and it is not valid. It has an Analyze link in the table below.',
        defaultValue_other: '{{title}}: {{count}} laps, none of them valid. Each lap has an Analyze link in the table below.',
      });

  return (
    <div data-testid="session-chart">
      <div style={{ height: 240 }} role="img" aria-label={summary} data-testid="session-chart-plot">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={plotted} margin={{ top: 30, right: 10, bottom: 0, left: 0 }}>
            <defs>
              <pattern id={VOID_PATTERN} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="hsl(var(--muted-foreground) / 0.15)" />
                <rect width="2" height="6" fill="hsl(var(--muted-foreground) / 0.7)" />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="lap" tick={AXIS} allowDecimals={false} />
            <YAxis tick={AXIS} width={58} domain={[range.low, range.high]} allowDataOverflow tickFormatter={(value: number) => formatLapTime(value * 1000).slice(0, -2)} />
            <Tooltip
              cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
              labelFormatter={(value) => t('modes.compare.lapN', 'Lap {{n}}', { n: value })}
              formatter={(_value: number, _name: string, item: { payload?: ChartRow }) => {
                const row = item.payload;
                const gap = row && best && row.kind !== 'invalid' ? ` (${row.seconds >= best.seconds ? '+' : '-'}${Math.abs(row.seconds - best.seconds).toFixed(3)})` : '';
                return [`${formatLapTime((row?.seconds ?? 0) * 1000)}${gap}`, title];
              }}
            />
            {best && <ReferenceLine y={best.seconds} stroke={CHART_PALETTE.green} strokeDasharray="4 4" />}
            <Bar
              dataKey="plot"
              radius={[3, 3, 0, 0]}
              maxBarSize={44}
              isAnimationActive={false}
              cursor={onOpenLap ? 'pointer' : undefined}
              onClick={(data: { id?: string }) => data?.id && onOpenLap?.(data.id)}
              label={<BarLabel rows={plotted} />}
            >
              {plotted.map((row) => {
                const style = barStyle(row);
                return <Cell key={row.id} fill={style.fill} stroke={style.stroke} strokeDasharray={style.dash} fillOpacity={style.opacity} strokeWidth={1} data-testid="lap-bar" data-kind={row.kind} data-pit={row.pit ?? undefined} />;
              })}
            </Bar>
            {trend && <Line dataKey="trend" stroke={CHART_PALETTE.amber} strokeWidth={2} strokeDasharray="5 4" dot={false} activeDot={false} isAnimationActive={false} connectNulls={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="chart-legend">
        <Swatch kind="valid" label={t('modes.session.legendValid', 'Valid lap')} />
        <Swatch kind="best" label={t('modes.session.legendBest', 'Best lap')} />
        {hasVoid && <Swatch kind="void" label={t('modes.session.legendInvalid', 'Voided by the game')} />}
        {hasPit && <Swatch kind="pit" label={t('modes.session.legendPit', 'Out or in lap (through the pits)')} />}
        {trend && <Swatch kind="trend" label={trend.slope < -0.005 ? t('sessionsDash.session.trendFaster', 'Trend: getting faster') : trend.slope > 0.005 ? t('sessionsDash.session.trendSlower', 'Trend: getting slower') : t('sessionsDash.session.trendFlat', 'Trend: steady')} />}
      </ul>
      {onOpenLap && <p className="mt-1 text-xs text-muted-foreground">{t('sessionsDash.session.chartHint', 'Click a bar to open the analysis of that lap.')}</p>}
    </div>
  );
}
