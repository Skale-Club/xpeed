import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, Check, Loader2, Monitor } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useModes } from '@/contexts/ModesContext';
import {
  XpeedSimLinkError, approveLinkRequest, cancelLinkRequest, readLinkRequest, type LinkFailure, type LinkRequest,
} from '@/lib/sim/xpeed-sim-api';

const FAILURE_TEXT: Record<LinkFailure, [key: string, fallback: string]> = {
  expired: ['modes.connect.expired', 'This request expired. Click Connect again in Xpeed Companion.'],
  already_decided: ['modes.connect.alreadyConnected', 'This computer is already connected, or the request was closed.'],
  not_found: ['modes.connect.notFound', 'We could not find this request. Click Connect again in Xpeed Companion.'],
  device_limit: ['modes.connect.deviceLimit', 'You already have 10 computers connected. Revoke one in Xpeed Companion, then try again.'],
  signin: ['modes.connect.signin', 'Sign in again to connect this computer.'],
  unavailable: ['modes.connect.unavailable', 'The server could not be reached. Try again.'],
};
const failureOf = (error: unknown): LinkFailure => (error instanceof XpeedSimLinkError ? error.reason : 'unavailable');

/**
 * /companion/connect/<id>: the page Xpeed Companion opens when the person clicks "Connect to your account". One question,
 * one button. The app learns the answer by itself; nothing is copied or typed.
 */
export default function SimConnectPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { modes, virtualAvailable, setModes } = useModes();
  const [done, setDone] = useState<'connected' | 'cancelled' | null>(null);
  const [lateFailure, setLateFailure] = useState<LinkFailure | null>(null);

  const request = useQuery({ queryKey: ['sim-link', id], queryFn: () => readLinkRequest(id), retry: false, refetchOnWindowFocus: false });
  const account = user?.email || user?.user_metadata?.full_name || user?.phone || '';

  const approve = useMutation({
    mutationFn: () => approveLinkRequest(id),
    onSuccess: () => {
      // So the person never meets the "Racing games is off" card on the next screen.
      if (virtualAvailable && !modes.includes('virtual')) setModes([...modes, 'virtual']);
      setDone('connected');
    },
    onError: (error) => setLateFailure(failureOf(error)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelLinkRequest(id),
    onSuccess: () => setDone('cancelled'),
    onError: (error) => setLateFailure(failureOf(error)),
  });

  const text = (failure: LinkFailure) => t(FAILURE_TEXT[failure][0], FAILURE_TEXT[failure][1]);
  const info = (message: string, testId: string, icon = false) => (
    <p className="flex items-start justify-center gap-2 text-sm text-muted-foreground" data-testid={testId}>
      {icon && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>{message}</span>
    </p>
  );

  const body = () => {
    if (done === 'connected') {
      return (
        <div className="space-y-4 text-center" data-testid="connect-done">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/15">
            <Check className="h-7 w-7 text-success" aria-hidden />
          </div>
          <h1 className="text-lg font-semibold">{t('modes.connect.doneTitle', 'Connected')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('modes.connect.doneBody', 'Go back to Xpeed Companion, it already knows. You can close this tab.')}
          </p>
          <Button variant="outline" asChild>
            <Link to="/virtual">{t('modes.connect.openGames', 'Open Racing games')}</Link>
          </Button>
        </div>
      );
    }
    if (done === 'cancelled') return info(t('modes.connect.cancelled', 'Cancelled. This computer was not connected.'), 'connect-cancelled');
    // The request changed under the person (it ran out, or was closed elsewhere): say so, no button left to press.
    if (lateFailure === 'expired' || lateFailure === 'already_decided' || lateFailure === 'not_found') return info(text(lateFailure), 'connect-error', true);
    if (request.isLoading) {
      return <div className="flex justify-center py-4" data-testid="connect-loading"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label={t('common.loading', 'Loading…')} /></div>;
    }
    if (request.isError) return info(text(failureOf(request.error)), 'connect-error', true);
    const found = request.data as LinkRequest;
    if (found.status === 'expired') return info(text('expired'), 'connect-expired', true);
    if (found.status === 'cancelled') return info(t('modes.connect.cancelledBefore', 'This request was cancelled. Click Connect again in Xpeed Companion.'), 'connect-cancelled');
    if (found.status === 'approved') return info(t('modes.connect.alreadyConnectedNamed', '{{name}} is already connected.', { name: found.deviceName }), 'connect-already');

    const busy = approve.isPending || cancel.isPending;
    return (
      <div className="space-y-4 text-center" data-testid="connect-ask">
        <Monitor className="mx-auto h-10 w-10 text-primary" aria-hidden />
        <h1 className="text-lg font-semibold">{t('modes.connect.title', 'Connect Xpeed Companion?')}</h1>
        <p className="break-words text-2xl font-bold" data-testid="connect-device">{found.deviceName}</p>
        {found.deviceNameFromComputer !== false && (
          <p className="text-xs text-muted-foreground" data-testid="connect-name-notice">
            {t('modes.connect.nameNotChecked', 'The name {{device}} is sent by the computer and is not checked.', { device: found.deviceName })}
          </p>
        )}
        {found.verifyCode && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3" data-testid="connect-verify">
            <p className="text-sm">
              {t('modes.connect.verify', 'Check that the code is the same one shown in Xpeed Companion on your computer:')}
            </p>
            <p className="font-mono text-4xl font-bold tracking-[0.3em]" data-testid="connect-code" aria-label={found.verifyCode.split('').join(' ')}>
              {found.verifyCode}
            </p>
          </div>
        )}
        {account && (
          <p className="text-sm">
            {t('modes.connect.goesTo', 'Your laps from this computer will go to {{account}}.', { account })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('modes.connect.onlyIf', 'Only connect if you just clicked Connect in Xpeed Companion on this computer.')}
        </p>
        {lateFailure && info(text(lateFailure), 'connect-failure', true)}
        <div className="flex flex-col justify-center gap-2 pt-1 sm:flex-row">
          <Button onClick={() => { setLateFailure(null); approve.mutate(); }} disabled={busy}>
            {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('modes.connect.connect', 'Connect')}
          </Button>
          <Button variant="outline" onClick={() => { setLateFailure(null); cancel.mutate(); }} disabled={busy}>
            {t('common.cancel', 'Cancel')}
          </Button>
        </div>
      </div>
    );
  };

  return (
    <AppLayout>
      <div className="flex justify-center px-4 py-10">
        <Card className="w-full max-w-md border-border bg-card">
          <CardContent className="p-6">{body()}</CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
