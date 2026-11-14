import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LineChart } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { formatSector, signedSeconds, type BoardRow, type SectorBests } from '@/lib/sim/garage';
import { carPath } from '@/lib/sim/routes';
import { Panel, Quiet } from '../overview/parts';
import { SimCarIdentity } from '../SimCarIdentity';
import { useWhen } from '../use-when';

/**
 * Your best lap with each car on the track, fastest first: the rank, the car (with its class), the lap, the gap to the fastest car and, from a
 * medium screen up, each sector of that car's best sectors (purple where it is the best of all your laps). Each car opens its page, each lap its analysis.
 */
export function TrackBoard({ board, sectors }: { board: readonly BoardRow[]; sectors: SectorBests | null }) {
  const { t } = useTranslation();
  const when = useWhen('date');
  const count = sectors?.sectors.length ?? 0;
  const showSectors = count > 0 && board.some((row) => row.sectorsMs?.length === count);
  return (
    <Panel title={t('modes.trackPage.bestPerCar', 'Best lap with each car')} testId="best-per-car">
      {board.length === 0 ? (
        <Quiet>{t('garageDash.noCarsYet', 'No car has a lap here yet.')}</Quiet>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t('garageDash.boardCaption', 'Your best valid lap with each car on this track, the fastest first, with the gap to the fastest car.')}</caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-2 font-medium"><span className="sr-only">{t('garageDash.rank', 'Rank')}</span><span aria-hidden="true">#</span></th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t('modes.detail.car', 'Car')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('modes.cars.bestLap', 'Best valid lap')}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t('garageDash.gap', 'Gap')}</th>
                {showSectors && sectors?.sectors.map((sector) => (
                  <th key={sector.index} scope="col" className="hidden py-1.5 pr-3 text-right font-medium md:table-cell">{t('garageDash.sectorShort', 'S{{n}}', { n: sector.index + 1 })}</th>
                ))}
                <th scope="col" className="hidden py-1.5 pr-3 text-right font-medium sm:table-cell">{t('modes.detail.laps', 'Laps')}</th>
                <th scope="col" className="hidden py-1.5 pr-3 font-medium lg:table-cell">{t('modes.detail.when', 'Set on')}</th>
                <th scope="col" className="py-1.5 font-medium"><span className="sr-only">{t('modes.session.actions', 'Actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {board.map((entry) => (
                <tr key={entry.car.id} className="hover:bg-muted/40" data-testid="best-car-row">
                  <td className="py-2 pr-2 align-middle tabular-nums text-muted-foreground" data-testid="best-car-rank">{entry.rank ?? '–'}</td>
                  <td className="max-w-[6.5rem] py-2 pr-2 align-middle sm:max-w-[18rem] sm:pr-3">
                    <Link to={carPath(entry.car.id)} className="inline-flex max-w-full min-w-0 rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="best-car-link">
                      <SimCarIdentity name={entry.car.name} />
                    </Link>
                    {entry.car.class && <Badge variant="outline" className="ml-2 hidden align-middle sm:inline-flex">{entry.car.class}</Badge>}
                    {entry.bestMs === null && <p className="mt-0.5 text-xs text-muted-foreground">{t('garageDash.noValidYet', 'No valid lap yet')}</p>}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono tabular-nums" data-testid="best-car-time">{entry.bestMs !== null ? formatLapTime(entry.bestMs) : '–'}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right align-middle font-mono text-xs tabular-nums" data-testid="best-car-gap">
                    {entry.deltaMs === null ? <span className="text-muted-foreground">–</span> : entry.deltaMs === 0 ? <span className="font-sans font-medium text-success">{t('garageDash.fastest', 'Fastest')}</span> : <span className="text-muted-foreground">{signedSeconds(entry.deltaMs)}</span>}
                  </td>
                  {showSectors && sectors?.sectors.map((sector, index) => {
                    const ms = entry.sectorsMs?.length === count ? entry.sectorsMs[index] : null;
                    const best = ms !== null && ms === sector.ms;
                    return (
                      <td key={sector.index} className="hidden whitespace-nowrap py-2 pr-3 text-right align-middle font-mono text-xs tabular-nums md:table-cell" data-testid="best-car-sector" data-best={best || undefined} style={best ? { color: CHART_PALETTE.purple } : undefined}>
                        {ms !== null ? formatSector(ms) : '–'}
                      </td>
                    );
                  })}
                  <td className="hidden whitespace-nowrap py-2 pr-3 text-right align-middle tabular-nums sm:table-cell">{entry.lapCount}</td>
                  <td className="hidden whitespace-nowrap py-2 pr-3 align-middle text-xs text-muted-foreground lg:table-cell">{entry.achievedAt ? when(Date.parse(entry.achievedAt)) : '–'}</td>
                  <td className="whitespace-nowrap py-2 text-right align-middle">
                    {entry.lapId && (
                      <Button asChild size="sm" variant="outline" className="h-8 px-2">
                        <Link to={compareUrl(entry.lapId)} aria-label={`${t('modes.session.analyze', 'Analyze')}: ${entry.car.name}`} title={t('modes.session.analyze', 'Analyze')} data-testid="best-car-analyze">
                          <LineChart className="h-4 w-4" aria-hidden="true" />
                        </Link>
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
