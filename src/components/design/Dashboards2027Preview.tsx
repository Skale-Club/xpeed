// /admin/design > Dashboards 2027: the new tiles, panels, header and chart look, drawn on a sample of the Virtual Overview, so the owner can
// approve them before any screen changes (owner study "Xpeed Painéis 2027", phase 1, 2026-11-20). Fake data only; nothing is fetched; the
// numbers echo the owner's own screenshot. Real and Virtual stay separate dashboards: this preview shows the Virtual one only, never a switch
// between modes, and nothing of the RC car (owner, 2026-11-20).
import {
  CalendarDays, Flag, Gamepad2, Route, Star, Timer,
  type LucideIcon,
} from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Area, Line, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { StatBento, StatTile } from '@/components/ui/stat-tile';
import { AreaGradient, AreaSparkline, ChartLegend } from '@/components/ui/chart-kit';
import { CHART_AXIS, CHART_BAR, CHART_GRID, CHART_LINE, CHART_TOOLTIP, GHOST_BAR, accentColor, type Accent } from '@/lib/chart-theme';

interface Tile {
  label: string; value: string; unit?: string; icon: LucideIcon; accent: Accent; spark: number[];
  trend?: { direction: 'up' | 'down' | 'flat'; text: string; label: string; meaning?: 'good' | 'bad' | 'neutral' };
  hint?: string;
}
interface Series { key: string; label: string; accent: Accent; area?: boolean; dashed?: boolean }
interface ChartBlock {
  title: string; description: string; icon: LucideIcon; accent: Accent; kind: 'bars' | 'lines';
  data: Array<Record<string, number | string>>; series: Series[]; unit: string;
  /** Bars: the one bar drawn in yellow (a record, the best day). Lines: the point marked as the record. */
  record?: { index: number; label: string };
  /** Where the value axis starts (a cut-off line, a speed from zero); automatic when left out. */
  yMin?: number;
}
interface Sample { eyebrow: string; title: string; summary: string; hero: Tile; tiles: Tile[]; main: ChartBlock; side: ChartBlock }

const days = ['Nov 14', 'Nov 15', 'Nov 16', 'Nov 17', 'Nov 18', 'Nov 19', 'Nov 20'];

const SAMPLE: Sample = {
    eyebrow: 'Overview · last 7 days', title: 'Overview', summary: '6 laps in 3 sessions and 4 personal bests. Best day: Nov 20, with 3 laps.',
    hero: { label: 'Laps', value: '6', icon: Flag, accent: 'blue', spark: [0, 0, 3, 0, 0, 0, 3], hint: '67% valid', trend: { direction: 'up', text: '500%', label: '500% more than the period before' } },
    tiles: [
      { label: 'Time driven', value: '11', unit: 'min', icon: Timer, accent: 'purple', spark: [0, 0, 5, 0, 0, 0, 6], trend: { direction: 'up', text: '327%', label: '327% more than the period before' } },
      { label: 'Distance', value: '21.9', unit: 'km', icon: Route, accent: 'green', spark: [0, 0, 10, 0, 0, 0, 12], hint: 'nothing before to compare' },
      { label: 'Sessions', value: '3', icon: Gamepad2, accent: 'sky', spark: [0, 0, 1, 0, 0, 0, 2], trend: { direction: 'up', text: '200%', label: '200% more than the period before' } },
      { label: 'Personal bests', value: '4', icon: Star, accent: 'yellow', spark: [0, 0, 1, 0, 0, 0, 3], hint: '2 today' },
    ],
    main: {
      title: 'Activity', description: 'Laps per day', icon: CalendarDays, accent: 'blue', kind: 'bars', unit: 'laps',
      data: days.map((day, i) => ({ day, laps: [0, 0, 3, 0, 0, 0, 3][i] })), series: [{ key: 'laps', label: 'Laps', accent: 'blue' }],
      record: { index: 6, label: 'Best day' },
    },
    side: {
      title: 'Lap time by track', description: 'Best lap of each session, seconds', icon: Timer, accent: 'pink', kind: 'lines', unit: 's',
      data: [1, 2, 3, 4, 5, 6].map((n, i) => ({ day: `S${n}`, laguna: [121.4, 120.2, 119.1, 118.6, 118.2, 117.8][i], boesel: [112.3, 111.0, 110.6, 110.1, 109.5, 109.0][i] })),
      series: [{ key: 'laguna', label: 'Laguna Seca', accent: 'pink' }, { key: 'boesel', label: 'Raul Boesel', accent: 'indigo' }],
    },
};

