import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatLapTime } from '@/lib/sim/analysis';
import type { SectorStrip, StripTone } from '@/lib/sim/sector-strip';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<StripTone, string> = { purple: 'font-semibold text-purple-500', yellow: 'text-yellow-500', none: 'text-muted-foreground' };

/** A sector time: `32.145` seconds. */
const sector = (ms: number | null) => (ms === null ? '–' : (ms / 1000).toFixed(3));
/** The times of the sectors added up, when every sector has one. */
const total = (values: Array<number | null>) => (values.length > 0 && values.every((ms): ms is number => ms !== null) ? values.reduce((sum, ms) => sum + ms, 0) : null);
const signedS = (ms: number | null) => (ms === null ? '–' : `${ms > 0 ? '+' : ms < 0 ? '−' : ''}${(Math.abs(ms) / 1000).toFixed(3)}`);

/**
 * The sectors of the two laps side by side with the usual colours (purple: the better of the two; yellow: slower), the time each
 * lap left on the table in each sector, and the theoretical best of the two laps: their best sectors put together.
 */
export function SectorStripCard({ strip }: { strip: SectorStrip }) {
  const { t } = useTranslation();
  const row = 'whitespace-nowrap py-1.5 pr-2 text-right font-mono tabular-nums sm:pr-3';
  const lapTotal = total(strip.sectors.map((s) => s.lapMs));
  const referenceTotal = total(strip.sectors.map((s) => s.referenceMs));
  return (
    <Card className="bg-card border-border" data-testid="sector-strip">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.analysis.sectorsTitle', 'Sectors')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th />
                {strip.sectors.map((s) => (
                  <th key={s.sector} scope="col" className="pr-3 text-right font-normal">{`S${s.sector}`}</th>
                ))}
                <th scope="col" className="text-right font-normal">{t('modes.analysis.sectorTotal', 'Total')}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border" data-testid="strip-lap">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{t('modes.compare.lap', 'Lap')}</th>
                {strip.sectors.map((s) => (
                  <td key={s.sector} className={cn(row, TONE_CLASS[s.lapTone])} data-testid="strip-lap-sector" data-tone={s.lapTone}>{sector(s.lapMs)}</td>
                ))}
                <td className={row} data-testid="strip-lap-total">{lapTotal === null ? '–' : formatLapTime(lapTotal)}</td>
              </tr>
              <tr className="border-t border-border" data-testid="strip-reference">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{t('modes.compare.reference', 'Reference')}</th>
                {strip.sectors.map((s) => (
                  <td key={s.sector} className={cn(row, TONE_CLASS[s.referenceTone])} data-testid="strip-reference-sector" data-tone={s.referenceTone}>{sector(s.referenceMs)}</td>
                ))}
                <td className={row} data-testid="strip-reference-total">{referenceTotal === null ? '–' : formatLapTime(referenceTotal)}</td>
              </tr>
              <tr className="border-t border-border" data-testid="strip-delta">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{t('modes.compare.difference', 'Difference')}</th>
                {strip.sectors.map((s) => (
                  <td key={s.sector} className={cn(row, s.deltaMs !== null && s.deltaMs > 0 ? 'text-destructive' : s.deltaMs !== null && s.deltaMs < 0 ? 'text-green-500' : 'text-muted-foreground')}>{signedS(s.deltaMs)}</td>
                ))}
                <td className={cn(row, lapTotal !== null && referenceTotal !== null && lapTotal > referenceTotal ? 'text-destructive' : lapTotal !== null && referenceTotal !== null && lapTotal < referenceTotal ? 'text-green-500' : 'text-muted-foreground')}>
                  {lapTotal !== null && referenceTotal !== null ? signedS(lapTotal - referenceTotal) : '–'}
                </td>
              </tr>
              <tr className="border-t border-border" data-testid="strip-left">
                <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{t('modes.analysis.leftOnTable', 'Left on the table')}</th>
                {strip.sectors.map((s) => (
                  <td key={s.sector} className={cn(row, s.lapLeftMs ? 'text-destructive' : 'text-muted-foreground')}>{s.lapLeftMs === null ? '–' : s.lapLeftMs === 0 ? '0.000' : `+${sector(s.lapLeftMs)}`}</td>
                ))}
                <td className={cn(row, strip.lapLeftMs ? 'text-destructive' : 'text-muted-foreground')} data-testid="strip-left-total">
                  {strip.lapLeftMs === null ? '–' : strip.lapLeftMs === 0 ? '0.000' : `+${sector(strip.lapLeftMs)}`}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm" data-testid="strip-theoretical">
          <span className="text-muted-foreground">{t('modes.analysis.theoretical', 'Theoretical best of the two laps (their best sectors put together)')}: </span>
          <span className="font-mono tabular-nums">{formatLapTime(strip.theoreticalBestMs)}</span>
          {strip.potentialGainMs !== null && strip.potentialGainMs > 0 && (
            <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">(−{(strip.potentialGainMs / 1000).toFixed(3)} s)</span>
          )}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <li><span className="font-semibold text-purple-500">{t('modes.session.legendPurple', 'Purple')}</span>: {t('modes.analysis.tonePurple', 'the better of the two in that sector')}</li>
          <li><span className="text-yellow-500">{t('modes.session.legendYellow', 'Yellow')}</span>: {t('modes.analysis.toneYellow', 'slower than the other lap')}</li>
        </ul>
      </CardContent>
    </Card>
  );
}
