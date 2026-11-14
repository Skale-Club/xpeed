import { useTranslation } from 'react-i18next';
import { useSettings } from '@/contexts/SettingsContext';
import { litresPerUnit } from '@/lib/fuel-units';
import { formatGap, formatLapTime, speedIn, speedLabel, type DistanceUnit } from '@/lib/sim/analysis';
import type { SessionKpis } from '@/lib/sim/session-detail';
import type { V1Pb } from '@/lib/sim/v1-client';
import { StatTile, TileGrid } from '../StatTile';
import { useDashFormat } from '../overview/use-format';

/** A distance in time: `0.412 s`. */
const seconds = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

/**
 * The tiles of a session: the best lap (and how it stands against the personal best), the average and the spread of the valid laps, how many laps were valid
 * and clean, the theoretical best lap from the best sectors (and how much faster than the best lap it is), the top speed and the fuel a lap used when the laps
 * carry them. A tile whose number the laps do not carry is left out, not shown as zero.
 */
export function SessionKpiTiles({ kpis, pb, bestThreeMs }: { kpis: SessionKpis; pb: V1Pb | null; bestThreeMs: number | null }) {
  const { t } = useTranslation();
  const { distanceUnit, volumeUnit } = useSettings();
  const format = useDashFormat();
  const unit = distanceUnit as DistanceUnit;
  const best = kpis.best;
  const behindPb = best && pb && best.id !== pb.lapId ? best.timeMs - pb.bestMs : null;

  return (
    <TileGrid testId="session-kpis" columns="sm:grid-cols-3 xl:grid-cols-4">
      <StatTile
        testId="session-best"
        label={t('sessionsDash.session.kpiBest', 'Best lap')}
        value={best ? formatLapTime(best.timeMs) : '–'}
        mono
        tone={best ? 'accent' : 'plain'}
        sub={
          !best ? t('sessionsDash.session.noValid', 'no valid lap')
          : pb && best.id === pb.lapId ? t('sessionsDash.session.isPb', 'your personal best')
          : behindPb !== null ? t('sessionsDash.session.behindPb', '{{gap}} s from your personal best', { gap: formatGap(behindPb / 1000) })
          : t('sessionsDash.session.bestLapN', 'lap {{n}}', { n: best.lapNumber })
        }
      />
      <StatTile
        testId="kpi-average"
        label={t('sessionsDash.session.kpiAverage', 'Average valid lap')}
        value={kpis.averageMs !== null ? formatLapTime(kpis.averageMs) : '–'}
        mono
        hint={t('sessionsDash.session.averageHint', 'The mean of the valid laps, with the laps through the pits left out.')}
        sub={bestThreeMs !== null ? <span data-testid="best-three">{t('sessionsDash.session.bestThree', 'best 3: {{time}}', { time: formatLapTime(bestThreeMs) })}</span> : undefined}
      />
      <StatTile
        testId="kpi-spread"
        label={t('sessionsDash.session.kpiSpread', 'Consistency')}
        value={<span data-testid="spread">{kpis.spreadMs !== null ? `±${(kpis.spreadMs / 1000).toFixed(3)} s` : '–'}</span>}
        mono
        hint={t('modes.session.consistencyHint', 'Laps through the pits (out and in laps) are left out of the spread and of the clean-lap share; the spread is the standard deviation of the valid laps.')}
        sub={kpis.spreadMs !== null ? t('sessionsDash.session.spreadSub', 'spread of the valid laps') : t('sessionsDash.session.spreadNone', 'needs 2 valid laps')}
      />
      <StatTile
        testId="kpi-valid"
        label={t('sessionsDash.session.kpiValid', 'Valid laps')}
        value={kpis.validPercent !== null ? `${kpis.validPercent} %` : '–'}
        tone={kpis.validPercent !== null && kpis.validPercent < 60 ? 'bad' : 'plain'}
        sub={
          <>
            {t('sessionsDash.session.validOf', '{{valid}} of {{total}}', { valid: format.number(kpis.validLaps), total: format.number(kpis.laps) })}
            {kpis.cleanPercent !== null && (
              <>
                {' · '}
                <span data-testid="clean">{kpis.cleanPercent} %</span> {t('sessionsDash.session.clean', 'clean')}
              </>
            )}
          </>
        }
      />
      {kpis.theoreticalMs !== null && (
        <StatTile
          testId="kpi-theoretical"
          label={t('sessionsDash.session.kpiTheoretical', 'Theoretical best')}
          value={<span data-testid="theoretical-best">{formatLapTime(kpis.theoreticalMs)}</span>}
          mono
          hint={t('modes.session.theoretical', 'Theoretical best lap (the best sectors put together)')}
          sub={
            kpis.theoreticalGainMs !== null && kpis.theoreticalGainMs > 0
              ? <span data-testid="theoretical-gain">{t('sessionsDash.session.theoreticalGain', '{{gap}} faster than the best lap', { gap: seconds(kpis.theoreticalGainMs) })}</span>
              : t('sessionsDash.session.theoreticalNone', 'the best lap already has it all')
          }
        />
      )}
      {kpis.topSpeedKmh !== null && (
        <StatTile
          testId="kpi-topspeed"
          label={t('sessionsDash.session.kpiTopSpeed', 'Top speed')}
          value={`${speedIn(kpis.topSpeedKmh / 3.6, unit).toFixed(0)} ${speedLabel(unit)}`}
        />
      )}
      {kpis.fuelPerLapL !== null && (
        <StatTile
          testId="kpi-fuel"
          label={t('sessionsDash.session.kpiFuel', 'Fuel per lap')}
          value={`${(kpis.fuelPerLapL / litresPerUnit(volumeUnit)).toFixed(2)} ${volumeUnit === 'US gal' ? 'gal' : 'L'}`}
          sub={t('sessionsDash.session.fuelSub', 'laps through the pits left out')}
        />
      )}
    </TileGrid>
  );
}
