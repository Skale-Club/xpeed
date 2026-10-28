import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, AlertTriangle, AlertCircle, ChevronRight, Loader2, Route } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/contexts/SettingsContext';
import type { VehicleIssue } from '@/lib/db-issues';
import type { Session } from '@/types/session';
import { URGENCY } from '@/lib/problems';
import { formatDistance, formatDuration, formatTripDate, tripDate, tripDistanceKm, tripTitle } from '@/lib/trips';

/**
 * "Is my car OK?" in one sentence, from the same problem list as the Problems
 * page. No verdict until the list has loaded; if it can't be loaded, say so
 * instead of "all good".
 */
export function CarHealthCard({ problems, loading = false, error = false, onRetry, lastTrip }: {
  problems: VehicleIssue[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
  lastTrip: Session | null;
}) {
  const { t, i18n } = useTranslation();

  if (loading || error) {
    return (
      <Card data-testid="car-health" className={error ? 'border-destructive/30 bg-destructive/[0.07]' : undefined} role={error ? 'alert' : 'status'}>
        <CardContent className="flex items-center gap-4 p-4 sm:p-5">
          <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${error ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'}`}>
            {error ? <AlertCircle className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-lg font-bold tracking-tight">
              {error ? t('problems.checkFailed', "Couldn't check your car") : t('home.health.checking', 'Checking your car…')}
            </p>
            {error && <p className="text-sm text-muted-foreground">{t('problems.checkFailedHint', 'Check your connection and try again.')}</p>}
          </div>
          {error && onRetry && (
            <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry}>
              {t('problems.retry', 'Try again')}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  const urgent = problems.some((p) => URGENCY[p.severity] === 'urgent');
  const [Icon, tone, surface, title, hint] = urgent
    ? [AlertCircle, 'text-destructive', 'border-destructive/30 bg-destructive/[0.07]', t('home.health.urgent', 'See a mechanic'), t('home.health.urgentHint', 'Something needs attention soon.')]
    : problems.length
      ? [AlertTriangle, 'text-warn', 'border-warn/30 bg-warn/[0.07]', t('home.health.watch', 'Keep an eye on it'), t('problems.needAttention', { count: problems.length, defaultValue: '{{count}} problems need attention' })]
      : [CheckCircle2, 'text-success', 'border-success/30 bg-success/[0.07]', t('home.health.ok', 'All good'), t('home.health.okHint', 'No problems found.')];

  const circle = urgent ? 'bg-destructive/15' : problems.length ? 'bg-warn/15' : 'bg-success/15';

  return (
    <Card data-testid="car-health" className={surface}>
      <CardContent className="flex items-center gap-4 p-4 sm:p-5">
        <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${circle} ${tone}`}>
          <Icon className="h-6 w-6" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-lg font-bold tracking-tight">{title}</p>
          <p className="text-sm text-muted-foreground">{hint}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {lastTrip
              ? t('home.health.lastCheck', 'Last checked on a trip on {{when}}.', { when: formatTripDate(tripDate(lastTrip), i18n.resolvedLanguage) })
              : t('home.health.noTrips', 'No trips yet — start one below to check your car.')}
          </p>
        </div>
        {problems.length > 0 && (
          <Link to="/issues" className="shrink-0 rounded-full bg-background/60 px-4 py-2.5 text-sm font-medium hover:bg-background">{t('home.health.see', 'See')}</Link>
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
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Route className="h-5 w-5 text-primary" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground">{t('home.lastTrip', 'Last trip')}</p>
            <p className="font-medium truncate">{tripTitle(session, t)}</p>
            <p className="text-xs text-muted-foreground">{facts.join(' · ')}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </Link>
        <div className="border-t border-border/60 px-4 py-2.5 text-right">
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
          <CardContent className="px-1.5 py-4 text-center">
            <p className="whitespace-nowrap text-base font-bold tracking-tight tabular-nums sm:text-lg">{value}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
