import { useTranslation } from 'react-i18next';
import { Monitor, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { deviceState, type DeviceState } from '@/lib/sim/companion';
import type { V1Lap } from '@/lib/sim/v1-client';
import type { SimDevice } from '@/lib/sim/xpeed-sim-api';
import { cn } from '@/lib/utils';
import { useAge } from './use-age';
import { useWhen } from './use-when';

/** The state of a computer as a badge: a dot and a word (the colour is never the only sign). */
export function StateBadge({ state }: { state: DeviceState }) {
  const { t } = useTranslation();
  const label =
    state === 'online' ? t('communityDash.companion.online', 'Online')
    : state === 'revoked' ? t('modes.sim.revoked', 'Revoked')
    : t('communityDash.companion.offline', 'Offline');
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap" data-testid="device-state" data-state={state}>
      <span className={cn('h-2 w-2 rounded-full', state === 'online' ? 'bg-success' : state === 'revoked' ? 'bg-destructive/60' : 'bg-muted-foreground/50')} aria-hidden="true" />
      {label}
    </Badge>
  );
}

/**
 * One computer as a card: its name, Online or Offline (by when the server last heard from it), when it was connected, when it was last seen,
 * when it last sent a lap (and which, when it is the lap received most recently) and Revoke. A revoked computer has no button: it is history.
 */
export function DeviceCard({ device, lastLap, onRevoke, busy }: { device: SimDevice; lastLap: V1Lap | null; onRevoke?: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  const when = useWhen('short');
  const age = useAge();
  const state = deviceState(device);
  const ago = (iso: string) => age(Date.parse(iso));
  const detail = lastLap
    ? t('communityDash.companion.lapDetail', '{{track}} · {{car}} · {{time}}', { track: lastLap.track?.name ?? '–', car: lastLap.car?.name ?? '–', time: formatLapTime(lastLap.timeMs) })
    : null;
  return (
    <li data-testid="device" data-state={state}>
      <Card className={cn('flex h-full flex-col gap-3 bg-card p-4', state === 'revoked' && 'opacity-70')}>
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 font-semibold">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Monitor className="h-5 w-5" aria-hidden="true" /></span>
            <span className="truncate" data-testid="device-name">{device.name}</span>
          </p>
          <StateBadge state={state} />
        </div>
        <div className="grid gap-1 text-xs text-muted-foreground">
          <p data-testid="device-paired">{t('modes.sim.pairedOn', 'Connected {{date}}', { date: when(Date.parse(device.created_at)) })}</p>
          <p data-testid="device-seen" title={device.last_seen_at ? when(Date.parse(device.last_seen_at)) : undefined}>
            {device.last_seen_at ? t('modes.sim.lastSeen', 'Last seen {{date}}', { date: ago(device.last_seen_at) }) : t('modes.sim.neverSeen', 'Never seen')}
          </p>
          <p data-testid="device-last-lap" title={device.last_lap_at ? when(Date.parse(device.last_lap_at)) : undefined}>
            {device.last_lap_at ? t('modes.sim.lastLap', 'Last lap sent {{date}}', { date: ago(device.last_lap_at) }) : t('modes.sim.noLaps', 'No laps sent yet')}
          </p>
        </div>
        {detail && (
          <p className="rounded-md border border-border bg-background/50 px-2.5 py-1.5 text-xs" data-testid="device-lap-detail">
            <span className="block text-muted-foreground">{t('communityDash.companion.lastLapTitle', 'Last lap received')}</span>
            <span className="block truncate font-medium">{detail}</span>
          </p>
        )}
        {onRevoke && !device.revoked_at && (
          <div className="mt-auto">
            <Button type="button" variant="outline" size="sm" onClick={onRevoke} disabled={busy} aria-label={`${t('modes.sim.revoke', 'Revoke')} ${device.name}`} data-testid="device-revoke">
              <Unplug className="mr-1 h-4 w-4" />
              {t('modes.sim.revoke', 'Revoke')}
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}
