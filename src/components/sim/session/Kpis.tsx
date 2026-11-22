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
export function SessionKpiTiles({ kpis, pb, bestThreeMs, level = 'all' }: {
  kpis: SessionKpis;
  pb: V1Pb | null;
  bestThreeMs: number | null;
  /**
   * Which tiles (owner, 2026-11-22: XPD-D-SIMPLE-FIRST): `essential` (the best lap, how many laps counted, the top speed, the fuel) on top of the
   * page; `advanced` (the average, the consistency, the theoretical best) in the page's advanced fold; `all` for both.
   */
  level?: 'essential' | 'advanced' | 'all';
}) {
  const { t } = useTranslation();
  const { distanceUnit, volumeUnit } = useSettings();
  const format = useDashFormat();
  const unit = distanceUnit as DistanceUnit;
  const best = kpis.best;
  const behindPb = best && pb && best.id !== pb.lapId ? best.timeMs - pb.bestMs : null;
  const essential = level !== 'advanced';
  const advanced = level !== 'essential';

  return (
    <TileGrid testId={level === 'advanced' ? 'session-kpis-advanced' : 'session-kpis'} columns={{ sm: 3, lg: null, xl: 4 }}>
      {essential && <StatTile
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
      />}
      {advanced && <StatTile
        testId="kpi-average"
        label={t('sessionsDash.session.kpiAverage', 'Average valid lap')}
        value={kpis.averageMs !== null ? formatLapTime(kpis.averageMs) : '–'}
        mono
        hint={t('sessionsDash.session.averageHint', 'The mean of the valid laps, with the laps through the pits left out.')}
        sub={bestThreeMs !== null ? <span data-testid="best-three">{t('sessionsDash.session.bestThree', 'best 3: {{time}}', { time: formatLapTime(bestThreeMs) })}</span> : undefined}
      />}
      {advanced && <StatTile
        testId="kpi-spread"
        label={t('sessionsDash.session.kpiSpread', 'Consistency')}
        value={<span data-testid="spread">{kpis.spreadMs !== null ? `±${(kpis.spreadMs / 1000).toFixed(3)} s` : '–'}</span>}
        mono
        hint={t('modes.session.consistencyHint', 'How much your valid laps differ from each other. Smaller is steadier. Laps through the pits are left out.')}
        sub={kpis.spreadMs !== null ? t('sessionsDash.session.spreadSub', 'spread of the valid laps') : t('sessionsDash.session.spreadNone', 'needs 2 valid laps')}
      />}
      {essential && <StatTile
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
      />}
      {advanced && kpis.theoreticalMs !== null && (
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
      {essential && kpis.topSpeedKmh !== null && (
        <StatTile
          testId="kpi-topspeed"
          label={t('sessionsDash.session.kpiTopSpeed', 'Top speed')}
          value={`${speedIn(kpis.topSpeedKmh / 3.6, unit).toFixed(0)} ${speedLabel(unit)}`}
        />
      )}
      {essential && kpis.fuelPerLapL !== null && (
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
