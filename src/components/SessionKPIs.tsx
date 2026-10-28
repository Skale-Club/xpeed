import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, AlertCircle, CheckCircle, Clock, Hash, BarChart3 } from 'lucide-react';

interface SessionKPIProps {
  duration?: number | null;
  rowCount: number;
  parameterCount: number;
  attentionCount: number;
  criticalCount: number;
}

export default function SessionKPIs({ duration, rowCount, parameterCount, attentionCount, criticalCount }: SessionKPIProps) {
  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  const kpis = [
    { label: 'Duration', value: duration ? formatDuration(duration) : 'N/A', icon: Clock, color: 'text-primary' },
    { label: 'Samples', value: rowCount.toLocaleString(), icon: Hash, color: 'text-primary' },
    { label: 'Parameters', value: parameterCount.toString(), icon: BarChart3, color: 'text-primary' },
    {
      label: 'Attention',
      value: attentionCount.toString(),
      icon: AlertTriangle,
      color: attentionCount > 0 ? 'text-warn' : 'text-success',
    },
    {
      label: 'Critical',
      value: criticalCount.toString(),
      icon: AlertCircle,
      color: criticalCount > 0 ? 'text-destructive' : 'text-success',
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
      {kpis.map(kpi => (
        <Card key={kpi.label} className="bg-card border-border">
          <CardContent className="p-4 flex flex-col items-center gap-1">
            <kpi.icon className={`w-5 h-5 ${kpi.color}`} />
            <span className="text-2xl font-bold text-foreground">{kpi.value}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{kpi.label}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
