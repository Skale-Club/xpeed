import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from './ui/sheet';
import { useVehicleNotifications } from '@/contexts/VehicleNotificationsContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { describeProblem } from '@/lib/problems';
import { formatAppDate } from '@/lib/app-date';

export function VehicleNotificationBell() {
  const { t, i18n } = useTranslation();
  const { selectedCar } = useCarsContext();
  const { items, unread, loading, error, markRead, reload } = useVehicleNotifications();
  const [open, setOpen] = useState(false);
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button variant="ghost" size="icon" className="relative shrink-0" aria-label={t('notifications.open', 'Notifications: {{count}} unread', { count: unread })}>
      <Bell className="h-5 w-5" />
      {(unread > 0 || error) && <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground" aria-hidden="true">{unread > 99 ? '99+' : unread || '!'}</span>}
    </Button></SheetTrigger>
    <SheetContent className="w-full overflow-y-auto sm:max-w-md">
      <SheetHeader><SheetTitle>{t('notifications.title', 'Notifications')}</SheetTitle><SheetDescription>{selectedCar?.name || t('notifications.chooseCar', 'Choose a car to see its notifications.')}</SheetDescription></SheetHeader>
      <div className="mt-4 space-y-3">
        {loading && <p className="flex items-center gap-2 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />{t('notifications.loading', 'Checking saved problems…')}</p>}
        {error && <div role="alert" className="space-y-2 rounded-lg border border-warn/40 p-3 text-sm"><p>{t('notifications.failed', 'Could not refresh saved problems. Existing notices may be out of date.')}</p><Button size="sm" variant="outline" onClick={reload}>{t('common.retry', 'Try again')}</Button></div>}
        {unread > 0 && <Button size="sm" variant="outline" onClick={() => markRead()}>{t('notifications.readAll', 'Mark all as read')}</Button>}
        {!loading && !error && items.length === 0 && <p className="text-sm text-muted-foreground">{t('notifications.empty', 'No notices yet. This is not a fresh check of the car.')}</p>}
        {items.map((item) => {
          const codes = item.scan ? [...new Set([...item.scan.stored, ...item.scan.pending, ...item.scan.permanent])] : [];
          const complete = item.scan && (item.scan.complete ?? (item.scan.checked && !!item.scan.modules?.length));
          const problem = item.problem ? describeProblem(item.problem, t) : null;
          const title = item.kind === 'fuel' ? t('fuel.alert', 'Fuel consumption increased {{delta}}% on comparable trips', { delta: item.fuel?.deltaPct.toFixed(1) }) : problem?.title || (!complete ? t('codes.incompleteTitle', 'Incomplete code reading') : codes.length ? t('notifications.codesFound', '{{count}} fault codes reported', { count: codes.length }) : t('notifications.noCodes', 'No codes in the responses received'));
          const date = new Date(item.at);
          return <article key={item.source} className={`rounded-xl border p-3 ${item.read ? 'border-border' : item.severity === 'critical' ? 'border-destructive/60 bg-destructive/5' : 'border-primary/40 bg-primary/5'}`}>
            <Link to={item.kind === 'fuel' ? '/fuel' : item.kind === 'problem' ? '/issues' : '/codes'} onClick={() => { markRead(item.source); setOpen(false); }} className="block space-y-1">
              <p className="flex items-start gap-2 text-sm font-semibold">{item.severity === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${item.severity === 'critical' ? 'text-destructive' : 'text-warn'}`} />}{title}</p>
              {item.kind === 'fuel' && <p className="text-xs text-muted-foreground">{t('fuel.alertHint', 'Based on well-covered comparable trips across two 28-day periods. Review conditions and consumption; this is not a diagnosis.')}</p>}
              {problem && <p className="text-xs text-muted-foreground">{problem.meaning}</p>}
              {codes.length > 0 && <p className="font-mono text-xs">{codes.join(', ')}</p>}
              <p className="text-[11px] text-muted-foreground">{item.kind === 'fuel' ? t('fuel.trendTitle', 'Is consumption changing?') : item.kind === 'problem' ? t('notifications.savedSource', 'Saved problem') : t('notifications.scanSource', 'Code reading')} · {Number.isFinite(date.getTime()) ? formatAppDate(date, i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' }) : '—'}</p>
            </Link>
            {!item.read && <button className="mt-2 text-xs text-primary hover:underline" onClick={() => markRead(item.source)}>{t('notifications.read', 'Mark as read')}</button>}
          </article>;
        })}
        <p className="text-xs text-muted-foreground">{t('notifications.readHint', 'Reading a notice does not resolve a problem. Notices and read status are saved for this car and account on this device.')}</p>
        <Link to="/codes" onClick={() => setOpen(false)} className="block text-sm text-primary hover:underline">{t('codes.title', 'Read car fault codes')}</Link>
      </div>
    </SheetContent>
  </Sheet>;
}
