import { Car, Gamepad } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, Outlet } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useModes } from '@/contexts/ModesContext';
import { MODE_HOME, type Mode } from '@/lib/modes';

/**
 * Layout route for the screens of one mode. Someone who did not choose that
 * mode is not dropped somewhere else without a word: the screen says which mode
 * it belongs to and offers to turn it on (a link from Xpeed Sim lands on a
 * Virtual screen, for example). Only a mode this build does not have sends the
 * person home. (The server refuses the Virtual API the same way once accounts
 * store the choice.)
 */
export function ModeGate({ mode }: { mode: Mode }) {
  const { modes, virtualAvailable, setModes } = useModes();
  if (modes.includes(mode)) return <Outlet />;
  const home = MODE_HOME[modes[0] ?? 'real'];
  if (mode === 'virtual' && !virtualAvailable) return <Navigate to={home} replace />;
  return <ModeOffer mode={mode} home={home} onTurnOn={() => setModes([...modes, mode])} />;
}

function ModeOffer({ mode, home, onTurnOn }: { mode: Mode; home: string; onTurnOn: () => void }) {
  const { t } = useTranslation();
  const virtual = mode === 'virtual';
  const Icon = virtual ? Gamepad : Car;
  // Inside the app's own frame (menu, header), like every other screen.
  return (
    <AppLayout>
    <div className="flex justify-center px-4 py-10" data-testid="mode-offer">
      <Card className="bg-card border-border w-full max-w-md">
        <CardContent className="p-6 space-y-4 text-center">
          <Icon className="w-10 h-10 text-primary mx-auto" aria-hidden />
          <h1 className="text-lg font-semibold">
            {virtual ? t('modes.offer.virtualTitle', 'Racing games is off') : t('modes.offer.realTitle', 'Real car is off')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {virtual
              ? t('modes.offer.virtualBody', 'This page is part of Racing games: your simulator sessions, laps and the Xpeed Sim connection. Turn it on to continue.')
              : t('modes.offer.realBody', 'This page is part of Real car: trips, problems, fuel and maintenance. Turn it on to continue.')}
          </p>
          <p className="text-xs text-muted-foreground">{t('modes.offer.later', 'You can turn it off again in Settings.')}</p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
            <Button onClick={onTurnOn}>{t('modes.offer.turnOn', 'Turn it on')}</Button>
            <Button variant="outline" asChild>
              <Link to={home} replace>{t('modes.offer.notNow', 'Not now')}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
    </AppLayout>
  );
}
