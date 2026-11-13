import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatGap, lengthIn, lengthLabel, speedIn, speedLabel, type DistanceUnit } from '@/lib/sim/analysis';
import type { CornerDelta } from '@/lib/sim/corner-compare';
import { cornerRange, cornerRows, unmatchedCorners, type CornerOrder, type Range, type RowTone } from '@/lib/sim/corner-table';
import type { Study } from '@/lib/sim/lap-study-client';
import type { LapStudy } from '@/lib/sim/lap-study-core';
import { cn } from '@/lib/utils';
import { WhyNotComparable } from './WhereTimeWent';

const TONE_CLASS: Record<RowTone, string> = { loss: 'text-destructive', gain: 'text-green-500', even: 'text-muted-foreground' };

/** A signed difference with its unit; a dash where the lap has no such figure. */
const signed = (value: number | null, digits = 1) => {
  if (value === null || !Number.isFinite(value)) return '–';
  const text = Math.abs(value).toFixed(digits);
  // A difference that rounds to nothing has no sign.
  return Number(text) === 0 ? text : `${value > 0 ? '+' : '−'}${text}`;
};

/** Why the corner lost time, as a word, when the data says; a corner that did not lose time has none. */
function useCauseLabel() {
  const { t } = useTranslation();
  return (corner: CornerDelta): { label: string; tone: 'cause' | 'unknown' | 'none' } | null => {
    if (corner.deltaTime < 0.02) return null;
    if (corner.dominantCause !== 'none') {
      const label = {
        brakesEarly: t('modes.analysis.cause.brakesEarly', 'Brakes early'),
        brakesLate: t('modes.analysis.cause.brakesLate', 'Brakes late'),
        lowMinSpeed: t('modes.analysis.cause.lowMinSpeed', 'Low corner speed'),
        latePickup: t('modes.analysis.cause.latePickup', 'Late on throttle'),
        slowExit: t('modes.analysis.cause.slowExit', 'Slow exit'),
        wrongGear: t('modes.analysis.cause.wrongGear', 'Different gear'),
        line: t('modes.analysis.cause.line', 'Different line'),
      }[corner.dominantCause];
      return { label, tone: 'cause' };
    }
    return corner.missing.length > 0
      ? { label: t('modes.analysis.cause.unknown', 'Cannot tell'), tone: 'unknown' }
      : { label: t('modes.analysis.cause.noneFound', 'No clear cause'), tone: 'none' };
  };
}

/**
 * The corner table: one row per corner, in the order of the track (or the biggest loss first), with the time gained or lost, why,
 * and the differences that explain it (entry, minimum and exit speed, brake point, throttle pickup). A click on a row zooms the
 * charts and the map to that corner. The corners only one of the two laps had are listed apart.
 */
