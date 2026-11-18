import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useIsMobile } from '@/hooks/use-mobile';
import { STATS_RANGES, type StatsRange } from '@/lib/sim/v1-client';

/** The period of the dashboard: the shared segmented control (a radio group: arrows move between the five, Tab goes past), full width on a phone. */
export function RangeSelect({ value, onChange, busy }: { value: StatsRange; onChange: (range: StatsRange) => void; busy?: boolean }) {
  const { t } = useTranslation();
  const mobile = useIsMobile();
  const labels: Record<StatsRange, string> = {
    '7d': t('modes.overview.dash.range7d', '7 days'),
    '30d': t('modes.overview.dash.range30d', '30 days'),
    '90d': t('modes.overview.dash.range90d', '90 days'),
    '1y': t('modes.overview.dash.range1y', '12 months'),
    all: t('modes.overview.dash.rangeAll', 'All'),
  };
  return (
    <SegmentedControl
      aria-label={t('modes.overview.dash.rangeLabel', 'Period')}
      options={STATS_RANGES.map((range) => ({ value: range, label: labels[range] }))}
      value={value}
      onChange={onChange}
      size="sm"
      fullWidth={mobile}
      busy={busy}
      testId="range-select"
      optionTestId={(range) => `range-${range}`}
    />
  );
}

/** With no computer paired: a compact invitation to get Xpeed Companion and connect it (the same two links as everywhere else). */
export function CompanionBanner() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2" data-testid="overview-companion">
      <p className="min-w-0 flex-1 text-sm text-muted-foreground">
        {t('modes.overview.connectBody', 'Connect Xpeed Companion on the computer you race on, and your laps arrive here by themselves.')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm">
          <Link to="/companion" data-testid="overview-download"><Download className="mr-2 h-4 w-4" />{t('modes.states.install', 'Get Xpeed Companion')}</Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to="/virtual/companion" data-testid="overview-connect">{t('modes.overview.connect', 'Connect Xpeed Companion')}</Link>
        </Button>
      </div>
    </div>
  );
}
