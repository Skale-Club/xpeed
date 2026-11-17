import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { ExampleGate } from '@/components/sim/Example';
import { PrivacyScreen } from '@/components/social/PrivacyScreen';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Privacy: who can see the profile, download my data, delete my racing data. */
export default function SocialPrivacyPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader icon={ShieldCheck} title={t('social.nav.privacy', 'Privacy')} />
        <ExampleGate><PrivacyScreen /></ExampleGate>
      </div>
    </AppLayout>
  );
}