function TileOf({ tile, size, testId }: { tile: Tile; size: 'feature' | 'hero'; testId: string }) {
  return (
    <StatTile
      size={size}
      label={tile.label}
      value={tile.value}
      unit={tile.unit}
      icon={tile.icon}
      accent={tile.accent}
      hint={tile.hint}
      trend={tile.trend}
      testId={testId}
      footer={<AreaSparkline values={tile.spark} color={accentColor(tile.accent)} strong={size === 'hero'} className={size === 'hero' ? 'h-24' : 'h-7'} />}
    />
  );
}

function ChartOf({ block }: { block: ChartBlock }) {
  const legend = block.series.map((s) => ({ label: s.label, color: accentColor(s.accent), dashed: s.dashed }));
  // The record (best day, best lap) is the one yellow mark of a chart.
  if (block.record) legend.push({ label: block.record.label, color: accentColor('yellow'), dashed: false });
  const alt = `${block.title}: ${block.description}.`;
  return (
    <Panel variant="feature" title={block.title} description={block.description} icon={block.icon} accent={block.accent} action={<ChartLegend items={legend} />} testId={`d27-chart-${block.title}`}>
      <div className="h-60" role="img" aria-label={alt}>
        <ResponsiveContainer width="100%" height="100%">
          {block.kind === 'bars' ? (
            <BarChart data={block.data} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
              <CartesianGrid {...CHART_GRID} />
              <XAxis dataKey="day" {...CHART_AXIS} interval="preserveStartEnd" minTickGap={16} />
              <YAxis {...CHART_AXIS} width={44} allowDecimals={false} />
              <Tooltip {...CHART_TOOLTIP} formatter={(v: number) => [`${v} ${block.unit}`, block.series[0].label]} />
              <Bar dataKey={block.series[0].key} {...CHART_BAR} minPointSize={3}>
                {block.data.map((row, i) => {
                  const value = Number(row[block.series[0].key]);
                  const fill = i === block.record?.index ? accentColor('yellow') : value === 0 ? GHOST_BAR : accentColor(block.series[0].accent);
                  return <Cell key={String(row.day)} fill={fill} />;
                })}
              </Bar>
            </BarChart>
          ) : (
            <ComposedChart data={block.data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
              <defs>
                {block.series.filter((s) => s.area).map((s) => <AreaGradient key={s.key} id={`d27-${block.title}-${s.key}`.replace(/\W/g, '')} color={accentColor(s.accent)} />)}
              </defs>
              <CartesianGrid {...CHART_GRID} />
              <XAxis dataKey="day" {...CHART_AXIS} interval="preserveStartEnd" minTickGap={24} />
              <YAxis {...CHART_AXIS} width={44} domain={[block.yMin ?? 'auto', 'auto']} />
              <Tooltip {...CHART_TOOLTIP} />
              {block.series.map((s) => s.area ? (
                <Area key={s.key} dataKey={s.key} name={s.label} {...CHART_LINE} stroke={accentColor(s.accent)} fill={`url(#${`d27-${block.title}-${s.key}`.replace(/\W/g, '')})`} />
              ) : (
                <Line key={s.key} dataKey={s.key} name={s.label} {...CHART_LINE} stroke={accentColor(s.accent)} strokeDasharray={s.dashed ? '4 4' : undefined} strokeOpacity={s.dashed ? 0.8 : 1} />
              ))}
              {block.record && (
                <ReferenceDot x={String(block.data[block.record.index].day)} y={Number(block.data[block.record.index][block.series[0].key])} r={5} fill={accentColor('yellow')} stroke="hsl(var(--card))" strokeWidth={2.5} />
              )}
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/** The whole preview: the Virtual Overview drawn with the new header, tiles and panels. */
export default function Dashboards2027Preview() {
  const sample = SAMPLE;
  return (
    <div className="space-y-5 rounded-panel border border-border/70 bg-surface-inset p-4 shadow-card sm:p-7" data-testid="d27-preview">
      <PageHeader
        size="lg"
        eyebrow={sample.eyebrow}
        title={sample.title}
        description={sample.summary}
        actions={<SegmentedControl options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: 'all', label: 'All' }]} value="7" onChange={() => undefined} size="sm" aria-label="Sample period" />}
        testId="d27-header"
      />
      <StatBento testId="d27-bento">
        <TileOf tile={sample.hero} size="hero" testId="d27-hero" />
        {sample.tiles.map((tile, i) => <TileOf key={tile.label} tile={tile} size="feature" testId={`d27-tile-${i}`} />)}
      </StatBento>
      <div className="grid gap-3.5 lg:grid-cols-[1.7fr_1fr]">
        <div className="min-w-0"><ChartOf block={sample.main} /></div>
        <div className="min-w-0"><ChartOf block={sample.side} /></div>
      </div>
    </div>
  );
}
