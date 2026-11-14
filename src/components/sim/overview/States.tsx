import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Stands in for the whole dashboard while the first read runs: the same blocks, in the same places, so nothing jumps when the numbers arrive. */
export function DashboardSkeleton() {
  const { t } = useTranslation();
  const block = (height: string, testId?: string) => (
    <Card className="space-y-3 bg-card p-4" data-testid={testId}>
      <Skeleton className="h-4 w-32" />
      <Skeleton className={`${height} w-full`} />
    </Card>
  );
  return (
    <div className="space-y-4" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="overview-skeleton">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i} className="space-y-2 bg-card p-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-7 w-full" />
          </Card>
        ))}
      </div>
      {block('h-40', 'skeleton-activity')}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">{block('h-72', 'skeleton-progress')}</div>
        <div className="min-w-0 space-y-4 lg:col-span-4">{block('h-24')}{block('h-28')}</div>
      </div>
      {block('h-28', 'skeleton-where')}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">{block('h-36')}</div>
        <div className="min-w-0 lg:col-span-4">{block('h-36')}</div>
      </div>
    </div>
  );
}

/** An account with no laps at all: what will appear here, in one friendly panel (the tiles above show dashes, not zeros). */
export function EmptyDashboard() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-5" data-testid="overview-empty">
      <h3 className="text-base font-semibold">{t('modes.overview.dash.emptyTitle', 'Your dashboard fills in as you drive')}</h3>
      <p className="text-sm text-muted-foreground">
        {t('modes.overview.dash.emptyBody', 'Once Xpeed Companion sends your first laps, this page shows how much you drive, where you got faster, your best laps by track and car, how consistent you are and what to work on.')}
      </p>
    </div>
  );
}
