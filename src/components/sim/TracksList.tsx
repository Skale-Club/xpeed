import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Map as MapIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useSettings } from '@/contexts/SettingsContext';
import { formatLapTime, type DistanceUnit } from '@/lib/sim/analysis';
import { useGames } from '@/lib/sim/games';
import { trackPath } from '@/lib/sim/routes';
import { trackLength } from '@/lib/sim/track-length';
import { hasSyncedLayout, useAccountLayouts } from '@/lib/sim/track-layout-match';
import { useOverview, useTracks, type V1TrackItem } from '@/lib/sim/v1-client';
import { FilterSelect } from './FilterSelect';
import { CompanionInvite, LoadMore, QueryGate } from './SimStates';
import { useWhen } from './use-when';

function TrackCard({ track, layout, unit }: { track: V1TrackItem; layout: boolean; unit: DistanceUnit }) {
  const { t } = useTranslation();
  const games = useGames();
  const when = useWhen('date');
  return (
    <Link to={trackPath(track.id)} className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="track-link">
      <Card className="h-full bg-card border-border transition-colors hover:bg-muted/30" data-testid="track">
        <CardContent className="space-y-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold">{track.name}</h3>
              <p className="truncate text-xs text-muted-foreground">
                {games.name(track.game)}
                {track.lengthM ? ` · ${trackLength(track.lengthM, unit)}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {layout && (
                <Badge variant="secondary" className="gap-1" data-testid="track-layout-badge" title={t('modes.tracks.layoutTitle', 'Xpeed Companion has sent the layout of this track: the lap is drawn on it')}>
                  <MapIcon className="h-3 w-3" aria-hidden /> {t('modes.tracks.layoutBadge', 'Layout')}
                </Badge>
              )}
              <ChevronRight className="hidden h-4 w-4 text-muted-foreground sm:block" aria-hidden />
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
            <span data-testid="track-laps">{t('modes.sessions.lapCount', 'Laps: {{count}}', { count: track.lapCount })}</span>
            <span data-testid="track-best">
              <span className="text-xs text-muted-foreground">{t('modes.cars.bestLap', 'Best valid lap')}: </span>
              <span className="font-mono tabular-nums">{track.bestLapMs !== null ? formatLapTime(track.bestLapMs) : '–'}</span>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('modes.cars.lastDriven', 'Last driven {{when}}', { when: when(Date.parse(track.lastDrivenAt)) })}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Virtual > Tracks: the tracks the person has driven (from the account, most recently driven first), a page at a time, with the number
 * of laps, the best valid lap, when each was last driven, and a small badge when Xpeed Companion has sent the layout of the track. A
 * track opens its own page. The list never opens a lap file.
 */
export function TracksList() {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const games = useGames();
  const [params, setParams] = useSearchParams();
  const game = params.get('game') ?? '';
  const overview = useOverview();
  const tracks = useTracks(game ? { game } : {});
  // The server says it (`hasLayout`); only a server that predates it makes the page read the layouts and match them itself.
  const layouts = useAccountLayouts(tracks.items.some((track) => track.hasLayout === undefined));

  const setGame = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('game', value);
    else next.delete('game');
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4" data-testid="tracks-list">
      <p className="text-sm text-muted-foreground">{t('modes.tracks.listIntro', 'The tracks you have driven. Open one to see your progress on it and your best lap with each car.')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <FilterSelect
          label={t('modes.sessions.filterGame', 'Game')}
          allLabel={t('modes.sessions.all', 'All')}
          value={game}
          onChange={setGame}
          options={(overview.data?.lapsPerGame ?? []).map((entry) => ({ value: entry.game, label: games.name(entry.game) }))}
          testId="filter-game"
        />
      </div>
      <QueryGate
        query={tracks}
        empty={tracks.items.length === 0}
        emptyNode={
          game ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground" data-testid="tracks-no-match">{t('modes.tracks.noMatch', 'No track of this game yet.')}</p>
          ) : (
            <CompanionInvite testId="tracks-empty" body={t('modes.tracks.emptyAccount', 'No tracks yet. Install Xpeed Companion and connect it to your account: the tracks you drive show up here.')} />
          )
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {tracks.items.map((track) => (
              <TrackCard key={track.id} track={track} layout={track.hasLayout ?? (!!layouts && hasSyncedLayout(layouts, track))} unit={distanceUnit as DistanceUnit} />
            ))}
          </div>
          <LoadMore hasNextPage={!!tracks.hasNextPage} isFetchingNextPage={tracks.isFetchingNextPage} onClick={() => void tracks.fetchNextPage()} />
        </div>
      </QueryGate>
    </div>
  );
}
