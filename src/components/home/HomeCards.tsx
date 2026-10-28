import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle, AlertCircle, ChevronRight, Route } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useSettings } from '@/contexts/SettingsContext';
import type { VehicleIssue } from '@/lib/db-issues';
import type { Session } from '@/types/session';
import { URGENCY } from '@/lib/problems';
import { formatDistance, formatDuration, formatTripDate, tripDate, tripDistanceKm, tripTitle } from '@/lib/trips';

/** "Is my car OK?" in one sentence, from the same problem list as the Problems page. */
export function CarHealthCard({ problems, lastTrip }: { problems: VehicleIssue[]; lastTrip: Session | null }) {
  const { t, i18n } = useTranslation();
  const urgent = problems.some((p) => URGENCY[p.severity] === 'urgent');
  const [Icon, tone, title, hint] = urgent
    ? [AlertCircle, 'text-destructive', t('home.health.urgent', 'See a mechanic'), t('home.health.urgentHint', 'Something needs attention soon.')]
    : problems.length
      ? [AlertTriangle, 'text-warn', t('home.health.watch', 'Keep an eye on it'), t('problems.needAttention', { count: problems.length, defaultValue: '{{count}} problems need attention' })]
      : [CheckCircle2, 'text-success', t('home.health.ok', 'All good'), t('home.health.okHint', 'No problems found.')];

  return (
    <Card data-testid="car-health">
      <CardContent className="p-4 flex items-center gap-4">
        <Icon className={`w-9 h-9 shrink-0 ${tone}`} />
        <div className="flex-1 min-w-0">
          <p className="text-lg font-semibold">{title}</p>
          <p className="text-sm text-muted-foreground">{hint}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {lastTrip
              ? t('home.health.lastCheck', 'Last checked on a trip on {{when}}.', { when: formatTripDate(tripDate(lastTrip), i18n.resolvedLanguage) })
              : t('home.health.noTrips', 'No trips yet — start one below to check your car.')}
          </p>
        </div>
        {problems.length > 0 && (
          <Link to="/issues" className="text-sm text-primary hover:underline shrink-0">{t('home.health.see', 'See')}</Link>
        )}
      </CardContent>
    </Card>
  );
}

export function LastTripSummary({ session }: { session: Session }) {
  const { t, i18n } = useTranslation();
  const { distanceUnit } = useSettings();
  const facts = [
    formatTripDate(tripDate(session), i18n.resolvedLanguage),
    formatDuration(session.duration_seconds),
    formatDistance(tripDistanceKm(session), distanceUnit),
  ].filter(Boolean);

  return (
    <Card>
      <CardContent className="p-0">
        <Link to={`/session/${session.id}`} className="flex items-center gap-3 p-4 hover:bg-accent/40 rounded-lg" data-testid="last-trip">
          <Route className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">{t('home.lastTrip', 'Last trip')}</p>
            <p className="font-medium truncate">{tripTitle(session, t)}</p>
            <p className="text-xs text-muted-foreground">{facts.join(' · ')}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </Link>
        <div className="border-t border-border px-4 py-2 text-right">
          <Link to="/history" className="text-xs text-primary hover:underline">{t('home.allTrips', 'See all trips')}</Link>
        </div>
      </CardContent>
    </Card>
  );
}

export function TripTotals({ sessions }: { sessions: Session[] }) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const km = sessions.reduce((sum, s) => sum + (tripDistanceKm(s) ?? 0), 0);
  const seconds = sessions.reduce((sum, s) => sum + (s.duration_seconds ?? 0), 0);
  const items = [
    [t('home.totals.trips', 'Trips'), String(sessions.length)],
    [t('home.totals.distance', 'Distance'), formatDistance(km, distanceUnit) ?? '—'],
    [t('home.totals.time', 'Time driving'), formatDuration(seconds) ?? '—'],
  ];
  return (
    <div className="grid grid-cols-3 gap-2" data-testid="trip-totals">
      {items.map(([label, value]) => (
        <Card key={label}>
          <CardContent className="p-3 px-1.5 text-center">
            <p className="text-sm sm:text-base font-semibold tabular-nums whitespace-nowrap">{value}</p>
            <p className="text-[11px] text-muted-foreground">{label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
