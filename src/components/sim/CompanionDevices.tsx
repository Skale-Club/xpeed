import { useTranslation } from 'react-i18next';
import { Gamepad2, Monitor, Pause, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { deviceActivity, deviceState, updateAvailable, type DeviceState } from '@/lib/sim/companion';
import { useGames } from '@/lib/sim/games';
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
 * One computer as a card: its name, Online or Offline (by when the server last heard from it), what it is doing now (connected to a game, waiting
 * for one, reading paused) while it is online, the version of Xpeed Companion on it (with a gentle hint when a newer one is out), when it was
 * connected, when it was last seen, when it last sent a lap (and which, when it is the lap received most recently) and Revoke. A revoked computer
 * has no button: it is history. What the heartbeat says is shown only when the server gave it: an older server or Companion shows none of it.
 */
export function DeviceCard({ device, lastLap, onRevoke, busy, latestVersion }: { device: SimDevice; lastLap: V1Lap | null; onRevoke?: () => void; busy?: boolean; latestVersion?: string | null }) {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('short');
  const age = useAge();
  const state = deviceState(device);
  const activity = deviceActivity(device);
  const activityText = !activity ? null
    : activity.kind === 'connected' ? (activity.game ? t('communityDash.companion.connectedTo', 'Connected to {{game}}', { game: games.name(activity.game) }) : t('communityDash.companion.connectedGame', 'Connected to a game'))
    : activity.kind === 'waiting' ? t('communityDash.companion.waitingGame', 'Waiting for a game')
    : t('communityDash.companion.readingPaused', 'Reading paused');
  const version = device.companion_version || null;
  const outdated = !device.revoked_at && updateAvailable(version, latestVersion);
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
        {activity && activityText && (
          <p className="flex items-center gap-1.5 text-sm font-medium" data-testid="device-activity" data-activity={activity.kind}>
            {activity.kind === 'idle' ? <Pause className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : <Gamepad2 className={cn('h-4 w-4 shrink-0', activity.kind === 'connected' ? 'text-success' : 'text-muted-foreground')} aria-hidden="true" />}
            <span className="min-w-0 truncate">{activityText}</span>
          </p>
        )}
        <div className="grid gap-1 text-xs text-muted-foreground">
          {version && <p data-testid="device-version">{t('communityDash.companion.companionVersion', 'Xpeed Companion {{version}}', { version })}</p>}
          {outdated && latestVersion && <p data-testid="device-update">{t('communityDash.companion.updateAvailable', 'Update available: {{version}}. It installs by itself when no game is running.', { version: latestVersion })}</p>}
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
