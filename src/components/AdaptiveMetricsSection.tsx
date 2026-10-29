import { temperatureValue, temperatureLabel } from '@/lib/temperature';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Zap, Flame, Leaf, Settings2, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '@/contexts/SettingsContext';
import type { EngineType } from '@/lib/db';
import type { Session, SessionSummaryItem } from '@/types/session';
import { ENGINE_TYPE_CONFIGS, resolveMetricValue } from '@/lib/dashboard-config';

interface AdaptiveMetricsSectionProps {
  engineType: EngineType | null | undefined;
  latestSession: Session | null;
}

const ENGINE_ICONS: Record<EngineType, React.ElementType> = {
  hybrid: Leaf,
  electric: Zap,
  petrol: Flame,
  flex: Flame,
  diesel: Settings2,
};

function getTone(value: number, metric: { warnAbove?: number; criticalAbove?: number; warnBelow?: number }): 'normal' | 'warn' | 'critical' {
  if (metric.criticalAbove !== undefined && value >= metric.criticalAbove) return 'critical';
  if (metric.warnAbove !== undefined && value >= metric.warnAbove) return 'warn';
  if (metric.warnBelow !== undefined && value <= metric.warnBelow) return 'warn';
  return 'normal';
}

/** The key readings of the latest trip, for the car's kind of engine. */
export function AdaptiveMetricsSection({ engineType, latestSession }: AdaptiveMetricsSectionProps) {
  const { t, i18n } = useTranslation();
  const { distanceUnit, temperatureUnit } = useSettings();
  const navigate = useNavigate();
  const language = i18n.resolvedLanguage || undefined;

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
            <p className="text-sm font-semibold text-foreground">{t('dashboard.engineNotSet', 'Fuel type not set')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('dashboard.engineNotSetHint', 'Tell us what fuel your car uses to see its key readings here.')}
            </p>
          </div>
          <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => navigate('/cars')}>
            {t('dashboard.completeCar', 'Edit my car')} <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (cards.length === 0) return null;

  const Icon = ENGINE_ICONS[engineType];

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Icon className="w-3.5 h-3.5" />
        {t('dashboard.keyReadings', '{{engine}} — key readings (latest trip)', { engine: t(`vehicle.fuelType.${engineType}`, engineType) })}
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {cards.map(({ metric, value, tone }) => {
          const isSpeed = metric.canonical_key === 'vehicle_speed';
          const shown = isSpeed && distanceUnit === 'mi' ? value * 0.621371 : temperatureValue(value, metric.unit, temperatureUnit);
          const unit = isSpeed ? (distanceUnit === 'mi' ? 'mph' : 'km/h') : temperatureLabel(metric.unit, temperatureUnit);
          const text = new Intl.NumberFormat(language, metric.format === 'decimal1'
            ? { minimumFractionDigits: 1, maximumFractionDigits: 1 }
            : { maximumFractionDigits: 0 }).format(shown);
          return (
            <Card
              key={metric.canonical_key}
              className={`bg-card border ${
                tone === 'critical' ? 'border-destructive/60' : tone === 'warn' ? 'border-yellow-500/50' : 'border-border'
              }`}
            >
              <CardContent className="px-3 py-2.5">
                <p className="text-xs text-muted-foreground truncate">{t(`dashboard.metric.${metric.canonical_key}`, metric.label)}</p>
                <p
                  className={`text-xl font-bold mt-0.5 ${
                    tone === 'critical' ? 'text-destructive' : tone === 'warn' ? 'text-yellow-500' : 'text-foreground'
                  }`}
                >
                  {text}
                  <span className="text-xs font-normal text-muted-foreground ml-1">{unit}</span>
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">{t(`dashboard.valueType.${metric.valueType}`, metric.valueType)}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
