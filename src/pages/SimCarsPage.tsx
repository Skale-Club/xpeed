import { CarFront } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SimCars } from '@/components/sim/SimCars';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Game cars: the cars driven in each game. */
export default function SimCarsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={CarFront} title={t('modes.nav.cars', 'Game cars')} />
        <SimCars />
      </div>
    </AppLayout>
  );
}
