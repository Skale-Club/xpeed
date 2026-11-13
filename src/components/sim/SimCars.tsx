import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useSimLaps } from '@/hooks/use-sim-laps';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { carsByGame } from '@/lib/sim/overview';
import { SimCarIdentity } from './SimCarIdentity';
import { useWhen } from './use-when';

/** Virtual > Game cars: the cars driven, by game, with the best valid lap on each track. */
export function SimCars() {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('date');
  const { laps, settled } = useSimLaps();
  const groups = useMemo(() => carsByGame(laps), [laps]);

  if (!settled) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading', 'Loading…')}
      </p>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="cars-empty">
        {t('modes.cars.empty', 'No cars yet. Connect Xpeed Companion and drive: the cars you drive show up here.')}{' '}
        <Link to="/virtual/companion" className="underline">{t('modes.sessions.emptyLink', 'Connect Xpeed Companion')}</Link>
      </p>
    );
  }
  return (
    <div className="space-y-6" data-testid="cars">
      {groups.map((group) => (
        <section key={group.game} className="space-y-3" data-testid="cars-game">
          <div className="flex items-center gap-2">
            {games.cover(group.game) && <img src={games.cover(group.game)!} alt="" className="h-8 w-8 rounded-md object-cover" loading="lazy" />}
            <h3 className="text-base font-semibold">{games.name(group.game)}</h3>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.cars.map((car) => (
              <Card key={car.carName} className="bg-card border-border" data-testid="cars-car">
                <CardContent className="space-y-3 p-4">
                  <div className="min-w-0 text-sm font-semibold">
                    <SimCarIdentity name={car.carName} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('modes.sessions.lapCount', 'Laps: {{count}}', { count: car.laps })} · {t('modes.cars.trackCount', 'Tracks: {{count}}', { count: car.tracks.length })}
                    {' · '}{t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(car.lastDrivenAt) })}
                  </p>
                  <table className="w-full text-xs sm:text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground">
                        <th scope="col" className="pr-2 font-normal">{t('modes.cars.track', 'Track')}</th>
                        <th scope="col" className="pr-2 text-right font-normal">{t('modes.cars.bestLap', 'Best valid lap')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {car.tracks.map((track) => (
                        <tr key={track.trackName} className="border-t border-border" data-testid="cars-track">
                          <td className="py-1.5 pr-2">{track.trackName}</td>
                          <td className="whitespace-nowrap py-1.5 text-right font-mono tabular-nums">
                            {track.best ? formatLapTime(track.best.summary.timeMs) : '–'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
