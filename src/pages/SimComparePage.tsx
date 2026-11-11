import { ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { LibraryCompare } from '@/components/sim/LibraryCompare';

/** Virtual > Compare laps: lap files opened in the browser, side by side. */
export default function SimComparePage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.compare', 'Compare laps')}</h2>
        </div>
        <LibraryCompare />
      </div>
    </AppLayout>
  );
}
