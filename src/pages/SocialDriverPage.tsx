import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { DriverPage } from '@/components/social/DriverPage';

/** Virtual > a driver: the public profile, the friend relation, Report. */
export default function SocialDriverPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <UserRound className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('social.driver.title', 'Driver')}</h2>
        </div>
        <DriverPage />
      </div>
    </AppLayout>
  );
}
