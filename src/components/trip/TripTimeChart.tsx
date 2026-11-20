// One reading over the length of a trip (speed, engine temperature, battery
// charge). Loaded on its own through lazyChart: the chart library is large.

import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export interface TripTimeChartProps {
  data: { t: number; v: number }[];
  color: string;
  label: string;
  unit: string;
  /** A dashed line across the chart (an average, the warm temperature). */
  reference?: { value: number; label: string; color: string } | null;
  domain?: [number | 'auto', number | 'auto'];
  height?: number;
  digits?: number;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export default function TripTimeChart({ data, color, label, unit, reference, domain = [0, 'auto'], height = 200, digits = 0 }: TripTimeChartProps) {
  const gradient = `trip-fill-${useId().replace(/:/g, '')}`;
  return (
    <div style={{ height }} className="w-full" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="t" type="number" domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => `${Math.round(v / 60)}′`}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} minTickGap={24}
          />
          <YAxis
            domain={domain} width={44} tickCount={4} allowDecimals={false}
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false}
          />
          <Tooltip
            contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12, color: 'hsl(var(--foreground))' }}
            labelFormatter={(v) => clock(Number(v))}
            formatter={(v: number) => [`${v.toFixed(digits)} ${unit}`, label]}
          />
          {reference && (
            <ReferenceLine
              y={reference.value} stroke={reference.color} strokeDasharray="4 4" strokeOpacity={0.8}
              label={{ value: reference.label, position: 'insideTopRight', fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
            />
          )}
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${gradient})`} isAnimationActive={false} dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
