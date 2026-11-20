// The dashboards of one trip: the headline numbers, the speed over the trip
// and where the time went, the engine's warm-up, and the hybrid system.
// Everything comes from analyseTrip(); a dashboard whose readings the car
// didn't send is left out instead of drawn empty.

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Battery, Gauge, Leaf, OctagonPause, Route, Thermometer, Timer, TrendingDown, TrendingUp, Zap, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { lazyChart } from '@/components/LazyChart';
import { useSettings } from '@/contexts/SettingsContext';
import { temperatureLabel, temperatureValue } from '@/lib/temperature';
import { tokenColor } from '@/lib/design-tokens';
import { formatDuration } from '@/lib/trips';
import { ROAD_KMH, TOWN_KMH, WARM_C, type DrivingMix, type TripAnalysis, type TripKey } from '@/lib/trip-analysis';

const TripTimeChart = lazyChart(() => import('./TripTimeChart'), 'h-[200px]');

const MAX_CHART_POINTS = 600;
const KMH_TO_MPH = 0.621371;

export interface TripStat { icon: LucideIcon; label: string; value: string; hint?: string | null }

/** Shorter than a minute reads in seconds; the rest like the rest of the app ("11 min", "1 h 05 min"). */
function shortDuration(seconds: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  return seconds < 60 ? t('tripDash.seconds', { count: Math.round(seconds), defaultValue: '{{count}} s' }) : formatDuration(seconds) ?? '';
}

function series(points: TripAnalysis['points'], key: TripKey, convert: (v: number) => number = (v) => v) {
  const all = points.flatMap((p) => (p[key] != null ? [{ t: p.t, v: convert(p[key]!) }] : []));
  if (all.length <= MAX_CHART_POINTS) return all;
  const step = all.length / MAX_CHART_POINTS;
  return Array.from({ length: MAX_CHART_POINTS }, (_, i) => all[Math.floor(i * step)]).concat(all[all.length - 1]);
}

