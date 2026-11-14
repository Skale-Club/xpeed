import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Panel } from '../overview/parts';
import { formatGap, formatLapTime } from '@/lib/sim/analysis';
import { sectorBestHolders, sectorCell, sectorScales, sectorText, type HeatLevel } from '@/lib/sim/session-detail';
import { bestSectors, sectorTone, theoreticalBest, type SectorTone } from '@/lib/sim/session-stats';
import type { V1Lap, V1Pb } from '@/lib/sim/v1-client';
import { cn } from '@/lib/utils';

/** The background of a sector time by how far it is from the best of the session, on the scale of that sector: purple for the best, then from nothing to red. */
const HEAT: Record<HeatLevel, string> = {
  0: 'bg-purple-500/25 font-semibold text-purple-400',
  1: 'bg-muted/30',
  2: 'bg-yellow-500/10',
  3: 'bg-orange-500/20',
  4: 'bg-red-500/25',
};

/**
 * The sector times of the session as a heat map: a row per lap, a column per sector, each time shaded by how far it is from the best of the session in that
 * sector (purple is the best, then fading to red), with the gap written under the time (the colour is never the only cue). The sector of the person's
 * personal-best lap is ringed green. Laps through the pits and laps the game voided are shown quiet and uncoloured. The row on top has the best of each sector
 * and the lap that holds it; the one at the bottom is the theoretical best lap, the best sectors put together.
 */
export function SectorHeatTable({ laps, pb, bestId }: { laps: readonly V1Lap[]; pb: V1Pb | null; bestId: string | null }) {
  const { t } = useTranslation();
  const bests = useMemo(() => bestSectors(laps), [laps]);
  const scales = useMemo(() => sectorScales(laps, bests), [laps, bests]);
  const holders = useMemo(() => sectorBestHolders(laps, bests), [laps, bests]);
  const theoretical = theoreticalBest(bests);
  const toneTitle = (tone: SectorTone) =>
    tone === 'purple' ? t('modes.session.tonePurple', 'Best of the session in this sector')
    : tone === 'green' ? t('modes.session.toneGreen', 'Your personal best lap')
    : tone === 'yellow' ? t('modes.session.toneYellow', 'Slower than the session best')
    : undefined;
  const ranked = laps.filter((lap) => lap.sectorsMs && lap.sectorsMs.length > 0);
  if (bests.length === 0) return null;

  return (
    <Panel title={t('sessionsDash.session.sectorsTitle', 'Sectors')} testId="sector-heat" action={<span className="text-xs text-muted-foreground">{t('sessionsDash.session.sectorsSub', 'against the best of the session')}</span>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] border-separate border-spacing-y-0.5 text-xs sm:text-sm" data-testid="sector-table">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-card py-1 pr-2 font-normal">{t('modes.compare.lap', 'Lap')}</th>
              {bests.map((_, i) => (
                <th key={i} scope="col" className="px-1 py-1 text-right font-normal">{`S${i + 1}`}</th>
              ))}
              <th scope="col" className="px-1 py-1 text-right font-normal">{t('modes.sessions.time', 'Time')}</th>
            </tr>
            <tr data-testid="best-sectors">
              <th scope="row" className="sticky left-0 z-10 bg-card py-1 pr-2 text-left text-xs font-normal text-muted-foreground">{t('modes.session.bestSectors', 'Best sectors')}</th>
              {bests.map((ms, i) => (
                <td key={i} className="px-1 py-1 text-right font-mono tabular-nums text-purple-400" data-testid="best-sector">
                  {ms !== null ? sectorText(ms) : '–'}
                  {holders[i] !== null && <span className="block text-[10px] font-sans text-muted-foreground">{t('sessionsDash.session.heldBy', 'lap {{n}}', { n: holders[i] })}</span>}
                </td>
              ))}
              <td className="px-1 py-1 text-right font-mono tabular-nums text-muted-foreground" data-testid="best-sectors-total">{theoretical !== null ? formatLapTime(theoretical) : '–'}</td>
            </tr>
          </thead>
          <tbody>
            {ranked.map((lap) => (
              <tr key={lap.id} data-testid="sector-row" data-lap-id={lap.id} className={cn(!lap.valid && 'text-muted-foreground')}>
                <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-card py-1 pr-2 text-left font-normal">
                  {lap.lapNumber}
                  {lap.id === bestId && <span className="ml-1 text-[10px] font-semibold text-green-500">{t('sessionsDash.session.bestShort', 'best')}</span>}
                </th>
                {bests.map((best, i) => {
                  const cell = sectorCell(lap, i, bests, scales);
                  const tone = sectorTone(lap, i, bests, pb);
                  const level = cell.level;
                  return (
                    <td
                      key={i}
                      className={cn(
                        'whitespace-nowrap rounded px-1 py-1 text-right font-mono tabular-nums',
                        level !== null && HEAT[level],
                        cell.kind === 'pit' && 'italic text-muted-foreground opacity-70',
                        cell.kind === 'none' && 'text-muted-foreground',
                        tone === 'green' && 'text-green-500 ring-1 ring-inset ring-green-500/60',
                      )}
                      data-testid="lap-sector"
                      data-tone={tone}
                      data-heat={level ?? undefined}
                      data-kind={cell.kind}
                      title={toneTitle(tone)}
                    >
                      {cell.ms !== null ? sectorText(cell.ms) : '–'}
                      {cell.kind === 'time' && cell.deltaMs !== null && best !== null && (
                        <span className="block text-[10px] font-normal opacity-80" data-testid="sector-delta">{cell.deltaMs <= 0 ? '' : formatGap(cell.deltaMs / 1000)}</span>
                      )}
                    </td>
                  );
                })}
                <td className="whitespace-nowrap px-1 py-1 text-right font-mono tabular-nums text-muted-foreground">{lap.timeMs > 0 ? formatLapTime(lap.timeMs) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="sector-legend">
        <li className="flex items-center gap-1.5"><span className={cn('h-3 w-5 rounded', HEAT[0])} aria-hidden="true" /><span><span className="font-semibold text-purple-400">{t('modes.session.legendPurple', 'Purple')}</span>: {t('modes.session.tonePurple', 'Best of the session in this sector')}</span></li>
        <li className="flex items-center gap-1.5"><span className="h-3 w-5 rounded ring-1 ring-inset ring-green-500/60" aria-hidden="true" /><span><span className="font-semibold text-green-500">{t('modes.session.legendGreen', 'Green')}</span>: {t('modes.session.toneGreen', 'Your personal best lap')}</span></li>
        <li className="flex items-center gap-1.5">
          <span className="flex overflow-hidden rounded" aria-hidden="true">
            {([1, 2, 3, 4] as const).map((level) => <span key={level} className={cn('h-3 w-4', HEAT[level])} />)}
          </span>
          {t('sessionsDash.session.legendScale', 'Further from the best, from close to far')}
        </li>
      </ul>
    </Panel>
  );
}
