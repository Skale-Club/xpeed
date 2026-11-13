import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { useCars, type V1CarItem } from '@/lib/sim/v1-client';
import { SimCarIdentity } from './SimCarIdentity';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useWhen } from './use-when';

/** Virtual > Game cars: the cars driven, by game (the most recently driven first), with the best valid lap of each. Another task rebuilds this page. */
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
                <Card key={car.id} className="bg-card border-border" data-testid="cars-car">
                  <CardContent className="space-y-2 p-4">
                    <div className="min-w-0 text-sm font-semibold">
                      <SimCarIdentity name={car.name} />
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
              ))}
            </div>
          </section>
        ))}
        <LoadMore hasNextPage={!!query.hasNextPage} isFetchingNextPage={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} />
      </div>
    </QueryGate>
  );
}
