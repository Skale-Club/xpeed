import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { FriendsScreen } from '@/components/social/FriendsScreen';

/** Virtual > Friends: add by handle, requests, blocked. */
export default function SocialFriendsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('social.nav.friends', 'Friends')}</h2>
        </div>
        <FriendsScreen />
      </div>
    </AppLayout>
  );
}
