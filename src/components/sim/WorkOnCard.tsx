import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettings } from '@/contexts/SettingsContext';
import type { DistanceUnit } from '@/lib/sim/analysis';
import { sessionFindingText } from '@/lib/sim/insight-text';
import { sessionPath } from '@/lib/sim/routes';
import { useWorkOn } from '@/lib/sim/use-work-on';
import type { V1Session } from '@/lib/sim/v1-client';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

/**
 * "What to work on": the two biggest findings of the most recent session that has at least 3 valid laps (the corner the driving
 * varies most in, and where the best lap beat the average lap), with a button into that session. It is worked out from the lap files
 * of that one session after the page is shown; a skeleton stands in for it, and when it cannot be worked out (no session with enough
 * laps, a file that will not come down, nothing worth saying) the card is not shown at all.
 */
export function WorkOnCard({ sessions }: { sessions: readonly V1Session[] }) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const when = useWhen('date');
  const query = useWorkOn(sessions, true);
  const candidates = sessions.some((session) => session.lapCount >= 3);
  if (!candidates || query.isError || (query.isSuccess && (!query.data || query.data.findings.length === 0))) return null;

  return (
    <Card className="bg-card border-border" data-testid="work-on">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">{t('modes.overview.workOn', 'What to work on')}</h3>
        </div>
        {query.isSuccess && query.data ? (
          <>
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground" data-testid="work-on-session">
              <span className="truncate">{query.data.session.track.name}</span>
              <SimCarIdentity name={query.data.session.car.name} className="text-xs" />
              <span>{when(Date.parse(query.data.session.startedAt))}</span>
              <span>{t('modes.overview.workOnLaps', '{{count}} laps analysed', { count: query.data.lapsUsed })}</span>
            </p>
            <ul className="space-y-2">
              {query.data.findings.map((finding) => {
                const text = sessionFindingText(finding, { unit: distanceUnit as DistanceUnit });
                return (
                  <li key={finding.kind} className="text-sm" data-testid="work-on-finding" data-kind={finding.kind}>
                    {t(text.key, text.values)}
                  </li>
                );
              })}
            </ul>
            <Button asChild size="sm" variant="outline">
              <Link to={sessionPath(query.data.session.id)} data-testid="work-on-open">{t('modes.overview.workOnOpen', 'Open the session')}</Link>
            </Button>
          </>
        ) : (
          <div className="space-y-2" role="status" aria-label={t('modes.analysis.working', 'Working out the corners…')} data-testid="work-on-loading">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
