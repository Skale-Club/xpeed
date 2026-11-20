import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { XpeedSimPanel } from '@/components/sim/XpeedSimPanel';
import { PhoneLiveCard } from '@/components/sim/live/PhoneLiveCard';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Xpeed Companion: connect the Windows program that reads your game, and manage the computers connected. */
export default function SimAppPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader size="lg" title={t('modes.nav.xpeedSim', 'Xpeed Companion')} />
        <ExampleGate><XpeedSimPanel /></ExampleGate>
        <PhoneLiveCard />
      </div>
    </AppLayout>
  );
}
