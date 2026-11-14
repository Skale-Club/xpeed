import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ChevronRight, Circle, Gamepad2, LayoutDashboard, Monitor, RefreshCw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanionRelease } from '@/lib/companion-release';
import { checklistOf, deviceState, splitDevices, type StepState } from '@/lib/sim/companion';
import { useOverview } from '@/lib/sim/v1-client';
import { XpeedSimApiError, listDevices, revokeDevice, type SimDevice, type SimErrorReason } from '@/lib/sim/xpeed-sim-api';
import { cn } from '@/lib/utils';
import { CompanionDownload } from './CompanionDownload';
import { DeviceCard } from './CompanionDevices';
import { CompanionGames } from './CompanionGames';

const ERROR_TEXT: Record<SimErrorReason, [key: string, fallback: string]> = {
  signin: ['modes.sim.errors.signin', 'Sign in again to manage your computers.'],
  too_many: ['modes.sim.errors.tooMany', 'Too many requests. Wait a moment and try again.'],
  not_found: ['modes.sim.errors.notFound', 'That computer was not found. It may have been revoked already.'],
  unavailable: ['modes.sim.errors.unavailable', 'The server could not be reached. Try again.'],
};
const reasonOf = (error: unknown): SimErrorReason => (error instanceof XpeedSimApiError ? error.reason : 'unavailable');

