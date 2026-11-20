import { Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** On the Companion page: the way to the phone view (`/virtual/live`), and what has to be on in the Companion for it to show anything. */
export function PhoneLiveCard() {
  const { t } = useTranslation();
  return (
    <Card className="flex flex-wrap items-center gap-3 bg-card p-4" data-testid="companion-phone">
      <Smartphone className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 basis-64">
        <h3 className="font-semibold">{t('phoneLive.cardTitle', 'Open on your phone')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('phoneLive.cardBody', 'See the Companion\'s dashboard live on your phone while you drive. In the Companion\'s tray menu, turn on “Show the panel on my phone”, then open this page on your phone.')}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to="/virtual/live" data-testid="companion-phone-open">{t('phoneLive.cardOpen', 'Open the phone view')}</Link>
      </Button>
    </Card>
  );
}
