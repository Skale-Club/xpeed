import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronRight, Monitor, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useCompanionRelease } from '@/lib/companion-release';
import { splitDevices } from '@/lib/sim/companion';
import { useOverview } from '@/lib/sim/v1-client';
import { XpeedSimApiError, listDevices, revokeDevice, type SimDevice, type SimErrorReason } from '@/lib/sim/xpeed-sim-api';
import { useNow } from './use-now';
import { CompanionDownload } from './CompanionDownload';
import { DeviceCard } from './CompanionDevices';
import { CompanionGames } from './CompanionGames';

const ERROR_TEXT: Record<SimErrorReason, [key: string, fallback: string]> = {
  signin: ['modes.sim.errors.signin', 'Sign in again to manage your computers.'],
  too_many: ['modes.sim.errors.tooMany', 'Too many requests. Wait a moment and try again.'],
  not_found: ['modes.sim.errors.notFound', 'That computer was not found. It may have been disconnected already.'],
  unavailable: ['modes.sim.errors.unavailable', 'The server could not be reached. Try again.'],
};
const reasonOf = (error: unknown): SimErrorReason => (error instanceof XpeedSimApiError ? error.reason : 'unavailable');

/** A numbered step of "Get started". */
function Step({ n, testId, children }: { n: number; testId: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3" data-testid={testId}>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary" aria-hidden="true">{n}</span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5 text-sm">{children}</div>
    </li>
  );
}

/**
 * Virtual > Xpeed Companion (reached from Settings): what a person who races needs, in three blocks. "Get started": download, open and connect,
 * drive a lap (folded away once a computer is connected). "Your computers": a compact card each (Online or Offline, what it is doing, its last lap,
 * Disconnect after a question). "Games": the ones Xpeed Companion supports, certified first, with the laps the account holds. Connecting itself
 * happens in the app: it opens /companion/connect/<id> (SimConnectPage), where the person approves.
 */
export function XpeedSimPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const client = useQueryClient();
  const devicesKey = ['sim-devices', user?.id ?? null];

  const release = useCompanionRelease();
  // The server hears from a running computer every minute: read the list again every 30 s while the page is open, and let "Online" lapse on its own.
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices, enabled: Boolean(user), retry: false, refetchInterval: 30_000 });
  const now = useNow();
  const overview = useOverview();
  const [pending, setPending] = useState<SimDevice | null>(null);
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSettled: () => client.invalidateQueries({ queryKey: devicesKey }),
  });

  const errorKey = revoke.error ?? devices.error;
  const list = devices.data ?? [];
  const { live, revoked } = splitDevices(list, now);
  const lastLap = overview.data?.companion.lastLap ?? null;
  // A returning person sees their computers first: the steps fold away once one is connected (they stay one click away).
  const showSteps = !devices.isLoading && live.length === 0;
  const card = (device: SimDevice, withRevoke: boolean) => (
    <DeviceCard
      key={device.id}
      device={device}
      lastLap={lastLap && lastLap.deviceName === device.name && !device.revoked_at ? lastLap : null}
      busy={revoke.isPending}
      latestVersion={release.data?.version}
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

      <Card className="bg-card" data-testid="companion-start">
        <details className="group" open={showSteps} data-testid="companion-start-details">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-4 font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
            {t('communityDash.companion.getStarted', 'Get started')}
          </summary>
          <ol className="space-y-4 px-4 pb-4" data-testid="how-to-connect">
            <Step n={1} testId="step-install">
              <p>{t('modes.sim.howInstall', 'Install Xpeed Companion on the PC where you play.')}</p>
              <CompanionDownload />
            </Step>
            <Step n={2} testId="step-connect"><p>{t('modes.sim.howOpen', 'Open it and click Connect to your account. Your browser asks you once to confirm.')}</p></Step>
            <Step n={3} testId="step-drive"><p>{t('communityDash.companion.stepDrive', 'Start a game and drive a lap. It shows up in your account by itself.')}</p></Step>
          </ol>
        </details>
      </Card>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="min-w-0 space-y-3 bg-card p-4 lg:col-span-8" data-testid="companion-devices">
          <h3 className="font-semibold">{t('modes.sim.devicesTitle', 'Your computers')}</h3>
          {devices.isLoading && (
            <div className="grid gap-3 sm:grid-cols-2" role="status" aria-label={t('common.loading', 'Loading…')} data-testid="devices-loading">
              <Skeleton className="h-28 rounded-xl" /><Skeleton className="h-28 rounded-xl" />
            </div>
          )}
          {!devices.isLoading && !devices.isError && list.length === 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
              <Monitor className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-muted-foreground" data-testid="devices-empty">{t('modes.sim.devicesEmpty', 'No computer is connected yet.')}</p>
            </div>
          )}
          {live.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="device-list">{live.map((device) => card(device, true))}</ul>
          )}
          {revoked.length > 0 && (
            <details className="group rounded-lg border border-border" data-testid="devices-revoked">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden="true" />
                {t('communityDash.companion.revokedTitle', 'Disconnected computers: {{count}}', { count: revoked.length })}
              </summary>
              <ul className="grid gap-3 p-3 pt-1 sm:grid-cols-2" data-testid="device-list-revoked">{revoked.map((device) => card(device, false))}</ul>
            </details>
          )}
          {list.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="devices-hint">{t('communityDash.companion.connectAnother', 'To add another computer (up to 10), open Xpeed Companion on it and click Connect to your account.')}</p>
          )}
        </Card>

        <div className="min-w-0 lg:col-span-4">
          <CompanionGames overview={overview.data} loading={overview.isPending} />
        </div>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={t('modes.sim.confirmTitle', 'Disconnect {{name}}?', { name: pending?.name ?? '' })}
        description={t('modes.sim.confirmBody', 'This computer can no longer send laps. Laps it already sent stay in your account. You can connect it again from Xpeed Companion.')}
        confirmLabel={t('modes.sim.confirmRevoke', 'Disconnect')}
        onConfirm={() => {
          if (pending) revoke.mutate(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}
