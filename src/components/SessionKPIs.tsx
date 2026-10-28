import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { AlertTriangle, AlertCircle, Clock, Hash, BarChart3 } from 'lucide-react';

interface SessionKPIProps {
  duration?: number | null;
  rowCount: number;
  parameterCount: number;
  attentionCount: number;
  criticalCount: number;
}

export default function SessionKPIs({ duration, rowCount, parameterCount, attentionCount, criticalCount }: SessionKPIProps) {
  const { t, i18n } = useTranslation();
  const number = (n: number) => new Intl.NumberFormat(i18n.resolvedLanguage || undefined).format(n);

  const formatDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    const [min, secs] = [t('trip.units.min', 'min'), t('trip.units.s', 's')];
    return m > 0 ? `${m} ${min} ${sec} ${secs}` : `${sec} ${secs}`;
  };

  const kpis = [
    { label: t('tripDetail.duration', 'Duration'), value: duration ? formatDuration(duration) : '—', icon: Clock, color: 'text-primary' },
    { label: t('tripDetail.samples', 'Readings'), value: number(rowCount), icon: Hash, color: 'text-primary' },
    { label: t('tripDetail.parameters', 'Sensors'), value: number(parameterCount), icon: BarChart3, color: 'text-primary' },
    {
      label: t('flags.attention', 'Attention'),
      value: number(attentionCount),
      icon: AlertTriangle,
      color: attentionCount > 0 ? 'text-warn' : 'text-success',
    },
    {
      label: t('flags.critical', 'Critical'),
      value: number(criticalCount),
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
            <span className="text-xs text-muted-foreground">{kpi.label}</span>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
