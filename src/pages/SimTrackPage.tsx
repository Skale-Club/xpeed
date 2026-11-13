import { Flag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { TrackPage } from '@/components/sim/TrackPage';

/** Virtual > Tracks > one track: its progress and its best lap with each car (it has no menu entry of its own; Tracks stays highlighted). */
export default function SimTrackPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-5xl space-y-4">
        <div className="flex items-center gap-2">
          <Flag className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.trackPage.title', 'Track')}</h2>
        </div>
        <TrackPage />
      </div>
    </AppLayout>
  );
}
