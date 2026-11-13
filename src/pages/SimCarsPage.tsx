import { CarFront } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SimCars } from '@/components/sim/SimCars';

/** Virtual > Game cars: the cars driven in each game. */
export default function SimCarsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <CarFront className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.cars', 'Game cars')}</h2>
        </div>
        <SimCars />
      </div>
    </AppLayout>
  );
}
