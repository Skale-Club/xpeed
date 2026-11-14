import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Award } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { FilterBar } from '@/components/ui/filter-bar';
import { formatLapTime } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { useCars, useLaps, useOverview, usePbs, useTracks, type V1Lap } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { FilterSelect } from './FilterSelect';
import { useReadAllPages } from './use-read-all-pages';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useWhen } from './use-when';

/** What the picker starts from when the person is changing one lap of a comparison: the same game, track and car by name. */
export interface PickerStart { game: string; trackName: string; carName: string }

/**
 * Finds a lap on the account: the game, then the track, then the car, then the laps of those (newest first, a page at a time).
 * Every list comes from the server; nothing here reads a file.
 */
export function LapPicker({ onPick, start, exclude = [] }: { onPick: (lap: V1Lap) => void; start?: PickerStart; exclude?: string[] }) {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen();
  const overview = useOverview();
  const [game, setGame] = useState(start?.game ?? '');
  const [track, setTrack] = useState('');
  const [car, setCar] = useState('');

  const gameOptions = useMemo(() => overview.data?.lapsPerGame ?? [], [overview.data]);
  // With only one game there is nothing to choose.
  useEffect(() => {
    if (!game && gameOptions.length === 1) setGame(gameOptions[0].game);
  }, [game, gameOptions]);

  const tracks = useTracks({ game }, { enabled: !!game });
  const cars = useCars({ game }, { enabled: !!game });
  useReadAllPages(tracks);
  useReadAllPages(cars);
  // The track and car of the lap being changed, found by name, are the first choice.
  useEffect(() => {
    if (!start || start.game !== game) return;
    if (!track) {
      const found = tracks.items.find((item) => item.name.trim().toLowerCase() === start.trackName.trim().toLowerCase());
      if (found) setTrack(found.id);
    }
    if (!car) {
      const found = cars.items.find((item) => item.name.trim().toLowerCase() === start.carName.trim().toLowerCase());
      if (found) setCar(found.id);
    }
  }, [start, game, track, car, tracks.items, cars.items]);

  const laps = useLaps({ game, track, car: car || undefined }, { enabled: !!game && !!track });
  const pbs = usePbs({ game, track, ...(car ? { car } : {}) }, { enabled: !!game && !!track });
  const pbLaps = new Set(pbs.items.map((pb) => pb.lapId));

  return (
    <div className="space-y-3" data-testid="lap-picker">
      <FilterBar data-testid="picker-filters">
        <FilterSelect
          label={t('modes.sessions.filterGame', 'Game')}
          allLabel={t('modes.picker.chooseGame', 'Choose a game')}
          value={game}
          onChange={(value) => {
            setGame(value);
            setTrack('');
            setCar('');
          }}
          options={gameOptions.map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          className="sm:w-44"
          testId="picker-game"
        />
        <FilterSelect
          label={t('modes.sessions.filterTrack', 'Track')}
          allLabel={t('modes.picker.chooseTrack', 'Choose a track')}
          value={track}
          onChange={setTrack}
          options={tracks.items.map((item) => ({ value: item.id, label: item.name }))}
          disabled={!game}
          className="sm:w-44"
          testId="picker-track"
        />
        <FilterSelect
          label={t('modes.sessions.filterCar', 'Car')}
          allLabel={t('modes.picker.anyCar', 'Any car')}
          value={car}
          onChange={setCar}
          options={cars.items.map((item) => ({ value: item.id, label: item.name }))}
          disabled={!track}
          className="sm:w-44"
          testId="picker-car"
        />
      </FilterBar>

      {!game || !track ? (
        overview.isSuccess && gameOptions.length === 0 ? (
          <CompanionInvite testId="picker-empty" />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="picker-hint">
            {!game ? t('modes.picker.hintGame', 'Choose a game, then a track, to see your laps.') : t('modes.picker.hintTrack', 'Now choose a track.')}
          </p>
        )
      ) : (
        <QueryGate query={laps} empty={laps.items.length === 0} emptyNode={<p className="text-sm text-muted-foreground" data-testid="picker-no-laps">{t('modes.picker.noLaps', 'No laps with this track and car.')}</p>}>
          <ul className="divide-y divide-border rounded-lg border border-border" data-testid="picker-laps">
            {laps.items.map((lap) => {
              const taken = exclude.includes(lap.id);
              return (
                <li key={lap.id}>
                  <button
                    type="button"
                    disabled={taken}
                    onClick={() => onPick(lap)}
                    className={cn('flex min-h-11 w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-50', !lap.valid && 'text-muted-foreground')}
                    data-testid="picker-lap"
                    data-lap-id={lap.id}
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{t('modes.compare.lapN', 'Lap {{n}}', { n: lap.lapNumber })}</span>
                      <span className="ml-2 font-mono tabular-nums">{formatLapTime(lap.timeMs)}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {lap.car?.name ?? ''} · {when(Date.parse(lap.startedAt))}
                      </span>
                    </span>
                    <span className="flex items-center gap-1">
                      {pbLaps.has(lap.id) && <Badge variant="secondary" className="gap-1"><Award className="h-3 w-3" />{t('modes.session.pb', 'Personal best')}</Badge>}
                      {!lap.valid && <Badge variant="destructive">{t('modes.compare.notValid', 'not valid')}</Badge>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <LoadMore hasNextPage={!!laps.hasNextPage} isFetchingNextPage={laps.isFetchingNextPage} onClick={() => void laps.fetchNextPage()} />
        </QueryGate>
      )}
    </div>
  );
}
