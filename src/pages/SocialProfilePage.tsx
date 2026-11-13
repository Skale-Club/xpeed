import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ProfileSettings } from '@/components/social/ProfileSettings';

/** Virtual > Profile: handle, display name, who can see the profile, and the links shared. */
export default function SocialProfilePage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('social.nav.profile', 'Profile')}</h2>
        </div>
        <ProfileSettings />
      </div>
    </AppLayout>
  );
}
