import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Gamepad2, Monitor, Pause, TriangleAlert, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { deviceActivity, deviceProblems, deviceState, FAMILY_NAMES, updateAvailable, type DeviceProblem, type DeviceState } from '@/lib/sim/companion';
import { setupText } from '@/lib/sim/game-setup';
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
    : state === 'revoked' ? t('modes.sim.revoked', 'Disconnected')
    : t('communityDash.companion.offline', 'Offline');
  return (
    <Badge variant="outline" className="gap-1.5 whitespace-nowrap" data-testid="device-state" data-state={state}>
      <span className={cn('h-2 w-2 rounded-full', state === 'online' ? 'bg-success' : state === 'revoked' ? 'bg-destructive/60' : 'bg-muted-foreground/50')} aria-hidden="true" />
      {label}
    </Badge>
  );
}

const PART_KEYS: Record<string, [string, string]> = {
  tracks: ['communityDash.companion.partTracks', 'track maps'],
  uploader: ['communityDash.companion.partUploader', 'sending laps'],
  heartbeat: ['communityDash.companion.partHeartbeat', 'status reports'],
  updater: ['communityDash.companion.partUpdater', 'update checks'],
};

/** One line for something wrong on a computer (laps that could not be saved or sent, a reader that stopped), in the person's language. */
export function problemText(t: TFunction, problem: DeviceProblem): string {
  if (problem.kind === 'save_failed') return t('communityDash.companion.saveFailed', { count: problem.count, defaultValue_one: '{{count}} lap could not be saved on this computer', defaultValue_other: '{{count}} laps could not be saved on this computer' });
  if (problem.kind === 'rejected') return t('communityDash.companion.rejected', { count: problem.count, defaultValue_one: '{{count}} lap could not be sent', defaultValue_other: '{{count}} laps could not be sent' });
  const failed = problem.kind === 'worker_failed';
  const names = problem.ids.map((id) => {
    const game = FAMILY_NAMES[id];
    if (game) return { game: true, name: game };
    const part = PART_KEYS[id] ?? ['communityDash.companion.partOther', 'a background part'];
    return { game: false, name: t(part[0], part[1]) };
  });
  const games = names.filter((n) => n.game).map((n) => n.name);
  const parts = names.filter((n) => !n.game).map((n) => n.name);
  const lines: string[] = [];
  if (games.length) lines.push(failed ? t('communityDash.companion.workerFailedGame', 'Reading {{name}} stopped after errors', { name: games.join(', ') }) : t('communityDash.companion.workerRestartingGame', 'Reading {{name}} is starting again after an error', { name: games.join(', ') }));
  if (parts.length) lines.push(failed ? t('communityDash.companion.workerFailedPart', 'Stopped after errors: {{name}}', { name: parts.join(', ') }) : t('communityDash.companion.workerRestartingPart', 'Starting again after an error: {{name}}', { name: parts.join(', ') }));
  return lines.join(' · ');
}

/**
 * One computer as a compact card: its name and Online or Offline (by when the server last heard from it); one line of state (what it is doing now
 * while it is online: connected to a game, waiting for one, reading paused; when it was last seen otherwise); the version of Xpeed Companion on it
 * (with a gentle hint when a newer one is out); ONE line for its last lap (the lap itself when it is the one received most recently, and when it
 * arrived); and a quiet Disconnect. A disconnected computer has no button: it is history. What the heartbeat says is shown only when the server
 * gave it: an older server or Companion shows none of it.
 */
