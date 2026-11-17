import { Timer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { SessionPage } from '@/components/sim/SessionPage';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Sessions > one session: its laps against each other (it has no menu entry of its own; Sessions stays highlighted). */
export default function SimSessionPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={Timer} title={t('modes.session.title', 'Session')} />
        <SessionPage />
      </div>
    </AppLayout>
  );
}
