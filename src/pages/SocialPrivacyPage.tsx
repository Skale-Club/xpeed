import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { PrivacyScreen } from '@/components/social/PrivacyScreen';

/** Virtual > Privacy: who can see the profile, download my data, delete my racing data. */
export default function SocialPrivacyPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('social.nav.privacy', 'Privacy')}</h2>
        </div>
        <PrivacyScreen />
      </div>
    </AppLayout>
  );
}
