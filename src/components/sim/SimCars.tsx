import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { carPath } from '@/lib/sim/routes';
import { useCars, type V1CarItem } from '@/lib/sim/v1-client';
import { SimCarIdentity } from './SimCarIdentity';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useWhen } from './use-when';

/**
 * Virtual > Game cars: the cars driven, by game (the most recently driven first), with the brand logo when it is known, the laps, the
 * tracks, the best valid lap and when each was last driven, a page at a time. A car opens its own page.
 */
export function SimCars() {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('date');
  const query = useCars();
  const groups = useMemo(() => {
    const byGame = new Map<string, V1CarItem[]>();
    for (const car of query.items) byGame.set(car.game, [...(byGame.get(car.game) ?? []), car]);
    return [...byGame].map(([game, cars]) => ({ game, cars }));
  }, [query.items]);

  return (
    <QueryGate query={query} empty={query.items.length === 0} emptyNode={<CompanionInvite testId="cars-empty" body={t('modes.cars.empty', 'No cars yet. Install Xpeed Companion and connect it to your account: the cars you drive show up here.')} />}>
      <div className="space-y-6" data-testid="cars">
        {groups.map((group) => (
          <section key={group.game} className="space-y-3" data-testid="cars-game">
            <div className="flex items-center gap-2">
              {games.cover(group.game) && <img src={games.cover(group.game)!} alt="" className="h-8 w-8 rounded-md object-cover" loading="lazy" />}
              <h3 className="text-base font-semibold">{games.name(group.game)}</h3>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {group.cars.map((car) => (
                <Link key={car.id} to={carPath(car.id)} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="car-link">
                <Card className="h-full bg-card border-border transition-colors hover:bg-muted/30" data-testid="cars-car">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 text-sm font-semibold">
                        <SimCarIdentity name={car.name} />
                      </div>
                      <ChevronRight className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: car.lapCount })} · {t('modes.cars.trackCount', 'Tracks: {{count}}', { count: car.trackCount })}
                      {' · '}{t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(Date.parse(car.lastDrivenAt)) })}
                    </p>
                    <p className="text-sm">
                      <span className="text-xs text-muted-foreground">{t('modes.cars.bestLap', 'Best valid lap')}: </span>
                      <span className="font-mono tabular-nums">{car.bestLapMs !== null ? formatLapTime(car.bestLapMs) : '–'}</span>
                    </p>
                  </CardContent>
                </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
        <LoadMore hasNextPage={!!query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
      </div>
    </QueryGate>
  );
}
