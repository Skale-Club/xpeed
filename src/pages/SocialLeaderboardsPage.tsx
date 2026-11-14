import { Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { LeaderboardScreen } from '@/components/social/LeaderboardScreen';

/** Virtual > Leaderboards: the ranked best laps of a track and car, for everybody or for friends. */
export default function SocialLeaderboardsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('social.nav.leaderboards', 'Leaderboards')}</h2>
        </div>
        <LeaderboardScreen />
      </div>
    </AppLayout>
  );
}
