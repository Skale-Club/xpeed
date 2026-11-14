import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime } from '@/lib/sim/analysis';
import { compareUrl } from '@/lib/sim/compare-url';
import { formatSector, type SectorBests } from '@/lib/sim/garage';
import { Panel, Quiet } from '../overview/parts';

/**
 * The fastest time in each sector over all your laps (purple: the best there is), who set it, and the theoretical lap they add up to (green) with
 * how much faster it is than your best lap. A bar shows how the best lap is split. Without sector times (a game that gives none, or no valid lap yet)
 * it says so and what is needed.
 */
export function SectorsPanel({ bests }: { bests: SectorBests | null }) {
  const { t } = useTranslation();
  const total = bests?.theoreticalMs ?? 0;
  return (
    <Panel title={t('garageDash.sectorsTitle', 'Sector bests')} testId="track-sectors">
      {!bests ? (
        <Quiet testId="track-sectors-empty">{t('garageDash.sectorsEmpty', 'No sector times yet. They show here once a valid lap with sector times is recorded on this track.')}</Quiet>
      ) : (
        <div className="space-y-3">
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">
            {bests.sectors.map((sector) => (
              <span key={sector.index} className="h-full rounded-sm" style={{ width: `${(sector.ms / total) * 100}%`, background: CHART_PALETTE.purple, opacity: sector.index % 2 === 0 ? 0.9 : 0.55 }} />
            ))}
          </div>
          <ol className="divide-y divide-border">
            {bests.sectors.map((sector) => (
              <li key={sector.index} className="flex items-center justify-between gap-3 py-2" data-testid="sector-best">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">{t('garageDash.sectorN', 'Sector {{n}}', { n: sector.index + 1 })}</p>
                  <p className="truncate text-xs text-muted-foreground" data-testid="sector-best-car">{sector.carName}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-base font-semibold tabular-nums" style={{ color: CHART_PALETTE.purple }} data-testid="sector-best-time">{formatSector(sector.ms)}</span>
                  {sector.lapId && (
                    <Link
                      to={compareUrl(sector.lapId)}
                      className="rounded-sm text-xs underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`${t('modes.session.analyze', 'Analyze')}: ${t('garageDash.sectorN', 'Sector {{n}}', { n: sector.index + 1 })}`}
                      data-testid="sector-best-lap"
                    >
                      {t('modes.session.analyze', 'Analyze')}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="space-y-0.5 rounded-lg border border-border bg-muted/30 p-3" data-testid="theoretical-best">
            <p className="text-xs text-muted-foreground">{t('garageDash.theoretical', 'Theoretical best lap')}</p>
            <p className="font-mono text-lg font-semibold tabular-nums" style={{ color: CHART_PALETTE.green }} data-testid="theoretical-time">{formatLapTime(bests.theoreticalMs)}</p>
            <p className="text-xs text-muted-foreground" data-testid="theoretical-gain">
              {bests.gainMs !== null && bests.gainMs > 0
                ? t('garageDash.theoreticalGain', '{{seconds}} s faster than your best lap, {{best}}', { seconds: (bests.gainMs / 1000).toFixed(3), best: formatLapTime(bests.bestLapMs as number) })
                : bests.gainMs === 0
                  ? t('garageDash.theoreticalSame', 'Your best lap already has the best of every sector.')
                  : t('garageDash.theoreticalNote', 'The best of every sector added up.')}
            </p>
          </div>
        </div>
      )}
    </Panel>
  );
}
