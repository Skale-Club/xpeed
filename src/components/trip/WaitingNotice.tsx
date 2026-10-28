import { useTranslation } from 'react-i18next';
import { Loader2, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * What to tell the owner while the adapter is linked but the car isn't
 * answering (car off) or the link dropped and is being found again — the same
 * words as the home trip card — with a way out.
 */
export function WaitingNotice({ status, alwaysOn, onDisconnect }: {
  status: 'waiting' | 'reconnecting';
  alwaysOn: boolean;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 text-center" role="status" data-testid="waiting-notice">
      {status === 'reconnecting'
        ? <Loader2 className="h-8 w-8 animate-spin text-primary" />
        : <Moon className="h-8 w-8 text-muted-foreground" />}
      <div>
        <p className="font-semibold">
          {status === 'reconnecting'
            ? t('trip.reconnecting', 'Looking for the adapter…')
            : t('trip.waiting', 'Adapter connected — waiting for the car')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {status === 'reconnecting'
            ? t('trip.reconnectingHint', 'It reconnects by itself when the car is switched on.')
            : alwaysOn
              ? t('trip.waitingAuto', 'Turn the car on. The trip starts recording by itself when you drive off.')
              : t('trip.waitingManual', 'Turn the car on to start recording.')}
        </p>
      </div>
      <Button variant="outline" onClick={onDisconnect}>
        {t('trip.disconnect', 'Disconnect')}
      </Button>
    </div>
  );
}
