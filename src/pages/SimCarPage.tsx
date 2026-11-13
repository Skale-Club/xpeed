import { CarFront } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { CarPage } from '@/components/sim/CarPage';

/** Virtual > Game cars > one car: its best lap on each track and its latest sessions (it has no menu entry of its own; Game cars stays highlighted). */
export default function SimCarPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <CarFront className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.carPage.title', 'Car')}</h2>
        </div>
        <CarPage />
      </div>
    </AppLayout>
  );
}
