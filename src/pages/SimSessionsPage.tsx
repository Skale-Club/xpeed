import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SessionsList } from '@/components/sim/SessionsList';

/** Virtual > Sessions: the sessions on the account. */
export default function SimSessionsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Timer className="h-5 w-5 text-primary" aria-hidden="true" />
            {t('modes.nav.sessions', 'Sessions')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('modes.sessions.intro', 'Your sessions, with the laps Xpeed Companion sent.')}</p>
        </div>
        <SessionsList />
      </div>
    </AppLayout>
  );
}
