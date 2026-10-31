import { useState } from 'react';
import { temperatureValue, temperatureLabel } from '@/lib/temperature';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, AlertTriangle, CheckCircle2, Loader2, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { HeaderPanel } from './HeaderPanel';
import { useVehicleNotifications } from '@/contexts/VehicleNotificationsContext';
import { useCarsContext } from '@/contexts/CarsContext';
import { describeProblem } from '@/lib/problems';
import { formatAppDate } from '@/lib/app-date';
import { useSettings } from '@/contexts/SettingsContext';
import { KM_PER_MILE } from '@/lib/vehicle-care';
import { HeaderControl } from './header/HeaderControl';

export function VehicleNotificationBell() {
  const { t, i18n } = useTranslation();
  const { distanceUnit, temperatureUnit } = useSettings();
  const { selectedCar } = useCarsContext();
  const { items, unread, loading, error, markRead, reload } = useVehicleNotifications();
  const [open, setOpen] = useState(false);
  return <HeaderPanel open={open} onOpenChange={setOpen} title={t('notifications.title', 'Notifications')}
    description={selectedCar?.name || t('notifications.chooseCar', 'Choose a car to see its notifications.')}
    trigger={<HeaderControl aria-label={t('notifications.open', 'Notifications: {{count}} unread', { count: unread })} title={t('notifications.title', 'Notifications')}>
      <Bell />
      {(unread > 0 || error) && <span className="absolute right-1 top-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-destructive px-0.5 text-[8px] font-semibold leading-none text-destructive-foreground" aria-hidden="true">{unread > 99 ? '99+' : unread || '!'}</span>}
    </HeaderControl>}>
      <div className="space-y-3">
        {loading && <p className="flex items-center gap-2 text-sm" role="status"><Loader2 className="h-4 w-4 animate-spin" />{t('notifications.loading', 'Checking saved problems…')}</p>}
        {error && <div role="alert" className="space-y-2 rounded-lg border border-warn/40 p-3 text-sm"><p>{t('notifications.failed', 'Could not refresh saved problems. Existing notices may be out of date.')}</p><Button size="sm" variant="outline" onClick={reload}>{t('common.retry', 'Try again')}</Button></div>}
        {unread > 0 && <Button size="sm" variant="outline" onClick={() => markRead()}>{t('notifications.readAll', 'Mark all as read')}</Button>}
        {!loading && !error && items.length === 0 && <p className="text-sm text-muted-foreground">{t('notifications.empty', 'No notices yet. This is not a fresh check of the car.')}</p>}
        {items.map((item) => {
          const codes = item.scan ? [...new Set([...item.scan.stored, ...item.scan.pending, ...item.scan.permanent])] : [];
          const complete = item.scan && (item.scan.complete ?? (item.scan.checked && !!item.scan.modules?.length));
          const problem = item.problem ? describeProblem(item.problem, t) : null;
          const title = item.kind === 'live' ? t('notifications.liveAlert','{{sensor}} stayed outside its expected range',{sensor:t('notifications.sensors.'+item.live?.key,item.live?.label || '')}) : item.kind === 'maintenance' ? (item.oil?.status === 'due' ? t('oil.due', 'Oil change due') : t('oil.soon', 'Oil change coming up')) : item.kind === 'fuel' ? t('fuel.alert', 'Fuel consumption increased {{delta}}% on comparable trips', { delta: item.fuel?.deltaPct.toFixed(1) }) : problem?.title || (!complete ? t('codes.incompleteTitle', 'Incomplete code reading') : codes.length ? t('notifications.codesFound', '{{count}} fault codes reported', { count: codes.length }) : t('notifications.noCodes', 'No codes in the responses received'));
          const date = new Date(item.problem?.last_seen_at ?? item.at);
          return <article key={item.source} className={`rounded-xl border p-3 ${item.read ? 'border-border' : item.severity === 'critical' ? 'border-destructive/60 bg-destructive/5' : 'border-primary/40 bg-primary/5'}`}>
            <Link to={item.kind === 'live' ? '/live' : item.kind === 'maintenance' ? '/maintenance' : item.kind === 'fuel' ? '/fuel' : item.kind === 'problem' && item.problem ? `/issues#issue-${encodeURIComponent(item.problem.id)}` : '/codes'} onClick={() => { markRead(item.source); setOpen(false); }} className="block space-y-1">
              <p className="flex items-start gap-2 text-sm font-semibold">{item.severity === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${item.severity === 'critical' ? 'text-destructive' : 'text-warn'}`} />}{title}</p>
              {item.live && <p className="text-xs text-muted-foreground">{temperatureValue(item.live.value,item.live.unit,temperatureUnit).toFixed(1)} {temperatureLabel(item.live.unit,temperatureUnit)}</p>}
              {problem && <p className="line-clamp-2 text-xs text-muted-foreground">{problem.meaning}</p>}
              {item.problem && item.problem.recurrence_count > 1 && <p className="text-xs text-muted-foreground">{t('notifications.repeated', 'Seen {{count}} times', {count:item.problem.recurrence_count})}</p>}
              {item.oil?.dueKm != null && <p className="text-xs text-muted-foreground">{t('oil.nextAt', 'Next oil change at {{value}} {{unit}}', { value: new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 0 }).format(item.oil.dueKm / (distanceUnit === 'mi' ? KM_PER_MILE : 1)), unit: distanceUnit })}</p>}
              {item.oil?.dueDate && <p className="text-xs text-muted-foreground">{item.oil.dueDate}</p>}
              {codes.length > 0 && <p className="font-mono text-xs">{codes.join(', ')}</p>}
              <p className="text-[11px] text-muted-foreground">{item.kind === 'live' ? t('notifications.liveSource','During your trip') : item.kind === 'maintenance' ? t('nav.maintenance', 'Service history') : item.kind === 'fuel' ? t('fuel.trendTitle', 'Is consumption changing?') : item.kind === 'problem' ? t('notifications.savedSource', 'Saved problem') : t('notifications.scanSource', 'Code reading')} · {Number.isFinite(date.getTime()) ? formatAppDate(date, i18n.resolvedLanguage, { dateStyle: 'short', timeStyle: 'short' }) : '—'}</p>
              <span className="flex items-center gap-1 pt-1 text-xs font-medium text-primary">{t('notifications.openDetails', 'View details')}<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
            </Link>
            {!item.read && <button className="mt-2 text-xs text-primary hover:underline" onClick={() => markRead(item.source)}>{t('notifications.read', 'Mark as read')}</button>}
          </article>;
        })}
        <Link to="/issues" onClick={() => setOpen(false)} className="flex min-h-10 items-center text-sm text-primary hover:underline">{t('notifications.viewProblems', 'View car problems')}</Link>
      </div>
  </HeaderPanel>;
}