/** A step of the checklist: a tick when it is done, an empty circle when it is not; said in words for a screen reader too. */
function Step({ state, children, testId }: { state: StepState; children: ReactNode; testId: string }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-start gap-2.5" data-testid={testId} data-state={state}>
      {state === 'done' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="sr-only">{state === 'done' ? t('communityDash.companion.stepDone', 'done') : t('communityDash.companion.stepTodo', 'to do')}: </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** The three-part story in one strip: it reads your game, it sends each lap, you see it here. */
function HowItWorks() {
  const { t } = useTranslation();
  const parts = [
    { icon: Gamepad2, title: t('communityDash.companion.how1Title', 'It reads your game'), text: t('communityDash.companion.how1Text', 'Xpeed Companion watches the telemetry your racing game publishes while you drive.') },
    { icon: Send, title: t('communityDash.companion.how2Title', 'It sends each lap'), text: t('communityDash.companion.how2Text', 'Every finished lap goes to your account over HTTPS, with the layout of the track.') },
    { icon: LayoutDashboard, title: t('communityDash.companion.how3Title', 'You see it here'), text: t('communityDash.companion.how3Text', 'Laps appear in Overview, Sessions, Compare and the leaderboards.') },
  ];
  return (
    <Card className="bg-card p-4" data-testid="companion-how">
      <h3 className="mb-3 text-sm font-semibold">{t('communityDash.companion.howTitle', 'How it works')}</h3>
      <ol className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-start">
        {parts.flatMap((part, index) => [
          <li key={part.title} className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"><part.icon className="h-5 w-5" aria-hidden="true" /></span>
            <span className="min-w-0"><span className="block text-sm font-medium">{part.title}</span><span className="block text-xs text-muted-foreground">{part.text}</span></span>
          </li>,
          index < parts.length - 1 ? <li key={`${part.title}-arrow`} className="hidden self-center text-muted-foreground md:block" aria-hidden="true"><ChevronRight className="h-5 w-5" /></li> : null,
        ])}
      </ol>
    </Card>
  );
}

/**
 * Virtual > Xpeed Companion: the computers connected (a card each: Online or Offline, when it was seen and sent a lap, Revoke after a question),
 * a checklist of how to connect, the games Xpeed Companion supports (certified first) with what the account holds in each, the newest installer
 * with its version and checksum, and how it all works. Connecting itself happens in the app: it opens /companion/connect/<id> (SimConnectPage),
 * where the person approves.
 */
export function XpeedSimPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const client = useQueryClient();
  const devicesKey = ['sim-devices', user?.id ?? null];

  const release = useCompanionRelease();
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices, enabled: Boolean(user), retry: false });
  const overview = useOverview();
  const [pending, setPending] = useState<SimDevice | null>(null);
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSettled: () => client.invalidateQueries({ queryKey: devicesKey }),
  });

  const errorKey = revoke.error ?? devices.error;
  const list = devices.data ?? [];
  const { live, revoked } = splitDevices(list);
  const online = live.filter((device) => deviceState(device) === 'online').length;
  const lastLap = overview.data?.companion.lastLap ?? null;
  const hasLaps = (overview.data?.lapsPerGame.length ?? 0) > 0 || list.some((device) => !!device.last_lap_at);
  const checklist = checklistOf(list, hasLaps);
  const card = (device: SimDevice, withRevoke: boolean) => (
    <DeviceCard
      key={device.id}
      device={device}
      lastLap={lastLap && lastLap.deviceName === device.name && !device.revoked_at ? lastLap : null}
      busy={revoke.isPending}
      onRevoke={withRevoke ? () => setPending(device) : undefined}
    />
  );

  return (
    <div className="space-y-4" data-testid="companion-panel">
      <p className="text-sm text-muted-foreground">
        {t('modes.sim.intro', 'Xpeed Companion is the Windows app that reads your racing game and sends each lap to your account.')}
      </p>

      {errorKey && (
        <div role="alert" className="flex flex-wrap items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="sim-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{t(ERROR_TEXT[reasonOf(errorKey)][0], ERROR_TEXT[reasonOf(errorKey)][1])}</span>
          {devices.isError && (
            <Button type="button" size="sm" variant="outline" onClick={() => void devices.refetch()} disabled={devices.isFetching} data-testid="devices-retry">
              <RefreshCw className="mr-1 h-4 w-4" />{t('modes.states.retry', 'Try again')}
            </Button>
          )}
        </div>
      )}

      <HowItWorks />

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 space-y-4 lg:col-span-8">
          <Card className="space-y-4 bg-card p-4" data-testid="companion-devices">
            <div className="space-y-1">
              <h3 className="font-semibold">{t('modes.sim.devicesTitle', 'Your computers')}</h3>
              {!devices.isLoading && !devices.isError && list.length > 0 && (
                <p className="text-sm text-muted-foreground" data-testid="devices-summary">
                  {t('communityDash.companion.summary', 'Computers: {{count}} · online now: {{online}}', { count: live.length, online })}
                </p>
              )}
            </div>
            {devices.isLoading && (
              <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="devices-loading">
                <Skeleton className="h-36 rounded-xl" /><Skeleton className="h-36 rounded-xl" />
              </div>
            )}
            {!devices.isLoading && !devices.isError && list.length === 0 && (
              <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
                <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <p className="text-sm text-muted-foreground" data-testid="devices-empty">{t('modes.sim.devicesEmpty', 'No computer is connected yet.')}</p>
              </div>
            )}
            {list.length > 0 && (
              <ul className="grid gap-3 sm:grid-cols-2" data-testid="device-list">{live.map((device) => card(device, true))}</ul>
            )}
            {revoked.length > 0 && (
              <details className="group rounded-lg border border-border" data-testid="devices-revoked">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                  {t('communityDash.companion.revokedTitle', 'Revoked computers: {{count}}', { count: revoked.length })}
                </summary>
                <ul className="grid gap-3 p-3 pt-1 sm:grid-cols-2" data-testid="device-list-revoked">{revoked.map((device) => card(device, false))}</ul>
              </details>
            )}
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>{t('communityDash.companion.heardHelp', 'Online means the server heard from the computer in the last 10 minutes.')}</p>
              <p>{t('communityDash.companion.connectAnother', 'To connect another computer, open Xpeed Companion on it and click Connect to your account.')}</p>
              <p>{t('modes.sim.limit', 'You can connect up to 10 computers.')}</p>
            </div>
          </Card>

          <CompanionGames overview={overview.data} loading={overview.isPending} />
        </div>

        <div className={cn('min-w-0 space-y-4 lg:col-span-4', !devices.isLoading && list.length === 0 && 'order-first lg:order-none')}>
          <Card className="space-y-3 bg-card p-4" data-testid="companion-checklist">
            <h3 className="font-semibold">{t('modes.sim.howTitle', 'How to connect')}</h3>
            <ol className="space-y-2.5 text-sm" data-testid="how-to-connect">
              <Step state={checklist.connected} testId="step-install">
                {t('modes.sim.howInstall', 'Install Xpeed Companion on the PC where you play.')}{' '}
                <a href="/companion" className="font-medium text-primary underline underline-offset-2" data-testid="companion-page-link">
                  {t('companionSite.getIt', 'Download it here')}
                </a>
                {release.data && <span className="text-muted-foreground" data-testid="companion-latest"> ({t('companionSite.latest', 'latest: {{version}}', { version: release.data.version })})</span>}
              </Step>
              <Step state={checklist.connected} testId="step-connect">{t('modes.sim.howOpen', 'Open it and click Connect to your account.')}</Step>
              <Step state={checklist.laps} testId="step-drive">{t('communityDash.companion.stepDrive', 'Start a game and drive a lap. It shows up in your account by itself.')}</Step>
            </ol>
            <p className="text-xs text-muted-foreground">{t('modes.sim.howAfter', 'Your browser opens and asks you once to confirm. There is nothing to copy or type.')}</p>
          </Card>
          <CompanionDownload />
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={t('modes.sim.confirmTitle', 'Revoke {{name}}?', { name: pending?.name ?? '' })}
        description={t('modes.sim.confirmBody', 'This computer can no longer send laps. Laps it already sent stay in your account. You can connect it again from Xpeed Companion.')}
        confirmLabel={t('modes.sim.confirmRevoke', 'Revoke')}
        onConfirm={() => {
          if (pending) revoke.mutate(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}
