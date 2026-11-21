import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import type { SavedComparison } from '@/lib/sim/compare-recent';
import { useLaps, type V1Lap } from '@/lib/sim/v1-client';
import { LapPicker } from '../LapPicker';
import { ListSkeleton } from '../SimStates';
import { useWhen } from '../use-when';
import { SavedChips } from './SavedChips';

/** How many of the newest laps are offered to open straight away. */
export const LATEST_LAPS = 6;

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The analysis screen with no lap in its address (an old link, a bookmark): a comparison starts from a lap, so it offers the comparisons made lately
 * and the saved ones, the newest laps to open with one click, and, folded, the picker by game, track and car. With no lap on the account the picker
 * shows the Companion invite.
 */
export function CompareStart({ saved, onPin, onForget, onPick }: {
  saved: readonly SavedComparison[];
  onPin: (item: SavedComparison, pinned: boolean) => void;
  onForget: (item: SavedComparison) => void;
  onPick: (lap: V1Lap) => void;
}) {
  const { t } = useTranslation();
  const when = useWhen();
  const laps = useLaps({});
  const [finding, setFinding] = useState(false);
  const latest = laps.items.slice(0, LATEST_LAPS);
  const noLaps = laps.isSuccess && laps.items.length === 0;

  return (
    <Card className="border-border bg-card" data-testid="compare-start">
      <CardContent className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t('modes.compare.startIntro', 'Open a lap to analyze it: from a session, a track, a car or a leaderboard. It is measured against your personal best on the same track and car, and you can choose another reference there.')}
        </p>

        <SavedChips items={saved} a={null} b={null} onPin={onPin} onForget={onForget} />

        {noLaps ? (
          <LapPicker onPick={onPick} />
        ) : (
          <>
            <section className="space-y-1.5" aria-labelledby="compare-latest-title" data-testid="compare-latest">
              <h3 id="compare-latest-title" className="text-xs font-medium text-muted-foreground">{t('modes.compare.latestLaps', 'Your latest laps')}</h3>
              {laps.isPending ? (
                <ListSkeleton rows={3} />
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {latest.map((lap) => (
                    <li key={lap.id}>
                      <Link to={compareUrl(lap.id)} className={`flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40 ${FOCUS}`} data-testid="compare-latest-lap" data-lap-id={lap.id}>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{lap.track?.name ?? '–'} · {t('modes.compare.lapN', 'Lap {{n}}', { n: lap.lapNumber })}</span>
                          <span className="block truncate text-xs text-muted-foreground">{lap.car?.name ?? '–'} · {when(Date.parse(lap.startedAt))}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <span className="font-mono text-sm tabular-nums">{formatLapTime(lap.timeMs)}</span>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link to="/virtual/sessions" className={`inline-block text-sm underline ${FOCUS}`} data-testid="compare-all-sessions">{t('modes.overview.allSessions', 'All sessions')}</Link>
            </section>

            <div className="space-y-2 border-t border-border pt-3">
              <Button variant="outline" size="sm" className="h-auto min-h-9 max-w-full whitespace-normal py-1.5" onClick={() => setFinding(!finding)} aria-expanded={finding} data-testid="compare-find">
                <Search className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('modes.compare.findLap', 'Find a lap by track and car')}
              </Button>
              {finding && <LapPicker onPick={onPick} />}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
