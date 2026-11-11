import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, Copy, Loader2, Monitor, Unplug } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import {
  CollectorApiError, listDevices, pairCommand, requestPairingCode, revokeDevice,
  type CollectorDevice, type CollectorErrorReason, type PairingCode,
} from '@/lib/sim/collector-api';

const ERROR_TEXT: Record<CollectorErrorReason, [key: string, fallback: string]> = {
  signin: ['modes.collector.errors.signin', 'Sign in again to manage your computers.'],
  too_many: ['modes.collector.errors.tooMany', 'Too many codes requested. Wait a moment and try again.'],
  not_found: ['modes.collector.errors.notFound', 'That computer was not found. It may have been revoked already.'],
  unavailable: ['modes.collector.errors.unavailable', 'The server could not be reached. Try again.'],
};
const reasonOf = (error: unknown): CollectorErrorReason => (error instanceof CollectorApiError ? error.reason : 'unavailable');

/** `9:05` for a number of milliseconds. */
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/**
 * Virtual > Collector: connect a Windows computer to the account with a pairing code, and see or revoke the
 * computers already connected. The program that reads the game is the collector (collector/ in the repository).
 */
export function CollectorPanel() {
  const { t, i18n } = useTranslation();
  const { timezone } = useSettings();
  const { user } = useAuth();
  const client = useQueryClient();
  const devicesKey = ['sim-devices', user?.id ?? null];

  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices, enabled: Boolean(user), retry: false });
  const [code, setCode] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<'code' | 'command' | null>(null);
  const [pending, setPending] = useState<CollectorDevice | null>(null);

  const ask = useMutation({ mutationFn: requestPairingCode, onSuccess: (made) => { setCode(made); setNow(Date.now()); } });
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSettled: () => client.invalidateQueries({ queryKey: devicesKey }),
  });

  const left = code ? new Date(code.expiresAt).getTime() - now : 0;
  const expired = code !== null && left <= 0;
  // A second-by-second clock only while a code is on screen and still good.
  useEffect(() => {
    if (!code || new Date(code.expiresAt).getTime() <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);

  const copy = async (text: string, what: 'code' | 'command') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied((current) => (current === what ? null : current)), 2000);
    } catch {
      // The text is on screen to be selected by hand.
    }
  };

  const when = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(i18n.resolvedLanguage || 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(iso));
    } catch {
      return iso;
    }
  };

  const errorKey = ask.error ?? revoke.error ?? devices.error;
  const list = devices.data ?? [];
  const command = code && !expired ? pairCommand(code.code.replace('-', '')) : '';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('modes.collector.intro', 'The collector is the Windows program that reads your racing game and sends each lap to your account. Connect a computer once with a pairing code.')}
      </p>

      {errorKey && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="collector-error">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{t(ERROR_TEXT[reasonOf(errorKey)][0], ERROR_TEXT[reasonOf(errorKey)][1])}</span>
        </div>
      )}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="font-semibold">{t('modes.collector.connectTitle', 'Connect a computer')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('modes.collector.connectBody', 'Get a code, then run the command below on the Windows computer where you play. The code works for 10 minutes and only once.')}
          </p>

          {code && !expired && (
            <div className="space-y-3" data-testid="pairing">
              <div>
                <div className="text-xs text-muted-foreground">{t('modes.collector.codeLabel', 'Pairing code')}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-3xl font-bold tracking-widest" data-testid="pairing-code">{code.code}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => copy(code.code, 'code')}>
                    {copied === 'code' ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                    {copied === 'code' ? t('modes.collector.copied', 'Copied') : t('modes.collector.copy', 'Copy')}
                  </Button>
                </div>
                <div className="text-xs text-muted-foreground" data-testid="pairing-left">
                  {t('modes.collector.expiresIn', 'Valid for {{time}}', { time: clock(left) })}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('modes.collector.commandLabel', 'Run this on the Windows computer')}</div>
                <div className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-xs" data-testid="pairing-command">{command}</code>
                  <Button type="button" variant="outline" size="sm" onClick={() => copy(command, 'command')}>
                    {copied === 'command' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    <span className="sr-only">{t('modes.collector.copy', 'Copy')}</span>
                  </Button>
                </div>
              </div>
            </div>
          )}
          {expired && <p className="text-sm text-muted-foreground" data-testid="pairing-expired">{t('modes.collector.expired', 'This code has expired.')}</p>}

          <Button type="button" onClick={() => ask.mutate()} disabled={ask.isPending}>
            {ask.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {code ? t('modes.collector.newCode', 'Get a new code') : t('modes.collector.getCode', 'Get a pairing code')}
          </Button>
          <p className="text-xs text-muted-foreground">
            {t('modes.collector.install', 'The collector has to be installed on that computer first. For now it is built from the collector folder of the repository.')}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 p-4">
          <h3 className="font-semibold">{t('modes.collector.devicesTitle', 'Your computers')}</h3>
          {devices.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label={t('common.loading', 'Loading')} />}
          {!devices.isLoading && !devices.isError && list.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="devices-empty">{t('modes.collector.devicesEmpty', 'No computer is connected yet.')}</p>
          )}
          <ul className="divide-y" data-testid="device-list">
            {list.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="device">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">{device.name}</span>
                    <Badge variant={device.revoked_at ? 'secondary' : 'default'}>
                      {device.revoked_at ? t('modes.collector.revoked', 'Revoked') : t('modes.collector.active', 'Connected')}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t('modes.collector.pairedOn', 'Connected {{date}}', { date: when(device.created_at) })}
                    {' · '}
                    {device.last_seen_at ? t('modes.collector.lastSeen', 'Last seen {{date}}', { date: when(device.last_seen_at) }) : t('modes.collector.neverSeen', 'Never seen')}
                    {' · '}
                    {device.last_lap_at ? t('modes.collector.lastLap', 'Last lap sent {{date}}', { date: when(device.last_lap_at) }) : t('modes.collector.noLaps', 'No laps sent yet')}
                  </div>
                </div>
                {!device.revoked_at && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setPending(device)} disabled={revoke.isPending}>
                    <Unplug className="mr-1 h-4 w-4" />
                    {t('modes.collector.revoke', 'Revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t('modes.collector.limit', 'You can connect up to 10 computers.')}</p>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => !next && setPending(null)}
        title={t('modes.collector.confirmTitle', 'Revoke {{name}}?', { name: pending?.name ?? '' })}
        description={t('modes.collector.confirmBody', 'This computer can no longer send laps. Laps it already sent stay in your account. You can connect it again with a new code.')}
        confirmLabel={t('modes.collector.confirmRevoke', 'Revoke')}
        onConfirm={() => {
          if (pending) revoke.mutate(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}
