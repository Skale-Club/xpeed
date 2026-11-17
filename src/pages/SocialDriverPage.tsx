import { UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { DriverPage } from '@/components/social/DriverPage';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > a driver: the public profile, the friend relation, Report. */
export default function SocialDriverPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={UserRound} title={t('social.driver.title', 'Driver')} />
        <ExampleGate><DriverPage /></ExampleGate>
      </div>
    </AppLayout>
  );
}