function DashCard({ icon: Icon, title, aside, children, className = '' }: { icon: LucideIcon; title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="flex-1 font-semibold">{title}</h3>
          {aside}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function Fact({ icon: Icon, label, value, tone }: { icon?: LucideIcon; label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/40 px-3 py-2">
      <p className="flex items-start gap-1.5 text-2xs leading-tight text-muted-foreground">
        {Icon && <Icon className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />}<span>{label}</span>
      </p>
      <p className={`font-semibold tabular-nums ${tone === 'warn' ? 'text-warn' : ''}`}>{value}</p>
    </div>
  );
}

const STAT_COLUMNS: Record<number, string> = { 1: 'lg:grid-cols-1', 2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4' };

/** The trip's headline numbers as tiles, filling one row on wide screens. */
export function TripStats({ stats }: { stats: TripStat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${STAT_COLUMNS[stats.length] ?? 'lg:grid-cols-5'}`} data-testid="trip-stats">
      {stats.map(({ icon: Icon, label, value, hint }) => (
        <Card key={label}>
          <CardContent className="p-3">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden="true" />{label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
            {hint && <p className="text-2xs text-muted-foreground">{hint}</p>}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

const MIX_ORDER: (keyof DrivingMix)[] = ['stopped', 'town', 'road', 'motorway'];
const MIX_COLOR: Record<keyof DrivingMix, string> = {
  stopped: 'hsl(var(--muted-foreground) / 0.45)',
  town: tokenColor('brand', 0.4),
  road: tokenColor('brand', 0.7),
  motorway: tokenColor('brand'),
};

/** How the trip's time split between standing, town, road and motorway speeds. */
function DrivingMixBar({ mix }: { mix: DrivingMix }) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const total = MIX_ORDER.reduce((sum, k) => sum + mix[k], 0);
  if (total <= 0) return null;
  const mph = distanceUnit === 'mi';
  const unit = mph ? 'mph' : 'km/h';
  const town = Math.round(mph ? TOWN_KMH * KMH_TO_MPH : TOWN_KMH);
  const road = Math.round(mph ? ROAD_KMH * KMH_TO_MPH : ROAD_KMH);
  const labels: Record<keyof DrivingMix, string> = {
    stopped: t('tripDash.mix.stopped', 'Standing'),
    town: t('tripDash.mix.town', { v: town, unit, defaultValue: 'Town · under {{v}} {{unit}}' }),
    road: t('tripDash.mix.road', { a: town, b: road, unit, defaultValue: 'Road · {{a}}–{{b}} {{unit}}' }),
    motorway: t('tripDash.mix.motorway', { v: road, unit, defaultValue: 'Motorway · over {{v}} {{unit}}' }),
  };
  const shown = MIX_ORDER.filter((k) => mix[k] > 0);
  return (
    <div className="space-y-2" data-testid="driving-mix">
      <p className="text-sm font-medium">{t('tripDash.mixTitle', 'Where the time went')}</p>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={shown.map((k) => `${labels[k]} ${Math.round((mix[k] / total) * 100)}%`).join(', ')}>
        {shown.map((k) => <div key={k} style={{ width: `${(mix[k] / total) * 100}%`, background: MIX_COLOR[k] }} />)}
      </div>
      <ul className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {shown.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: MIX_COLOR[k] }} aria-hidden="true" />
            <span className="flex-1 truncate text-muted-foreground">{labels[k]}</span>
            <span className="tabular-nums">{Math.round((mix[k] / total) * 100)}%</span>
            <span className="w-16 text-right tabular-nums text-muted-foreground">{shortDuration(mix[k], t)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface TripDashboardsProps {
  analysis: TripAnalysis;
  /** Average speed of the whole trip in km/h, drawn across the speed chart. */
  avgSpeed: number | null;
  /** More cards for the grid under the speed dashboard (fuel). */
  extraCards?: ReactNode[];
}

export function TripDashboards({ analysis: a, avgSpeed, extraCards = [] }: TripDashboardsProps) {
  const { t, i18n } = useTranslation();
  const { distanceUnit, temperatureUnit } = useSettings();
  const lang = i18n.resolvedLanguage;
  const mph = distanceUnit === 'mi';
  const speedUnit = mph ? 'mph' : 'km/h';
  const toSpeed = (v: number) => (mph ? v * KMH_TO_MPH : v);
  const tempUnit = temperatureLabel('°C', temperatureUnit);
  const toTemp = (v: number) => temperatureValue(v, '°C', temperatureUnit);
  const num = (v: number, digits = 0) => v.toLocaleString(lang, { maximumFractionDigits: digits });

  const cards: ReactNode[] = [];

  // Engine: how it warmed up and how hot it got.
  if (a.warmup || a.maxRpm != null) {
    const w = a.warmup;
    const warmLine = !w ? null
      : w.startedWarm ? t('tripDash.startedWarm', { temp: `${num(toTemp(w.startC))} ${tempUnit}`, defaultValue: 'The engine was already warm ({{temp}}).' })
      : w.warmAfterSeconds != null ? t('tripDash.warmAfter', { time: shortDuration(w.warmAfterSeconds, t), defaultValue: 'Warmed up after {{time}}.' })
      : t('tripDash.neverWarm', { temp: `${num(toTemp(w.maxC))} ${tempUnit}`, defaultValue: "Didn't fully warm up (highest {{temp}}). Short trips like this wear the engine more." });
    cards.push(
      <DashCard key="engine" icon={Thermometer} title={t('tripDash.engineTitle', 'Engine')}>
        {warmLine && <p className="text-sm">{warmLine}</p>}
        {a.has.coolant && (
          <TripTimeChart
            data={series(a.points, 'coolant', toTemp)} color={tokenColor('chart-7')} unit={tempUnit}
            label={t('tripDash.coolantChart', 'Engine temperature')}
            reference={{ value: toTemp(WARM_C), label: t('tripDash.warm', 'warm'), color: tokenColor('success') }}
            domain={['auto', 'auto']} height={160}
          />
        )}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {w && <Fact icon={Thermometer} label={t('tripDash.maxCoolant', 'Highest temperature')} value={`${num(toTemp(w.maxC))} ${tempUnit}`} />}
          {a.maxRpm != null && <Fact icon={Gauge} label={t('tripDash.maxRpm', 'Highest RPM')} value={num(a.maxRpm)} />}
          {a.idleSeconds != null && <Fact icon={Timer} label={t('tripDash.idle', 'Engine idling')} value={a.idleSeconds > 0 ? shortDuration(a.idleSeconds, t) : '0'} />}
        </div>
      </DashCard>,
    );
  }

  // Hybrid system: electric-only driving and the battery's charge.
  if (a.electricShare != null || a.soc) {
    cards.push(
      <DashCard key="hybrid" icon={Leaf} title={t('tripDash.hybridTitle', 'Hybrid system')}>
        {a.electricShare != null && (
          <div className="flex items-baseline gap-3">
            <p className="text-3xl font-bold tabular-nums text-success">{Math.round(a.electricShare * 100)}%</p>
            <p className="text-sm text-muted-foreground">{t('tripDash.electricShare', 'of the time moving was electric only, with the engine off')}</p>
          </div>
        )}
        {a.soc && (
          <>
            <TripTimeChart
              data={series(a.points, 'soc')} color={tokenColor('success')} unit="%"
              label={t('tripDash.socChart', 'Hybrid battery charge')} domain={[0, 100]} height={140}
            />
            <div className="grid grid-cols-2 gap-2">
              <Fact icon={Battery} label={t('tripDash.socStartEnd', 'Charge at start → end')} value={`${num(a.soc.start)}% → ${num(a.soc.end)}%`} />
              <Fact icon={Zap} label={t('tripDash.socRange', 'Lowest – highest')} value={`${num(a.soc.min)}% – ${num(a.soc.max)}%`} />
            </div>
          </>
        )}
      </DashCard>,
    );
  }

  cards.push(...extraCards);

  return (
    <div className="space-y-5">
      {a.has.speed ? (
        <DashCard
          icon={Route} title={t('tripDash.speedTitle', 'Speed')}
          aside={a.topSpeed != null && <span className="text-xs text-muted-foreground">{t('tripDash.topSpeed', 'Top speed')}: <span className="font-semibold text-foreground tabular-nums">{num(toSpeed(a.topSpeed))} {speedUnit}</span></span>}
        >
          <TripTimeChart
            data={series(a.points, 'speed', toSpeed)} color={tokenColor('brand')} unit={speedUnit}
            label={t('tripDash.speedChart', 'Speed over the trip')}
            reference={avgSpeed != null ? { value: toSpeed(avgSpeed), label: t('tripDash.avg', 'average'), color: 'hsl(var(--muted-foreground))' } : null}
            height={220}
          />
          {a.mix && <DrivingMixBar mix={a.mix} />}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Fact icon={OctagonPause} label={t('tripDash.stops', 'Stops')} value={num(a.stops)} />
            {a.movingAvgSpeed != null && <Fact icon={Gauge} label={t('tripDash.movingAvg', 'Average while moving')} value={`${num(toSpeed(a.movingAvgSpeed))} ${speedUnit}`} />}
            <Fact icon={TrendingDown} label={t('tripDash.hardBrakes', 'Sudden braking')} value={num(a.hardBrakes)} tone={a.hardBrakes > 0 ? 'warn' : undefined} />
            <Fact icon={TrendingUp} label={t('tripDash.hardAccels', 'Hard acceleration')} value={num(a.hardAccels)} tone={a.hardAccels > 0 ? 'warn' : undefined} />
          </div>
        </DashCard>
      ) : (
        <p className="text-sm text-muted-foreground">{t('tripDash.noSpeed', "Your car didn't report its speed on this trip, so there is no speed dashboard.")}</p>
      )}
      {cards.length > 0 && (
        <div className="grid gap-5 lg:grid-cols-2">
          {cards.map((card, i) => (
            <div key={i} className={cards.length % 2 === 1 && i === cards.length - 1 ? 'lg:col-span-2' : ''}>{card}</div>
          ))}
        </div>
      )}
    </div>
  );
}
