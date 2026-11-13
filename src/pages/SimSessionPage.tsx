import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SessionPage } from '@/components/sim/SessionPage';

/** Virtual > Sessions > one session: its laps against each other (it has no menu entry of its own; Sessions stays highlighted). */
export default function SimSessionPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.session.title', 'Session')}</h2>
        </div>
        <SessionPage />
      </div>
    </AppLayout>
  );
}
