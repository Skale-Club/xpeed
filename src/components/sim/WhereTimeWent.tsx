import { useTranslation } from 'react-i18next';
import { Loader2, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { DistanceUnit } from '@/lib/sim/analysis';
import { insightText } from '@/lib/sim/insight-text';
import type { Study } from '@/lib/sim/lap-study-client';
import type { LapStudy } from '@/lib/sim/lap-study-core';
import { cn } from '@/lib/utils';

const SEVERITY_DOT = { high: 'bg-destructive', medium: 'bg-amber-500', low: 'bg-muted-foreground' } as const;

/** The reason a pair of laps could not be put corner by corner, in words. */
export function WhyNotComparable({ reason }: { reason: 'length' | 'channels' | 'ok' }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground" data-testid="where-unavailable">
      {reason === 'length'
        ? t('modes.analysis.notComparableLength', 'These laps are not on the same track layout, so their corners cannot be compared.')
        : t('modes.analysis.notComparableChannels', 'These laps cannot be compared corner by corner.')}
    </p>
  );
}

/**
 * "Where the time went": the ranked findings of the corner analysis written as short sentences. Each sentence says only what the
 * data says (a cause that was not measured is not named), and a finding about a corner can be shown on the charts and the map.
 */
export function WhereTimeWent({ study, unit, onShowCorner }: { study: Study<LapStudy>; unit: DistanceUnit; onShowCorner?: (corner: number) => void }) {
  const { t } = useTranslation();
  return (
    <Card className="bg-card border-border" data-testid="where-time-went">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.analysis.whereTitle', 'Where the time went')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {study.status === 'loading' ? (
          <div className="space-y-2" role="status" aria-label={t('modes.analysis.working', 'Working out the corners…')} data-testid="where-loading">
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('modes.analysis.working', 'Working out the corners…')}
            </p>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        ) : study.status === 'error' ? (
          <p className="text-sm text-muted-foreground" data-testid="where-error">
            {t('modes.analysis.failed', 'The corner analysis could not be worked out for these laps.')}
          </p>
        ) : !study.value.comparison.comparable ? (
          <WhyNotComparable reason={study.value.comparison.reason} />
        ) : study.value.insights.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="where-none">
            {t('modes.analysis.whereNone', 'No corner or straight lost enough time to report. The lap is as quick as the reference where it counts.')}
          </p>
        ) : (
          <ol className="space-y-2" data-testid="where-list">
            {study.value.insights.map((insight, i) => {
              const missing = insight.corner !== null ? study.value.comparison.corners.find((c) => c.index === insight.corner)?.missing : undefined;
              const text = insightText(insight, { unit, missing });
              return (
                <li key={i} className="flex items-start gap-2 text-sm" data-testid="where-item" data-kind={insight.kind} data-severity={insight.severity}>
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[insight.severity])} aria-hidden />
                  <span className="min-w-0 flex-1">{t(text.key, text.values)}</span>
                  {onShowCorner && insight.corner !== null && (
                    <Button
                      type="button" size="icon" variant="ghost" className="h-6 w-6 shrink-0"
                      aria-label={t('modes.analysis.zoomTo', 'Zoom to corner {{corner}}', { corner: insight.corner })}
                      onClick={() => onShowCorner(insight.corner as number)}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
