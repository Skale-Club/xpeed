import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2, Monitor, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import { XpeedSimApiError, listDevices, revokeDevice, type SimDevice, type SimErrorReason } from '@/lib/sim/xpeed-sim-api';

const ERROR_TEXT: Record<SimErrorReason, [key: string, fallback: string]> = {
  signin: ['modes.sim.errors.signin', 'Sign in again to manage your computers.'],
  too_many: ['modes.sim.errors.tooMany', 'Too many requests. Wait a moment and try again.'],
  not_found: ['modes.sim.errors.notFound', 'That computer was not found. It may have been revoked already.'],
  unavailable: ['modes.sim.errors.unavailable', 'The server could not be reached. Try again.'],
};
const reasonOf = (error: unknown): SimErrorReason => (error instanceof XpeedSimApiError ? error.reason : 'unavailable');

/**
 * Virtual > Xpeed Companion: how to connect a Windows computer, and the computers already connected (revoke one here).
 * Connecting itself happens in the app: it opens /sim/connect/<id> (SimConnectPage), where the person approves.
 */
export function XpeedSimPanel() {
  const { t, i18n } = useTranslation();
  const { timezone } = useSettings();
  const { user } = useAuth();
  const client = useQueryClient();
  const devicesKey = ['sim-devices', user?.id ?? null];

  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices, enabled: Boolean(user), retry: false });
  const [pending, setPending] = useState<SimDevice | null>(null);
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSettled: () => client.invalidateQueries({ queryKey: devicesKey }),
  });

  const when = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const errorKey = revoke.error ?? devices.error;
  const list = devices.data ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('modes.sim.intro', 'Xpeed Companion is the Windows app that reads your racing game and sends each lap to your account.')}
      </p>

      {errorKey && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="sim-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t(ERROR_TEXT[reasonOf(errorKey)][0], ERROR_TEXT[reasonOf(errorKey)][1])}</span>
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="font-semibold">{t('modes.sim.howTitle', 'How to connect')}</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm" data-testid="how-to-connect">
            <li>{t('modes.sim.howInstall', 'Install Xpeed Companion on the PC where you play.')}</li>
            <li>{t('modes.sim.howOpen', 'Open it and click Connect to your account.')}</li>
          </ol>
          <p className="text-xs text-muted-foreground">{t('modes.sim.howAfter', 'Your browser opens and asks you once to confirm. There is nothing to copy or type.')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="font-semibold">{t('modes.sim.devicesTitle', 'Your computers')}</h3>
          {devices.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('common.loading', 'Loading')} />}
          {!devices.isLoading && !devices.isError && list.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="devices-empty">{t('modes.sim.devicesEmpty', 'No computer is connected yet.')}</p>
          )}
          <ul className="divide-y" data-testid="device-list">
            {list.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="device">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{device.name}</span>
                    <Badge variant={device.revoked_at ? 'secondary' : 'default'}>
                      {device.revoked_at ? t('modes.sim.revoked', 'Revoked') : t('modes.sim.active', 'Connected')}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('modes.sim.pairedOn', 'Connected {{date}}', { date: when(device.created_at) })}
                    {' · '}
                    {device.last_seen_at ? t('modes.sim.lastSeen', 'Last seen {{date}}', { date: when(device.last_seen_at) }) : t('modes.sim.neverSeen', 'Never seen')}
                    {' · '}
                    {device.last_lap_at ? t('modes.sim.lastLap', 'Last lap sent {{date}}', { date: when(device.last_lap_at) }) : t('modes.sim.noLaps', 'No laps sent yet')}
                  </div>
                </div>
                {!device.revoked_at && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending(device)} disabled={revoke.isPending}>
                    <Unplug className="mr-1 h-4 w-4" />
                    {t('modes.sim.revoke', 'Revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('modes.sim.limit', 'You can connect up to 10 computers.')}</p>
        </CardContent>
      </Card>

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
