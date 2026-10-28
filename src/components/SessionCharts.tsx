import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { CANONICAL_PARAMS, PRIUS_PRIORITY_KEYS } from '@/lib/canonical-params';

interface ParameterChartProps {
  rows: { t_seconds?: number | null; data?: Record<string, unknown> | null }[];
  parameterKey: string;
  canonicalKey: string;
  label: string;
  unit: string;
  warnMax?: number | null;
  criticalMax?: number | null;
  warnMin?: number | null;
  criticalMin?: number | null;
}

const CHART_COLORS = [
  'hsl(174, 72%, 46%)',   // teal
  'hsl(210, 80%, 55%)',   // blue
  'hsl(152, 60%, 42%)',   // green
  'hsl(270, 60%, 60%)',   // purple
  'hsl(38, 92%, 55%)',    // amber
  'hsl(340, 70%, 55%)',   // pink
];

export function ParameterChart({
  rows, parameterKey, canonicalKey, label, unit,
  warnMax, criticalMax, warnMin, criticalMin,
}: ParameterChartProps) {
  const chartData = useMemo(() => {
    return rows
      .map((row, idx) => {
        const val = row.data?.[parameterKey];
        if (val === undefined || val === null) return null;
        return {
          x: row.t_seconds ?? idx,
          value: Number(val),
        };
      })
      .filter(Boolean) as { x: number; value: number }[];
  }, [rows, parameterKey]);

  if (chartData.length === 0) return null;

  const colorIdx = PRIUS_PRIORITY_KEYS.indexOf(canonicalKey);
  const color = CHART_COLORS[colorIdx >= 0 ? colorIdx % CHART_COLORS.length : 0];

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-2 px-4 pt-3">
        <CardTitle className="text-xs text-muted-foreground flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
          {label}
          {unit && <span className="text-muted-foreground/60">({unit})</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-2">
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
            <XAxis
              dataKey="x"
              tick={{ fontSize: 9, fill: 'hsl(215, 12%, 55%)' }}
              axisLine={{ stroke: 'hsl(220, 14%, 20%)' }}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 9, fill: 'hsl(215, 12%, 55%)' }}
              axisLine={{ stroke: 'hsl(220, 14%, 20%)' }}
              tickLine={false}
              width={40}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 13%)',
                border: '1px solid hsl(220, 14%, 20%)',
                borderRadius: '6px',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono',
                color: 'hsl(210, 20%, 90%)',
              }}
              labelFormatter={v => `t: ${Number(v).toFixed(1)}s`}
              formatter={(v: number) => [v.toFixed(2), label]}
            />
            {warnMax !== null && warnMax !== undefined && (
              <ReferenceLine y={warnMax} stroke="hsl(38, 92%, 55%)" strokeDasharray="4 4" strokeOpacity={0.6} />
            )}
            {criticalMax !== null && criticalMax !== undefined && (
              <ReferenceLine y={criticalMax} stroke="hsl(0, 72%, 55%)" strokeDasharray="4 4" strokeOpacity={0.6} />
            )}
            {warnMin !== null && warnMin !== undefined && (
              <ReferenceLine y={warnMin} stroke="hsl(38, 92%, 55%)" strokeDasharray="4 4" strokeOpacity={0.6} />
            )}
            {criticalMin !== null && criticalMin !== undefined && (
              <ReferenceLine y={criticalMin} stroke="hsl(0, 72%, 55%)" strokeDasharray="4 4" strokeOpacity={0.6} />
            )}
            <Line
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: color }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

interface SessionChartsProps {
  rows: { t_seconds?: number | null; data?: Record<string, unknown> | null }[];
  headerMapping: Record<string, { canonical_key: string; label: string; unit: string } | null>;
  rules?: { canonical_key: string; warn_max?: number | null; critical_max?: number | null; warn_min?: number | null; critical_min?: number | null }[];
}

export default function SessionCharts({ rows, headerMapping, rules }: SessionChartsProps) {
  const { t } = useTranslation();
  // Sort by Prius priority
  const sortedHeaders = useMemo(() => {
    return Object.entries(headerMapping)
      .filter(([key]) => {
        // Check if this parameter has any numeric data
        return rows.some(r => typeof r.data?.[key] === 'number');
      })
      .sort(([, a], [, b]) => {
        const aIdx = a ? PRIUS_PRIORITY_KEYS.indexOf(a.canonical_key) : 999;
        const bIdx = b ? PRIUS_PRIORITY_KEYS.indexOf(b.canonical_key) : 999;
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });
  }, [headerMapping, rows]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      {sortedHeaders.map(([key, mapping]) => {
        const ck = mapping?.canonical_key || key;
        const rule = rules?.find(r => r.canonical_key === ck);
        return (
          <ParameterChart
            key={key}
            rows={rows}
            parameterKey={key}
            canonicalKey={ck}
            label={mapping ? t(`params.${mapping.canonical_key}`, mapping.label) : key}
            unit={mapping?.unit || ''}
            warnMax={rule?.warn_max}
            criticalMax={rule?.critical_max}
            warnMin={rule?.warn_min}
            criticalMin={rule?.critical_min}
          />
        );
      })}
    </div>
  );
}
