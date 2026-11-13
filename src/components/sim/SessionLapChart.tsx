import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { chartRows, isPitLap, plotRange, type ChartRow, type LapKind } from '@/lib/sim/session-stats';
import type { V1Lap } from '@/lib/sim/v1-client';

const COLORS: Record<LapKind, string> = { best: CHART_PALETTE.green, valid: CHART_PALETTE.yellow, invalid: 'hsl(var(--muted-foreground) / 0.55)' };
const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;

interface DotProps { cx?: number; cy?: number; index?: number; payload?: ChartRow & { plot: number; clamped: boolean } }

function Dot({ cx, cy, payload }: DotProps) {
  if (cx === undefined || cy === undefined || !payload) return null;
  const color = COLORS[payload.kind];
  return (
    <g data-testid="lap-dot" data-kind={payload.kind}>
      {/* A lap through the pits is a ring, so it reads differently from a flying lap. */}
      <circle cx={cx} cy={cy} r={payload.kind === 'best' ? 6 : 4.5} strokeWidth={2} style={{ fill: payload.pit ? 'hsl(var(--card))' : color, stroke: color }} />
      {payload.pit && (
        <text x={cx} y={cy + 19} textAnchor="middle" style={{ fontSize: 10, fontWeight: 600, fill: 'hsl(var(--muted-foreground))' }}>
          {/* A pit lap far slower than the rest is drawn at the top of the chart, with its time. */}
          {payload.pit === 'out' ? 'OUT' : 'IN'}{payload.clamped ? ` ${formatLapTime(payload.seconds * 1000)}` : ''}
        </text>
      )}
    </g>
  );
}

/** The lap times of a session in the order they were driven: valid laps in the accent colour, voided ones muted, the best highlighted, out and in laps marked. */
export function SessionLapChart({ laps, bestId }: { laps: readonly V1Lap[]; bestId: string | null }) {
  const { t } = useTranslation();
  const rows = useMemo(() => chartRows(laps, bestId), [laps, bestId]);
  const range = useMemo(() => (rows.length > 0 ? plotRange(rows) : { low: 0, high: 1 }), [rows]);
  const plotted = useMemo(() => {
    // A lap outside the range sits just inside its edge, so its dot is whole.
    const edge = (range.high - range.low) * 0.05;
    return rows.map((row) => ({
      ...row,
      plot: Math.max(range.low + edge, Math.min(row.seconds, range.high - edge)),
      clamped: row.seconds > range.high - edge || row.seconds < range.low + edge,
    }));
  }, [rows, range]);
  const best = rows.find((row) => row.kind === 'best');
  const label = t('modes.session.chartTitle', 'Lap times');
  const hasPit = laps.some(isPitLap);
  return (
    <div data-testid="session-chart">
      <div style={{ height: 220 }} role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={plotted} margin={{ top: 18, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="lap" tick={AXIS} allowDecimals={false} padding={{ left: 18, right: 36 }} />
            <YAxis tick={AXIS} width={58} domain={[range.low, range.high]} allowDataOverflow tickFormatter={(value: number) => formatLapTime(value * 1000).slice(0, -2)} />
            <Tooltip
              contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
              labelFormatter={(value) => t('modes.compare.lapN', 'Lap {{n}}', { n: value })}
              formatter={(_value: number, _name: string, item: { payload?: ChartRow }) => [formatLapTime((item.payload?.seconds ?? 0) * 1000), label]}
            />
            {best && <ReferenceLine y={best.seconds} stroke={CHART_PALETTE.green} strokeDasharray="4 4" />}
            <Line dataKey="plot" stroke="hsl(var(--muted-foreground) / 0.5)" strokeWidth={1.5} dot={<Dot />} activeDot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="chart-legend">
        <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.valid }} />{t('modes.session.legendValid', 'Valid lap')}</li>
        <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.best }} />{t('modes.session.legendBest', 'Best lap')}</li>
        <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.invalid }} />{t('modes.session.legendInvalid', 'Voided by the game')}</li>
        {hasPit && <li className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full border-2 border-muted-foreground" />{t('modes.session.legendPit', 'Out or in lap (through the pits)')}</li>}
      </ul>
    </div>
  );
}
