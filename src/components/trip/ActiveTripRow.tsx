import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { formatAppDate } from '@/lib/app-date';

export function ActiveTripRow({ startedAt, waiting }: { startedAt: Date; waiting: boolean }) {
  const { t, i18n } = useTranslation();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt.getTime()) / 1000));
  const duration = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return <Card className="border-destructive/50 bg-destructive/5" data-testid="active-trip">
    <CardContent className="p-0"><Link to="/live" className="block space-y-2 rounded-xl p-4 hover:bg-destructive/5">
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-destructive px-2.5 py-1 text-xs font-semibold text-destructive-foreground"><span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />{t('pill.recording', 'Recording trip')}</span>
        <span className="font-mono text-sm tabular-nums">{duration}</span>
      </div>
      <p className="font-semibold">{t('history.liveTrip', 'Trip in progress')}</p>
      <p className="text-xs text-muted-foreground">{formatAppDate(startedAt, i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' })}</p>
      {waiting && <p className="text-xs text-muted-foreground">{t('trip.paused', 'Waiting for the car… the trip continues when it answers again.')}</p>}
      <p className="text-sm font-medium text-primary">{t('trip.openLive', 'View Dashboard')}</p>
    </Link></CardContent>
  </Card>;
}
