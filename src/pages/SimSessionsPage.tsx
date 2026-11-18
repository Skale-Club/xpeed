import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SessionsList } from '@/components/sim/SessionsList';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Sessions: the sessions on the account. */
export default function SimSessionsPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={Timer} title={t('modes.nav.sessions', 'Sessions')} description={t('modes.sessions.intro', 'Your sessions, with the laps Xpeed Companion sent.')} />
        <SessionsList />
      </div>
    </AppLayout>
  );
}
