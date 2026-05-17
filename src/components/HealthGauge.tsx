import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

interface HealthGaugeProps {
  score: number;        // 0..100
  status: 'Excellent' | 'Good' | 'Attention' | 'Critical';
  size?: number;        // px
}

const STATUS_COLOR: Record<HealthGaugeProps['status'], string> = {
  Excellent: '#10b981',
  Good:      '#10b981',
  Attention: '#f59e0b',
  Critical:  '#ef4444',
};

export default function HealthGauge({ score, status, size = 160 }: HealthGaugeProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const data = [
    { name: 'score',     value: clamped },
    { name: 'remaining', value: 100 - clamped },
  ];
  const color = STATUS_COLOR[status];

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            innerRadius="78%"
            outerRadius="100%"
            startAngle={210}
            endAngle={-30}
            dataKey="value"
            strokeWidth={0}
            isAnimationActive
          >
            <Cell fill={color} />
            <Cell fill="rgba(255,255,255,0.06)" />
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <div className="text-3xl font-mono font-bold tabular-nums" style={{ color }}>
          {clamped}
        </div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mt-0.5">
          {status}
        </div>
      </div>
    </div>
  );
}