export function DeviceCard({ device, lastLap, onRevoke, busy, latestVersion }: { device: SimDevice; lastLap: V1Lap | null; onRevoke?: () => void; busy?: boolean; latestVersion?: string | null }) {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('short');
  const age = useAge();
  const state = deviceState(device);
  const activity = deviceActivity(device);
  const needsSetup = activity?.kind === 'needs_setup' ? activity : null;
  const how = needsSetup?.game ? setupText(t, needsSetup.game) : null;
  const activityText = !activity ? null
    : activity.kind === 'needs_setup' ? (needsSetup?.game
      ? (how ? t('communityDash.companion.needsSetup', '{{game}} is open but not sending data: {{how}}.', { game: games.name(needsSetup.game), how }) : t('communityDash.companion.needsSetupNoHow', '{{game}} is open but not sending data', { game: games.name(needsSetup.game) }))
      : t('communityDash.companion.needsSetupGame', 'A game is open but not sending data'))
    : activity.kind === 'connected' ? (activity.game ? t('communityDash.companion.connectedTo', 'Connected to {{game}}', { game: games.name(activity.game) }) : t('communityDash.companion.connectedGame', 'Connected to a game'))
    : activity.kind === 'waiting' ? t('communityDash.companion.waitingGame', 'Waiting for a game')
    : t('communityDash.companion.readingPaused', 'Reading paused');
  const problems = deviceProblems(device);
  const version = device.companion_version || null;
  const outdated = !device.revoked_at && updateAvailable(version, latestVersion);
  const ago = (iso: string) => age(Date.parse(iso));
  const detail = lastLap
    ? t('communityDash.companion.lapDetail', '{{track}} · {{car}} · {{time}}', { track: lastLap.track?.name ?? '–', car: lastLap.car?.name ?? '–', time: formatLapTime(lastLap.timeMs) })
    : null;
  const lapWhat = [detail, device.last_lap_at ? ago(device.last_lap_at) : null].filter(Boolean).join(' · ');
  return (
    <li data-testid="device" data-state={state}>
      <Card className={cn('flex h-full flex-col gap-2 bg-card p-4', state === 'revoked' && 'opacity-70')}>
        <div className="flex items-start justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 font-semibold">
            <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate" data-testid="device-name">{device.name}</span>
          </p>
          <StateBadge state={state} />
        </div>
        {activity && activityText ? (
          <p className={cn('flex gap-1.5 text-sm', activity.kind === 'needs_setup' ? 'items-start' : 'items-center')} data-testid="device-activity" data-activity={activity.kind}>
            {activity.kind === 'idle' ? <Pause className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : activity.kind === 'needs_setup' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" /> : <Gamepad2 className={cn('h-4 w-4 shrink-0', activity.kind === 'connected' ? 'text-success' : 'text-muted-foreground')} aria-hidden="true" />}
            <span className={cn('min-w-0', activity.kind === 'needs_setup' ? 'break-words' : 'truncate')}>{activityText}</span>
          </p>
        ) : state !== 'online' && (
          <p className="text-sm text-muted-foreground" data-testid="device-seen" title={device.last_seen_at ? when(Date.parse(device.last_seen_at)) : undefined}>
            {device.last_seen_at ? t('modes.sim.lastSeen', 'Last seen {{date}}', { date: ago(device.last_seen_at) }) : t('modes.sim.neverSeen', 'Never seen')}
          </p>
        )}
        {problems.map((problem) => (
          <p key={problem.kind} className="flex items-start gap-1.5 text-sm" data-testid="device-problem" data-problem={problem.kind}>
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span className="min-w-0 break-words">{problemText(t, problem)}</span>
          </p>
        ))}
        <p className="text-sm text-muted-foreground" data-testid="device-last-lap" title={device.last_lap_at ? when(Date.parse(device.last_lap_at)) : undefined}>
          {lapWhat ? t('communityDash.companion.lastLapLine', 'Last lap: {{what}}', { what: lapWhat }) : t('modes.sim.noLaps', 'No laps sent yet')}
        </p>
        {(version || outdated) && (
          <div className="grid gap-0.5 text-xs text-muted-foreground">
            {version && <p data-testid="device-version">{t('companionSite.version', 'Version {{version}}', { version })}</p>}
            {outdated && latestVersion && <p data-testid="device-update">{t('communityDash.companion.updateAvailable', 'Update available: {{version}}. It installs by itself.', { version: latestVersion })}</p>}
          </div>
        )}
        {onRevoke && !device.revoked_at && (
          <div className="mt-auto pt-1">
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={onRevoke} disabled={busy} aria-label={`${t('modes.sim.revoke', 'Disconnect')} ${device.name}`} data-testid="device-revoke">
              <Unplug className="mr-1 h-4 w-4" />
              {t('modes.sim.revoke', 'Disconnect')}
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}
