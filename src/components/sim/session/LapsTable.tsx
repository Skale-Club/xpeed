import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowLeftRight, ArrowUp, ArrowUpDown, Award, LineChart, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ShareButton } from '@/components/social/ShareDialog';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { gapToBest, lapTags, sortLaps, type LapSortKey, type SortDirection } from '@/lib/sim/session-detail';
import type { V1Lap, V1Pb } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';
import { Panel } from '../overview/parts';

/** The first direction a column sorts in: laps and times from the lowest, the gap too (the best lap first). */
const FIRST: Record<LapSortKey, SortDirection> = { lap: 'asc', time: 'asc', gap: 'asc' };

function SortHeader({ label, sortKey, active, direction, onSort, align = 'left', className }: {
  label: string;
  sortKey: LapSortKey;
  active: boolean;
  direction: SortDirection;
  onSort: (key: LapSortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th scope="col" className={cn('py-1 font-normal', align === 'right' ? 'pr-3 text-right' : 'pr-2', className)} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active ? 'text-foreground' : 'text-muted-foreground')}
        data-testid={`sort-${sortKey}`}
      >
        {label}
        <Icon className={cn('h-3 w-3', !active && 'opacity-50')} aria-hidden="true" />
      </button>
    </th>
  );
}

/**
 * The laps of the session, in a table that sorts by lap, time or gap to the best lap (a click again reverses it; the laps the game voided stay below the
 * valid ones when sorting by time). Each lap has its status as chips and its actions: the analysis, a comparison with the personal best, a comparison with
 * the best lap of the session, share, and delete (which asks first).
 */
export function LapsTable({ laps, best, pb, shareLabel, shareTitle, deleting, onDeleteLap }: { laps: readonly V1Lap[]; best: V1Lap | null; pb: V1Pb | null; shareLabel: string; shareTitle: string; deleting: boolean; onDeleteLap: (lap: V1Lap) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: LapSortKey; direction: SortDirection }>({ key: 'lap', direction: 'asc' });
  const sorted = useMemo(() => sortLaps(laps, sort.key === 'gap' ? 'time' : sort.key, sort.direction), [laps, sort]);
  const onSort = (key: LapSortKey) => setSort((current) => (current.key === key ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: FIRST[key] }));
  const analyze = t('modes.session.analyze', 'Analyze');
  const tagLabels = {
    best: t('modes.sessions.isBest', 'Best lap'),
    pb: t('modes.session.pb', 'Personal best'),
    out: t('modes.session.outLap', 'Out lap'),
    in: t('modes.session.inLap', 'In lap'),
    void: t('modes.compare.notValid', 'not valid'),
  };

  return (
    <Panel title={t('modes.session.lapsTitle', 'Laps')} testId="laps-panel" action={<span className="text-xs text-muted-foreground">{t('sessionsDash.session.sortHint', 'Sort by lap, time or gap')}</span>}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm" data-testid="session-laps">
          <thead>
            <tr className="text-left">
              <SortHeader label={t('modes.compare.lap', 'Lap')} sortKey="lap" active={sort.key === 'lap'} direction={sort.direction} onSort={onSort} className="sticky left-0 z-10 bg-card" />
              <SortHeader label={t('modes.sessions.time', 'Time')} sortKey="time" active={sort.key === 'time'} direction={sort.direction} onSort={onSort} align="right" />
              <SortHeader label={t('modes.sessions.gap', 'Gap to best')} sortKey="gap" active={sort.key === 'gap'} direction={sort.direction} onSort={onSort} align="right" />
              <th scope="col" className="pr-3 text-xs font-normal text-muted-foreground">{t('modes.sessions.status', 'Status')}</th>
              <th scope="col" className="bg-card font-normal sm:sticky sm:right-0 sm:z-10"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((lap) => {
              const isBest = best?.id === lap.id;
              const isPb = pb?.lapId === lap.id;
              const gap = gapToBest(lap, best);
              const tags = lapTags(lap, best?.id ?? null, pb?.lapId ?? null);
              return (
                <tr key={lap.id} className={cn('border-t border-border', isBest && 'bg-green-500/5')} data-testid="session-lap" data-lap-id={lap.id}>
                  <td className="sticky left-0 z-10 whitespace-nowrap bg-card py-1.5 pr-2 tabular-nums">{lap.lapNumber}</td>
                  <td className={cn('whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums', !lap.valid && 'text-muted-foreground line-through decoration-muted-foreground/50')} data-testid="lap-time">{formatLapTime(lap.timeMs)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums text-muted-foreground" data-testid="lap-gap">
                    {gap !== null && !isBest ? formatGap(gap) : '–'}
                  </td>
                  <td className="py-1.5 pr-3">
                    <span className="flex flex-wrap gap-1" data-testid="lap-tags">
                      {tags.map((tag) =>
                        tag === 'best' ? <Badge key={tag}>{tagLabels[tag]}</Badge>
                        : tag === 'pb' ? <Badge key={tag} variant="secondary" className="gap-1"><Award className="h-3 w-3" aria-hidden="true" />{tagLabels[tag]}</Badge>
                        : tag === 'void' ? <Badge key={tag} variant="destructive">{tagLabels[tag]}</Badge>
                        : <Badge key={tag} variant="outline">{tagLabels[tag]}</Badge>,
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap bg-card py-1.5 pl-2 text-right sm:sticky sm:right-0 sm:z-10">
                    <span className="inline-flex items-center gap-0.5 sm:gap-1">
                      <Button asChild size="sm" variant="outline" className="h-8 px-2 xl:px-4">
                        <Link to={compareUrl(lap.id)} aria-label={`${analyze} ${lap.lapNumber}`} title={analyze}>
                          <LineChart className="h-4 w-4 xl:mr-2" aria-hidden="true" />
                          <span className="hidden xl:inline">{analyze}</span>
                        </Link>
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={!pb || isPb}
                        aria-label={t('modes.session.vsMyBest', 'Compare with my best')}
                        title={t('modes.session.vsMyBest', 'Compare with my best')}
                        onClick={() => pb && navigate(compareUrl(lap.id, pb.lapId))}
                      >
                        <Award className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={!best || isBest}
                        aria-label={t('modes.session.vsSessionBest', 'Compare with the session best')}
                        title={t('modes.session.vsSessionBest', 'Compare with the session best')}
                        onClick={() => best && navigate(compareUrl(lap.id, best.id))}
                      >
                        <ArrowLeftRight className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <ShareButton compact target={{ lapId: lap.id }} label={`${shareLabel} ${lap.lapNumber}`} title={shareTitle} />
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={deleting}
                        aria-label={`${t('modes.session.deleteLap', 'Delete lap')} ${lap.lapNumber}`}
                        title={t('modes.session.deleteLap', 'Delete lap')}
                        onClick={() => onDeleteLap(lap)}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
