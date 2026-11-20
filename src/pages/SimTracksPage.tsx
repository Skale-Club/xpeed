import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from '@/components/AppLayout';
import { TrackLayouts } from '@/components/sim/TrackLayouts';
import { TracksList } from '@/components/sim/TracksList';
import { PageHeader } from '@/components/ui/page-header';

/** Virtual > Tracks: the tracks driven, and (folded away) the track layouts kept on this device. */
export default function SimTracksPage() {
  const { t } = useTranslation();
  // The kept layouts copy the account's layouts onto the device when they open: only when the person asks to see them.
  const [open, setOpen] = useState(false);
  return (
    <AppLayout>
      <div className="space-y-4">
        <PageHeader size="lg" title={t('modes.nav.tracks', 'Tracks')} />
        <TracksList />
        <details className="rounded-lg border border-border p-3" data-testid="layouts-fold" onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm font-medium">{t('modes.tracks.layoutsFold', 'Track layouts kept on this device')}</summary>
          <div className="pt-3">{open && <TrackLayouts />}</div>
        </details>
      </div>
    </AppLayout>
  );
}
