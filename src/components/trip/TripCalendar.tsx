import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { tripDayKey } from '@/lib/trip-history';

export function TripCalendar({ month, selectedDay, days, activeStart, timezone, onMonth, onDay }: {
  month: string; selectedDay: string; days: Map<string, number>; activeStart?: Date; timezone?: string;
  onMonth: (month: string) => void; onDay: (day: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const active = !!activeStart;
  const [today, setToday] = useState(() => tripDayKey(new Date(), timezone));
  useEffect(() => {
    const update = () => setToday(tripDayKey(new Date(), timezone));
    update();
    if (!active) return;
    const timer = window.setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [active, timezone]);
  const [browsed, setBrowsed] = useState('');
  const shown = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : browsed || today.slice(0, 7);
  const [year, number] = shown.split('-').map(Number);
  const start = new Date(Date.UTC(year, number - 1, 1));
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const activeDay = activeStart ? tripDayKey(activeStart, timezone) : '';
  const format = (date: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(i18n.resolvedLanguage, { ...options, timeZone: 'UTC' }).format(date);
  const move = (amount: number) => {
    const date = new Date(Date.UTC(year, number - 1 + amount, 1));
    const next = tripDayKey(date, 'UTC').slice(0, 7);
    setBrowsed(next); onMonth(next);
  };
  return <section className="space-y-2 rounded-xl border border-border p-3" aria-label={t('history.calendar', 'Trip calendar')}>
    <div className="flex items-center justify-between gap-2">
      <Button size="icon" variant="ghost" aria-label={t('history.previousMonth', 'Previous month')} onClick={() => move(-1)}><ChevronLeft /></Button>
      <p className="text-sm font-semibold" aria-live="polite">{format(start, { month: 'long', year: 'numeric' })}</p>
      <Button size="icon" variant="ghost" aria-label={t('history.nextMonth', 'Next month')} onClick={() => move(1)}><ChevronRight /></Button>
    </div>
    <div className="grid grid-cols-7 gap-1">
      {Array.from({ length: 7 }, (_, index) => <span key={`weekday-${index}`} className="text-center text-[10px] text-muted-foreground" aria-hidden="true">{format(new Date(Date.UTC(2023, 0, 1 + index)), { weekday: 'short' })}</span>)}
      {Array.from({ length: start.getUTCDay() }, (_, index) => <span key={`blank-${index}`} aria-hidden="true" />)}
      {Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.UTC(year, number - 1, index + 1));
        const key = tripDayKey(date, 'UTC');
        const live = !!activeDay && key >= activeDay && key <= today;
        const saved = days.get(key) ?? 0;
        return <button key={key} type="button" aria-pressed={key === selectedDay}
          aria-label={`${format(date, { dateStyle: 'full' })}${live ? ` · ${t('pill.recording', 'Recording trip')}` : ''}${saved ? ` · ${t('history.savedCount', '{{count}} completed trips', { count: saved })}` : ''}`}
          onClick={() => onDay(key)}
          className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-lg border text-sm ${live ? 'border-destructive/50 bg-destructive/15 font-semibold text-destructive' : key === selectedDay ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent'} ${key === selectedDay ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''}`}>
          {index + 1}<span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-destructive' : saved ? 'bg-muted-foreground' : 'bg-transparent'}`} aria-hidden="true" />
        </button>;
      })}
    </div>
    <p className="flex items-center gap-2 text-xs text-muted-foreground"><span className="h-2 w-2 rounded-full bg-muted-foreground" aria-hidden="true" />{t('history.savedTrips', 'Completed trips')}{activeStart && <><span className="ml-2 h-2 w-2 rounded-full bg-destructive" aria-hidden="true" />{t('pill.recording', 'Recording trip')}</>}</p>
    {activeStart && shown !== today.slice(0, 7) && <Button variant="ghost" size="sm" className="text-destructive" onClick={() => onDay(today)}>{t('history.liveDay', 'Go to recording day')}</Button>}
  </section>;
}
