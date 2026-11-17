import { Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { LeaderboardScreen } from '@/components/social/LeaderboardScreen';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Leaderboards: the ranked best laps of a track and car, for everybody or for friends. */
export default function SocialLeaderboardsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={Trophy} title={t('social.nav.leaderboards', 'Leaderboards')} />
        <ExampleGate><LeaderboardScreen /></ExampleGate>
      </div>
    </AppLayout>
  );
}
