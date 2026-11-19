import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatLapTime } from '@/lib/sim/analysis';
import { driverPath, type BoardConditions as Conditions } from '@/lib/sim/social-client';
import { cn } from '@/lib/utils';
import { atHandle } from './social-utils';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** A sector time in seconds with three decimals (`29.000`): a sector is short, so the minutes of a lap time would only be noise. */
const sectorText = (ms: number) => (ms / 1000).toFixed(3);

/**
 * "Tyre: All, Medium (12), Soft (9)": one chip per compound that has laps on the board, with how many drivers drove it, and the one that is
 * chosen marked. It is only worth showing when the board has two or more compounds (with one, every chip would give the same board), except when
 * the address already names a tyre: then it stays so the person can clear it. Compound names are shown as the game writes them. The choice
 * belongs to the address (see LeaderboardScreen), so a link to a filtered board opens filtered.
 */
export function TyreChips({ conditions, tyre, onTyre }: { conditions: Conditions | undefined; tyre: string | null; onTyre: (tyre: string | null) => void }) {
  const { t } = useTranslation();
  const tyres = conditions?.tyres ?? [];
  if (!conditions || (tyres.length < 2 && !tyre)) return null;
  // A tyre the address names but the board does not have (an old link): shown, so that it is clear what is filtering.
  const listed = tyre && !tyres.some((entry) => entry.compound === tyre) ? [...tyres, { compound: tyre, drivers: 0 }] : tyres;
  const chip = (active: boolean) => cn(
    'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors hover:bg-muted/60',
    FOCUS,
    active ? 'border-primary bg-primary/10 font-medium text-foreground' : 'border-border bg-muted/30 text-muted-foreground',
  );
  return (
    <div role="group" aria-label={t('social.leaderboard.tyreGroup', 'Filter by tyre')} className="flex flex-wrap items-center gap-2" data-testid="board-tyres">
      <span className="text-xs text-muted-foreground">{t('social.leaderboard.tyre', 'Tyre')}</span>
      <button type="button" aria-pressed={tyre === null} className={chip(tyre === null)} onClick={() => onTyre(null)} data-testid="tyre-chip" data-tyre="">
        {t('social.leaderboard.tyreAll', 'All')}
      </button>
      {listed.map((entry) => (
        <button key={entry.compound} type="button" aria-pressed={tyre === entry.compound} className={chip(tyre === entry.compound)} onClick={() => onTyre(entry.compound)} data-testid="tyre-chip" data-tyre={entry.compound}>
          <span>{entry.compound}</span>
          {entry.drivers > 0 && (
            <span className="font-mono tabular-nums text-muted-foreground" aria-label={t('social.leaderboard.tyreDrivers', 'Drivers: {{count}}', { count: entry.drivers })}>{entry.drivers}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * "Theoretical best 1:28.000: S1 29.000 @bruno, S2 29.000 @ana, S3 30.000 @ana": the fastest of each sector on this board (the chosen tyre, when
 * there is one) and who drove it. It is the sum of the best sectors, so no lap has to be that fast; it only shows what the field could do on one
 * perfect lap. The server leaves it out (null) unless every lap on the board has the same number of sectors.
 */
export function TheoreticalBestLine({ best }: { best: Conditions['theoreticalBest'] | undefined }) {
  const { t } = useTranslation();
  if (!best || best.sectors.length === 0) return null;
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground" data-testid="board-theoretical">
      <span>
        {t('social.leaderboard.theoreticalBest', 'Theoretical best')}{' '}
        <span className="font-mono text-sm font-semibold tabular-nums text-foreground" data-testid="theoretical-time">{formatLapTime(best.timeMs)}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {best.sectors.map((sector) => (
          <span key={sector.index} className="whitespace-nowrap" data-testid="theoretical-sector">
            <span>{t('social.leaderboard.sectorShort', 'S{{n}}', { n: sector.index })}</span>{' '}
            <span className="font-mono tabular-nums text-foreground">{sectorText(sector.ms)}</span>{' '}
            <Link to={driverPath(sector.handle)} className={cn('rounded hover:underline', FOCUS)}>{atHandle(sector.handle)}</Link>
          </span>
        ))}
      </span>
    </p>
  );
}
