import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { FriendsScreen } from '@/components/social/FriendsScreen';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Friends: add by handle, requests, blocked. */
export default function SocialFriendsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader size="lg" title={t('social.nav.friends', 'Friends')} />
        <ExampleGate><FriendsScreen /></ExampleGate>
      </div>
    </AppLayout>
  );
}
