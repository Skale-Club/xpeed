import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { activityOf, heatmapGrid, streakText, type HeatCell } from '@/lib/sim/dashboard';
import type { V1Stats } from '@/lib/sim/v1-client';
import { Panel, Quiet } from './parts';
import { useDashFormat } from './use-format';

const AXIS = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' } as const;
const TOOLTIP = { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 } as const;

/** The opacity of each heat level over the empty-cell colour: one hue, light to dark, so it reads the same in both themes. */
const HEAT_OPACITY = [0, 0.3, 0.5, 0.75, 1] as const;
const CELL = 11;
const GAP = 3;
const LABEL_H = 14;

/** The calendar of the last 12 months, weeks as columns, intensity by laps; hovering a day names it. The text alternative gives the totals. */
export function Heatmap({ days, today }: { days: ReadonlyArray<{ day: string; laps: number }>; today: string }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const grid = useMemo(() => heatmapGrid(days, today), [days, today]);
  const [hover, setHover] = useState<HeatCell | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // On a narrow screen the calendar scrolls sideways: start at the right, where the latest weeks are.
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [grid]);
  const width = grid.weeks.length * (CELL + GAP) - GAP;
  const height = LABEL_H + 7 * (CELL + GAP) - GAP;
  const describe = (cell: HeatCell) => t('modes.overview.dash.heatCell', '{{day}}: {{count}} laps', { day: format.day(cell.day, 'long'), count: cell.laps });
  const alt = grid.active === 0
    ? t('modes.overview.dash.heatAltNone', 'Calendar of the last 12 months: no laps.')
    : t('modes.overview.dash.heatAlt', 'Calendar of the last 12 months: {{count}} laps on {{days}} days.', { count: grid.total, days: grid.active });

  return (
    <div className="space-y-2" data-testid="heatmap">
      <div ref={scroller} className="overflow-x-auto pb-1" tabIndex={0} role="group" aria-label={alt}>
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block min-w-[640px] max-w-full" role="img" aria-label={alt} data-testid="heatmap-svg" style={{ width: '100%', height: 'auto' }}>
          {grid.months.map((month) => (
            <text key={`${month.year}-${month.month}`} x={month.col * (CELL + GAP)} y={10} fontSize={10} fill="hsl(var(--muted-foreground))">{format.month(month.month, month.year)}</text>
          ))}
          {grid.weeks.map((week, col) =>
            week.map((cell, row) =>
              cell ? (
                <rect
                  key={cell.day}
                  x={col * (CELL + GAP)}
                  y={LABEL_H + row * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  fill={cell.level === 0 ? 'hsl(var(--muted))' : CHART_PALETTE.blue}
                  fillOpacity={cell.level === 0 ? 1 : HEAT_OPACITY[cell.level]}
                  data-testid="heat-cell"
                  data-day={cell.day}
                  data-laps={cell.laps}
                  data-level={cell.level}
                  onMouseEnter={() => setHover(cell)}
                  onMouseLeave={() => setHover(null)}
                >
                  <title>{describe(cell)}</title>
                </rect>
              ) : null,
            ),
          )}
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span aria-live="polite" data-testid="heat-hover">{hover ? describe(hover) : ' '}</span>
        <span className="flex items-center gap-1" aria-hidden="true">
          {t('modes.overview.dash.heatLess', 'Less')}
          {HEAT_OPACITY.map((opacity, level) => (
            <span key={level} className="h-2.5 w-2.5 rounded-sm" style={{ background: level === 0 ? 'hsl(var(--muted))' : CHART_PALETTE.blue, opacity: level === 0 ? 1 : opacity }} />
          ))}
          {t('modes.overview.dash.heatMore', 'More')}
        </span>
      </div>
    </div>
  );
}

/** Activity: laps per day (per week for a long range), the streak and the best day, and, for 90 days and more, the calendar of the last 12 months. */
export function ActivityPanel({ stats }: { stats: V1Stats }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const activity = useMemo(() => activityOf(stats), [stats]);
  const streak = streakText(stats.streak);
  const data = useMemo(() => activity.points.map((point) => ({ ...point })), [activity]);
  const label = (point: { start: string; end: string }) => (point.start === point.end ? format.day(point.start, 'long') : `${format.day(point.start)} – ${format.day(point.end)}`);
  const title = activity.unit === 'week' ? t('modes.overview.dash.lapsPerWeek', 'Laps per week') : t('modes.overview.dash.lapsPerDay', 'Laps per day');
  const alt = activity.total === 0 || !activity.busiest
    ? t('modes.overview.dash.activityAltNone', '{{title}}: no laps in this period.', { title })
    : t('modes.overview.dash.activityAlt', '{{title}}: {{count}} laps over {{days}} days; most on {{day}} ({{top}}).', {
        title, count: activity.total, days: stats.range.days, day: label(activity.busiest), top: activity.busiest.laps,
      });

  return (
    <Panel title={t('modes.overview.dash.activity', 'Activity')} testId="overview-activity">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="activity-facts">
        <span data-testid="streak-current">{t(streak.current.key, streak.current.values)}</span>
        {streak.best && <span className="text-muted-foreground" data-testid="streak-best">{t(streak.best.key, streak.best.values)}</span>}
        {stats.streak.bestDay && (
          <span className="text-muted-foreground" data-testid="best-day">
            {t('modes.overview.dash.bestDay', 'Best day: {{day}}, {{count}} laps', { day: format.day(stats.streak.bestDay.day, 'long'), count: stats.streak.bestDay.laps })}
          </span>
        )}
      </div>

      {activity.total === 0 ? (
        <Quiet testId="activity-empty">{t('modes.overview.dash.activityEmpty', 'No laps in this period. Try a longer one.')}</Quiet>
      ) : (
        <div>
          <p className="mb-1 text-xs text-muted-foreground">{title}</p>
          <div className="h-40" role="img" aria-label={alt} data-testid="activity-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="start" tick={AXIS} tickFormatter={(value: string) => format.day(value)} interval="preserveStartEnd" minTickGap={28} tickLine={false} />
                <YAxis tick={AXIS} width={28} allowDecimals={false} domain={[0, (max: number) => Math.max(1, max)]} tickLine={false} axisLine={false} />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--muted) / 0.5)' }}
                  contentStyle={TOOLTIP}
                  labelFormatter={(_, payload) => (payload?.[0]?.payload ? label(payload[0].payload as { start: string; end: string }) : '')}
                  formatter={(value: number) => [value, t('modes.overview.dash.lapsName', 'Laps')]}
                />
                <Bar dataKey="laps" fill={CHART_PALETTE.blue} radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {stats.heatmapDays && (
        <div className="space-y-1 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">{t('modes.overview.dash.heatTitle', 'The last 12 months')}</p>
          <Heatmap days={stats.heatmapDays} today={stats.range.to} />
        </div>
      )}
    </Panel>
  );
}
