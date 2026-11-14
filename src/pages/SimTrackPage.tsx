import AppLayout from '@/components/AppLayout';
import { TrackPage } from '@/components/sim/TrackPage';

/**
 * Virtual > Tracks > one track: its dashboard (it has no menu entry of its own; Tracks stays highlighted). The page draws its own header: the name of
 * the track is the heading, with the way back above it.
 */
export default function SimTrackPage() {
  return (
    <AppLayout>
      <div className="max-w-7xl">
        <TrackPage />
      </div>
    </AppLayout>
  );
}
