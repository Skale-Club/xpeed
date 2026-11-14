import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Award, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { OptionSelect } from '@/components/ui/option-select';
import { formatLapTime } from '@/lib/sim/analysis';
import { bestLapOf } from '@/lib/sim/session-stats';
import { useLapMeta } from '@/lib/sim/use-lap-meta';
import { usePbs, useSession, useSessions, type V1Pb } from '@/lib/sim/v1-client';
import { useReadAllPages } from '../use-read-all-pages';

/**
 * Three ways to choose the reference without searching for a lap: your best on this track and car, the best lap of the session before this lap's session, and
 * the best lap of another car you drove on this track. The track, car and session of the lap come from its metadata (the lap file does not carry them), so the
 * last two appear once that is read; a button with nothing behind it is not shown. A choice goes to the address as the reference (`?b=`).
 */
export function QuickPickers({ lapId, referenceId, pb, onChoose }: { lapId: string; referenceId: string | null; pb: V1Pb | null; onChoose: (lapId: string) => void }) {
  const { t } = useTranslation();
  const meta = useLapMeta(lapId).data;
  const game = meta?.game;
  const trackId = meta?.track?.id;
  const carId = meta?.car?.id;

  // The session before this lap's session, on the same track and car, and its best lap.
  const sessions = useSessions({ game, track: trackId, car: carId }, { enabled: !!meta?.sessionId && !!trackId && !!carId });
  const previousSession = useMemo(() => {
    if (!meta?.sessionId) return null;
    const own = sessions.items.find((session) => session.id === meta.sessionId);
    const since = Date.parse(own?.startedAt ?? meta.startedAt);
    return sessions.items.find((session) => session.id !== meta.sessionId && Date.parse(session.startedAt) < since) ?? null;
  }, [sessions.items, meta]);
  const previous = useSession(previousSession?.id ?? null);
  const previousBest = useMemo(() => bestLapOf(previous.data?.laps ?? []), [previous.data]);

  // The best lap of every other car on this track.
  const bests = usePbs({ game, track: trackId }, { enabled: !!trackId });
  useReadAllPages(bests);
  const otherCars = useMemo(() => bests.items.filter((entry) => entry.car.id !== carId).sort((p, q) => p.bestMs - q.bestMs), [bests.items, carId]);

  const mineChosen = !!pb && referenceId === pb.lapId;
  const previousChosen = !!previousBest && referenceId === previousBest.id;
  const otherChosen = otherCars.find((entry) => entry.lapId === referenceId)?.lapId ?? '';

  // Nothing to offer (no personal best yet, no earlier session, no other car): no row of nothing.
  if (!pb && !previousBest && otherCars.length === 0) return null;

  return (
    <FilterBar role="group" aria-label={t('sessionsDash.compare.quickLabel', 'Quick references')} data-testid="quick-pickers">
      <span className="text-xs font-medium text-muted-foreground">{t('sessionsDash.compare.quickTitle', 'Compare with')}</span>
      {pb && (
        <Button
          type="button"
          size="sm"
          variant={mineChosen ? 'default' : 'outline'}
          className="h-8 text-xs"
          disabled={pb.lapId === lapId}
          aria-pressed={mineChosen}
          onClick={() => onChoose(pb.lapId)}
          data-testid="quick-mine"
        >
          <Award className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('sessionsDash.compare.quickMine', 'My best')}
          <span className="ml-1.5 font-mono text-xs tabular-nums opacity-80">{formatLapTime(pb.bestMs)}</span>
        </Button>
      )}
      {previousBest && previousSession && (
        <Button
          type="button"
          size="sm"
          variant={previousChosen ? 'default' : 'outline'}
          className="h-8 text-xs"
          aria-pressed={previousChosen}
          onClick={() => onChoose(previousBest.id)}
          data-testid="quick-previous"
        >
          <History className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {t('sessionsDash.compare.quickPrevious', 'Previous session’s best')}
          <span className="ml-1.5 font-mono text-xs tabular-nums opacity-80">{formatLapTime(previousBest.timeMs)}</span>
        </Button>
      )}
      {otherCars.length > 0 && (
        <OptionSelect
          size="sm"
          className="w-full min-w-0 sm:w-56"
          aria-label={t('sessionsDash.compare.quickOtherCar', 'Another car')}
          value={otherChosen}
          onChange={(value) => value && onChoose(value)}
          emptyLabel={`${t('sessionsDash.compare.quickOtherCar', 'Another car')}…`}
          options={otherCars.map((entry) => ({ value: entry.lapId, label: `${entry.car.name} · ${formatLapTime(entry.bestMs)}` }))}
          data-testid="quick-other-car"
        />
      )}
    </FilterBar>
  );
}
