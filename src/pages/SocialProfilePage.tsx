import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { ProfileSettings } from '@/components/social/ProfileSettings';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Profile: handle, display name, who can see the profile, and the links shared. */
export default function SocialProfilePage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader size="lg" title={t('social.nav.profile', 'Profile')} />
        <ExampleGate><ProfileSettings /></ExampleGate>
      </div>
    </AppLayout>
  );
}
