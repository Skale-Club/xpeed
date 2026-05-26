import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Zap, Flame, Leaf, Settings2, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { EngineType } from '@/lib/db';
import type { Session, SessionSummaryItem } from '@/types/session';
import { ENGINE_TYPE_CONFIGS, resolveMetricValue } from '@/lib/dashboard-config';

interface AdaptiveMetricsSectionProps {
  engineType: EngineType | null | undefined;
  latestSession: Session | null;
  carId: string;
}

const ENGINE_ICONS: Record<EngineType, React.ElementType> = {
  hybrid: Leaf,
  electric: Zap,
  petrol: Flame,
  diesel: Settings2,
};

function formatValue(value: number, format?: 'integer' | 'decimal1'): string {
  if (format === 'decimal1') return value.toFixed(1);
  return Math.round(value).toLocaleString();
}

function getTone(value: number, metric: { warnAbove?: number; criticalAbove?: number; warnBelow?: number }): 'normal' | 'warn' | 'critical' {
  if (metric.criticalAbove !== undefined && value >= metric.criticalAbove) return 'critical';
  if (metric.warnAbove !== undefined && value >= metric.warnAbove) return 'warn';
  if (metric.warnBelow !== undefined && value <= metric.warnBelow) return 'warn';
  return 'normal';
}

export function AdaptiveMetricsSection({ engineType, latestSession, carId }: AdaptiveMetricsSectionProps) {
  const navigate = useNavigate();

  const cards = useMemo(() => {
    if (!engineType || !latestSession) return [];
    const config = ENGINE_TYPE_CONFIGS[engineType];
    if (!config) return [];
    const summaries: SessionSummaryItem[] = latestSession.summary?.summaries || [];

    return config.heroMetrics
      .map(metric => {
        const value = resolveMetricValue(summaries, metric.canonical_key, metric.valueType);
        if (value === null) return null;
        return { metric, value, tone: getTone(value, metric) };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);
  }, [engineType, latestSession]);

  if (!engineType) {
    return (
      <Card className="bg-card border-border border-dashed">
        <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 py-4 px-4">
          <div>
            <p className="text-sm font-mono font-semibold text-foreground">Engine type not set</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Set your vehicle's engine type to unlock adaptive dashboard metrics.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 text-xs gap-1.5"
            onClick={() => navigate('/cars')}
          >
            Complete Profile <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (cards.length === 0) return null;

  const config = ENGINE_TYPE_CONFIGS[engineType];
  const Icon = ENGINE_ICONS[engineType];

  return (
    <div className="space-y-2">
      <p className="text-xs font-mono text-muted-foreground flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        {config.label} — Key Metrics (Latest Session)
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {cards.map(({ metric, value, tone }) => (
          <Card
            key={metric.canonical_key}
            className={`bg-card border ${
              tone === 'critical' ? 'border-destructive/60' : tone === 'warn' ? 'border-yellow-500/50' : 'border-border'
            }`}
          >
            <CardContent className="px-3 py-2.5">
              <p className="text-[10px] text-muted-foreground font-mono truncate">{metric.label}</p>
              <p
                className={`text-xl font-bold font-mono mt-0.5 ${
                  tone === 'critical' ? 'text-destructive' : tone === 'warn' ? 'text-yellow-500' : 'text-foreground'
                }`}
              >
                {formatValue(value, metric.format)}
                <span className="text-xs font-normal text-muted-foreground ml-1">{metric.unit}</span>
              </p>
              <p className="text-[10px] text-muted-foreground/60 mt-0.5 capitalize">{metric.valueType}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
