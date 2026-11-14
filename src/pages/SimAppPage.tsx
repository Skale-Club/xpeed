import { Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { XpeedSimPanel } from '@/components/sim/XpeedSimPanel';

/** Virtual > Xpeed Companion: connect the Windows program that reads your game, and manage the computers connected. */
export default function SimAppPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.xpeedSim', 'Xpeed Companion')}</h2>
        </div>
        <XpeedSimPanel />
      </div>
    </AppLayout>
  );
}
