import { LayoutDashboard } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SimOverview } from '@/components/sim/SimOverview';

/** Virtual > Overview: the Companion connection, recent sessions, best laps and the games played. */
export default function SimOverviewPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.overview', 'Overview')}</h2>
        </div>
        <SimOverview />
      </div>
    </AppLayout>
  );
}
