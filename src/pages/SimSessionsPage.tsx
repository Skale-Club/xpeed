import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SessionsList } from '@/components/sim/SessionsList';

/** Virtual > Sessions: the laps kept on this device, grouped into sessions. */
export default function SimSessionsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.sessions', 'Sessions')}</h2>
        </div>
        <SessionsList />
      </div>
    </AppLayout>
  );
}
