import { Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { CollectorPanel } from '@/components/sim/CollectorPanel';

/** Virtual > Collector: connect the Windows program that reads your game, and manage the computers connected. */
export default function SimCollectorPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.collector', 'Collector')}</h2>
        </div>
        <CollectorPanel />
      </div>
    </AppLayout>
  );
}
