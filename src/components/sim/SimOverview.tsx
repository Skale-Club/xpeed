import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard } from 'lucide-react';
import { loadRange, saveRange } from '@/lib/sim/dashboard';
import { useOverview, useStats, useUserId, type StatsRange, type V1Overview, type V1Stats } from '@/lib/sim/v1-client';
import { QueryGate } from './SimStates';
import { WorkOnCard } from './WorkOnCard';
import { ActivityPanel } from './overview/Activity';
import { ConsistencyPanel } from './overview/Consistency';
import { CompanionBanner, RangeSelect } from './overview/Header';
import { KpiTiles } from './overview/KpiTiles';
import { BestsPanel, SessionsPanel } from './overview/Latest';
import { ProgressPanel } from './overview/Progress';
import { DashboardSkeleton, EmptyDashboard } from './overview/States';
import { WherePanel } from './overview/Where';

/** What is on screen once the numbers are in: the tiles, the activity, the progress with what to work on beside it, where you drive, the latest. */
function Dashboard({ stats, overview, refreshing }: { stats: V1Stats; overview: V1Overview; refreshing: boolean }) {
  return (
    <div className={`space-y-4 transition-opacity ${refreshing ? 'opacity-60' : ''}`} aria-busy={refreshing || undefined} data-testid="overview-dashboard">
      <KpiTiles stats={stats} />
      <ActivityPanel stats={stats} />
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8"><ProgressPanel stats={stats} /></div>
        <div className="min-w-0 space-y-4 lg:col-span-4">
          <WorkOnCard sessions={overview.latestSessions} />
          <ConsistencyPanel stats={stats} />
        </div>
      </div>
      <WherePanel stats={stats} />
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8"><SessionsPanel sessions={overview.latestSessions} /></div>
        <div className="min-w-0 lg:col-span-4"><BestsPanel bests={overview.latestPersonalBests} /></div>
      </div>
    </div>
  );
}

/**
 * Virtual > Overview: a racing dashboard. A header with the period (remembered per person) and the Companion's status; six tiles with their change
 * against the period before; the activity of the period and, from 90 days up, of the last 12 months; where you got faster; the best lap by track and car;
 * where you drive; how consistent you are; what to work on; the latest sessions and personal bests. The numbers come from one call per period
 * (GET /stats) and the Companion, sessions and bests from the overview call; no lap file is read except for "what to work on", after the page is up.
 */
export function SimOverview() {
  const { t } = useTranslation();
  const userId = useUserId();
  const [range, setRange] = useState<StatsRange>(() => loadRange(userId));
  useEffect(() => { setRange(loadRange(userId)); }, [userId]);
  const choose = (next: StatsRange) => {
    setRange(next);
    saveRange(userId, next);
  };

  const query = useOverview();
  const overview = query.data;
  const hasLaps = (overview?.lapsPerGame.length ?? 0) > 0;
  const statsQuery = useStats(range, { enabled: hasLaps });
  const paired = (overview?.companion.devices.length ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="overview">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h2 className="flex items-center gap-2 text-xl font-bold"><LayoutDashboard className="h-5 w-5 text-primary" aria-hidden="true" />{t('modes.nav.overview', 'Overview')}</h2>
          <div className="w-full sm:w-auto">
            <RangeSelect value={range} onChange={choose} busy={statsQuery.isFetching && statsQuery.isPlaceholderData} />
          </div>
        </div>
      </header>

      <QueryGate query={query} empty={false} skeleton={<DashboardSkeleton />}>
        {overview && (
          <>
            {!paired && <CompanionBanner />}
            {!hasLaps ? (
              <>
                <KpiTiles stats={null} />
                <EmptyDashboard />
              </>
            ) : (
              <QueryGate query={statsQuery} empty={false} skeleton={<DashboardSkeleton />}>
                {statsQuery.data && <Dashboard stats={statsQuery.data} overview={overview} refreshing={statsQuery.isPlaceholderData} />}
              </QueryGate>
            )}
          </>
        )}
      </QueryGate>
    </div>
  );
}
