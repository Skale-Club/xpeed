import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { useGames } from '@/lib/sim/games';
import { carPath, trackPath } from '@/lib/sim/routes';
import type { V1Stats } from '@/lib/sim/v1-client';
import { SimCarIdentity } from '../SimCarIdentity';
import { Panel, Quiet } from './parts';
import { useDashFormat } from './use-format';

interface Row { key: string; label: ReactNode; laps: number; to?: string; name: string }

/** Horizontal bars with the lap count at the end; the bar is decoration, the row's text is the content. A row with a link opens the page of the track or the car. */
function Bars({ rows, testId }: { rows: Row[]; testId: string }) {
  const { t } = useTranslation();
  const format = useDashFormat();
  const top = Math.max(1, ...rows.map((row) => row.laps));
  return (
    <ul className="space-y-2" data-testid={testId}>
      {rows.map((row) => {
        const body = (
          <>
            <span className="flex min-w-0 items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">{row.label}</span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" data-testid="where-count" aria-label={t('modes.overview.dash.lapsN', '{{count}} laps', { count: row.laps })}>{format.number(row.laps)}</span>
            </span>
            <span className="mt-1 block h-1.5 rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (row.laps / top) * 100)}%`, background: CHART_PALETTE.blue, opacity: 0.8 }} />
            </span>
          </>
        );
        return (
          <li key={row.key} data-testid="where-row" data-name={row.name}>
            {row.to ? (
              <Link to={row.to} className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground">{body}</Link>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The name of a track or car, with its game after it when another row of the list has the same name (Monza in two games). */
function nameWithGame(entry: { name: string; game: string }, all: ReadonlyArray<{ name: string }>, gameName: (game: string) => string): string {
  return all.filter((other) => other.name === entry.name).length > 1 ? `${entry.name} · ${gameName(entry.game)}` : entry.name;
}

/** Where you drive: laps by game, and the tracks and cars you drove most in the period. "Games played" lives here too. */
export function WherePanel({ stats }: { stats: V1Stats }) {
  const { t } = useTranslation();
  const games = useGames();
  const { games: byGame, tracks, cars } = stats.breakdown;
  return (
    <Panel title={t('modes.overview.dash.whereTitle', 'Where you drive')} testId="overview-where">
      <div className="grid gap-6 md:grid-cols-3">
        <section className="min-w-0 space-y-2" aria-labelledby="where-games" data-testid="where-games">
          <h4 id="where-games" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('modes.overview.games', 'Games played')}</h4>
          {byGame.length === 0 ? <Quiet>{t('modes.overview.dash.whereEmpty', 'Nothing in this period.')}</Quiet> : (
            <Bars
              testId="where-games-list"
              rows={byGame.map((entry) => ({
                key: entry.game,
                name: games.name(entry.game),
                laps: entry.laps,
                label: (
                  <span className="flex min-w-0 items-center gap-2" data-testid="overview-game">
                    {games.cover(entry.game) && <img src={games.cover(entry.game)!} alt="" className="h-5 w-5 shrink-0 rounded object-cover" loading="lazy" />}
                    <span className="truncate">{games.name(entry.game)}</span>
                  </span>
                ),
              }))}
            />
          )}
        </section>
        <section className="min-w-0 space-y-2" aria-labelledby="where-tracks" data-testid="where-tracks">
          <h4 id="where-tracks" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('modes.overview.dash.topTracks', 'Top tracks')}</h4>
          {tracks.length === 0 ? <Quiet>{t('modes.overview.dash.whereEmpty', 'Nothing in this period.')}</Quiet> : (
            <Bars testId="where-tracks-list" rows={tracks.map((track) => ({ key: track.id, name: track.name, laps: track.laps, to: trackPath(track.id), label: nameWithGame(track, tracks, games.name) }))} />
          )}
        </section>
        <section className="min-w-0 space-y-2" aria-labelledby="where-cars" data-testid="where-cars">
          <h4 id="where-cars" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('modes.overview.dash.topCars', 'Top cars')}</h4>
          {cars.length === 0 ? <Quiet>{t('modes.overview.dash.whereEmpty', 'Nothing in this period.')}</Quiet> : (
            <Bars testId="where-cars-list" rows={cars.map((car) => ({ key: car.id, name: car.name, laps: car.laps, to: carPath(car.id), label: <SimCarIdentity name={nameWithGame(car, cars, games.name)} className="text-sm" /> }))} />
          )}
        </section>
      </div>
    </Panel>
  );
}
