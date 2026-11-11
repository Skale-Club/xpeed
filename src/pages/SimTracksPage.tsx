import { Flag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { TracksList } from '@/components/sim/TracksList';

/** Virtual > Tracks: the track layouts kept on this device. */
export default function SimTracksPage() {
  const { t } = useTranslation();
  return (
    <AppLayout>
      <div className="max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <Flag className="h-5 w-5 text-primary" />
          <h2 className="text-xl font-bold">{t('modes.nav.tracks', 'Tracks')}</h2>
        </div>
        <TracksList />
      </div>
    </AppLayout>
  );
}