export function CornerTable({ study, lapLengthM, unit, selected, onSelect, onReset }: {
  study: Study<LapStudy>;
  lapLengthM: number;
  unit: DistanceUnit;
  /** The corner the charts are zoomed to (its number on the reference lap), or null for the whole lap. */
  selected: number | null;
  onSelect: (corner: CornerDelta, range: Range) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<CornerOrder>('track');
  const cause = useCauseLabel();
  const speed = (kmh: number | null) => signed(kmh === null ? null : speedIn(kmh / 3.6, unit), 1);
  const metres = (m: number | null) => signed(m === null ? null : lengthIn(m, unit), 0);

  const title = (
    <CardHeader className="pb-1">
      <CardTitle className="text-sm font-semibold">{t('modes.analysis.cornersTitle', 'Corner by corner')}</CardTitle>
    </CardHeader>
  );
  if (study.status !== 'ready') {
    return (
      <Card className="bg-card border-border" data-testid="corner-table-loading">
        {title}
        <CardContent className="space-y-2 pb-3" role="status" aria-label={t('modes.analysis.working', 'Working out the corners…')}>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </CardContent>
      </Card>
    );
  }
  const comparison = study.value.comparison;
  if (!comparison.comparable) {
    return (
      <Card className="bg-card border-border" data-testid="corner-table-unavailable">
        {title}
        <CardContent className="pb-3"><WhyNotComparable reason={comparison.reason} /></CardContent>
      </Card>
    );
  }
  const rows = cornerRows(comparison, order);
  const apart = unmatchedCorners(comparison);
  const d = lengthLabel(unit);
  const v = speedLabel(unit);
  const head = 'whitespace-nowrap py-1.5 pr-3 text-right font-normal';

  return (
    <Card className="bg-card border-border" data-testid="corner-table">
      {title}
      <CardContent className="space-y-3 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t('modes.analysis.cornersHint', 'Lap minus reference. Tap a corner to zoom the charts and the map to it.')}</p>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOrder(order === 'track' ? 'loss' : 'track')} data-testid="corner-sort">
              {order === 'track' ? t('modes.analysis.sortLoss', 'Biggest loss first') : t('modes.analysis.sortTrack', 'In track order')}
            </Button>
            {selected !== null && (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onReset} data-testid="show-whole-lap">
                {t('modes.analysis.showWhole', 'Show whole lap')}
              </Button>
            )}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="corner-none">{t('modes.analysis.noCorners', 'No corner could be matched on both laps.')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm" data-testid="corner-rows">
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="sticky left-0 z-10 bg-card py-1.5 pr-3 text-left font-normal">{t('modes.analysis.col.corner', 'Corner')}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.time', 'Time (s)')}</th>
                  <th scope="col" className="py-1.5 pr-3 text-left font-normal">{t('modes.analysis.col.cause', 'Why')}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.entry', 'Entry ({{unit}})', { unit: v })}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.min', 'Minimum ({{unit}})', { unit: v })}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.exit', 'Exit ({{unit}})', { unit: v })}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.brake', 'Brake point ({{unit}})', { unit: d })}</th>
                  <th scope="col" className={head}>{t('modes.analysis.col.pickup', 'Throttle ({{unit}})', { unit: d })}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ corner, tone }) => {
                  const why = cause(corner);
                  const isSelected = selected === corner.index;
                  const choose = () => onSelect(corner, cornerRange(corner, lapLengthM));
                  return (
                    <tr
                      key={corner.index}
                      className={cn('cursor-pointer border-t border-border hover:bg-muted/40', isSelected && 'bg-muted/60')}
                      onClick={choose}
                      data-testid="corner-row"
                      data-corner={corner.index}
                      data-tone={tone}
                      data-selected={isSelected ? 'true' : undefined}
                    >
                      <th scope="row" className={cn('sticky left-0 z-10 py-1 pr-3 text-left font-normal', isSelected ? 'bg-muted' : 'bg-card')}>
                        <button
                          type="button"
                          className="rounded px-1 py-0.5 font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t('modes.analysis.zoomTo', 'Zoom to corner {{corner}}', { corner: corner.index })}
                          aria-pressed={isSelected}
                          onClick={(event) => {
                            event.stopPropagation();
                            choose();
                          }}
                        >
                          {corner.index}
                        </button>
                      </th>
                      <td className={cn('whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums', TONE_CLASS[tone])} data-testid="corner-time">{formatGap(corner.deltaTime)}</td>
                      <td className="py-1.5 pr-3" data-testid="corner-cause">
                        {why ? <Badge variant={why.tone === 'cause' ? 'secondary' : 'outline'} className="whitespace-nowrap">{why.label}</Badge> : <span className="text-muted-foreground">–</span>}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{speed(corner.entrySpeedKmh)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{speed(corner.minSpeedKmh)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{speed(corner.exitSpeedKmh)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums" data-testid="corner-brake">{metres(corner.brakePointM)}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{metres(corner.throttlePickupM)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <p className="font-mono text-xs tabular-nums text-muted-foreground" data-testid="corner-totals">
            {t('modes.analysis.totalsLine', 'Corners {{corners}} s · straights {{straights}} s · whole lap {{lap}} s', {
              corners: formatGap(comparison.totals.cornersS),
              straights: formatGap(comparison.totals.straightsS),
              lap: formatGap(comparison.totals.lapS),
            })}
          </p>
        )}

        {apart.length > 0 && (
          <div data-testid="corner-unmatched" className="rounded-md border border-dashed border-border p-2">
            <p className="text-xs font-medium">{t('modes.analysis.unmatchedTitle', 'Found on only one of the two laps')}</p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {apart.map((c) => (
                <li key={`${c.side}-${c.index}`} data-testid="unmatched-corner" data-side={c.side}>
                  {t(c.side === 'lap' ? 'modes.analysis.unmatchedLap' : 'modes.analysis.unmatchedReference', c.side === 'lap' ? 'A corner at {{at}} {{unit}} (about {{speed}} {{speedUnit}} at its slowest) is only on the lap.' : 'A corner at {{at}} {{unit}} (about {{speed}} {{speedUnit}} at its slowest) is only on the reference.', {
                    at: Math.round(lengthIn(c.apexM, unit)),
                    unit: d,
                    speed: Math.round(speedIn(c.minSpeedKmh / 3.6, unit)),
                    speedUnit: v,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
