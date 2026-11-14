import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LapCharts } from '@/components/sim/LapCharts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { useLapStudy } from '@/lib/sim/lap-study-client';
import { cornerRange, type Range } from '@/lib/sim/corner-table';
import type { CornerDelta } from '@/lib/sim/corner-compare';
import { sectorStrip } from '@/lib/sim/sector-strip';
import { CornerTable } from './CornerTable';
import { SectorStripCard } from './SectorStripCard';
import { WhereTimeWent } from './WhereTimeWent';
import { TrackMap, type MapFocus } from '@/components/sim/TrackMap';
import { offLineStretches, offsetsFromLine, type OffLineStretch } from '@/lib/sim/line-offset';
import { useSettings } from '@/contexts/SettingsContext';
import {
  distanceGrid, formatGap, formatLapTime, gapSeries, incomparableReason, lapLength, lapStats, lengthIn, lengthLabel, resampleLap, sampleAlong, speedIn,
  speedLabel, timeChanges, trackPath, type DistanceUnit,
} from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';
import { layoutGame, trackKeyOf, type TrackFile } from '@/lib/sim/track-file';
import type { LibraryTrack } from '@/lib/sim/track-library';
import { cn } from '@/lib/utils';
import { SimCarIdentity } from './SimCarIdentity';

/** A lap whose samples are loaded, by the id the server gave it. */
export interface LoadedLap {
  id: string;
  lap: LapFile;
}

/** Half the lap further than this from the ideal line: the lap is not on that layout. */
const OFF_LAYOUT_M = 25;

function ShowOnMap({ onClick, label }: { onClick: () => void; label: string }) {
  const { t } = useTranslation();
  return (
    <Button type="button" size="icon" variant="ghost" className="h-6 w-6 shrink-0" aria-label={`${t('modes.compare.showOnMap', 'Show on the map')}: ${label}`} onClick={onClick}>
      <MapPin className="h-3.5 w-3.5" />
    </Button>
  );
}

function Changes({ title, items, unit, tone, onShow }: {
  title: string;
  items: Array<{ fromM: number; toM: number; seconds: number }>;
  unit: DistanceUnit;
  tone: 'loss' | 'gain';
  onShow?: (atM: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{t('modes.compare.noChanges', 'No stretch of 150 m changes the gap by more than 0.01 s.')}</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {items.map((item) => (
            <li key={item.fromM} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1 text-muted-foreground">
                {onShow && <ShowOnMap onClick={() => onShow((item.fromM + item.toM) / 2)} label={stretchLabel(t, item, unit)} />}
                {stretchLabel(t, item, unit)}
              </span>
              <span className={cn('font-mono tabular-nums', tone === 'loss' ? 'text-destructive' : 'text-green-500')}>{formatGap(item.seconds)} s</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslation>['t'];
const stretchLabel = (t: Translate, item: { fromM: number; toM: number }, unit: DistanceUnit) =>
  t('modes.compare.stretch', '{{from}}–{{to}} {{unit}}', {
    from: Math.round(lengthIn(item.fromM, unit)),
    to: Math.round(lengthIn(item.toM, unit)),
    unit: lengthLabel(unit),
  });

/** No layout kept for the track of the lap: says so, and offers the kept layouts of the same game to tie it to. */
function NoLayout({ game, track, listKept, onPick }: { game: string; track: string; listKept?: () => Promise<LibraryTrack[]>; onPick?: (id: string) => void }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<LibraryTrack[]>([]);
  useEffect(() => {
    if (!listKept) return;
    let live = true;
    listKept().then(
      (all) => live && setOptions(all.filter((entry) => entry.summary.game === game).sort((p, q) => p.summary.trackName.localeCompare(q.summary.trackName))),
      () => live && setOptions([]),
    );
    return () => {
      live = false;
    };
  }, [listKept, game]);
  const name = (entry: LibraryTrack) => [entry.summary.title ?? entry.summary.trackName, entry.summary.variant].filter(Boolean).join(' · ');
  return (
    <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="no-layout">
      <p>{t('modes.compare.noLayout', 'Xpeed Companion has not sent the track layout of “{{track}}” yet. It is sent by itself the next time you drive the track.', { track })}</p>
      {onPick && options.length > 0 && (
        <label className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {t('modes.compare.useKeptLayout', 'Or use a layout you kept (the game may name the track differently):')}
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            defaultValue=""
            onChange={(event) => event.target.value && onPick(event.target.value)}
            data-testid="pick-layout"
          >
            <option value="" disabled>
              {t('modes.compare.pickLayout', 'Choose a layout')}
            </option>
            {options.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {name(entry)}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Where the lap kept away from the game's ideal line, with what it cost against the reference. */
function OffLine({ items, unit, onShow }: { items: OffLineStretch[]; unit: DistanceUnit; onShow: (atM: number) => void }) {
  const { t } = useTranslation();
  return (
    <Card className="bg-card border-border" data-testid="off-line">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.compare.offLineTitle', 'Where the lap left the ideal line')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('modes.compare.offLineNone', 'The lap stayed within 1.5 m of the ideal line all the way round.')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {items.map((item) => (
              <li key={item.fromM} className="flex flex-wrap items-center justify-between gap-x-3">
                <span className="flex items-center gap-1">
                  <ShowOnMap onClick={() => onShow((item.fromM + item.toM) / 2)} label={stretchLabel(t, item, unit)} />
                  <span className="text-muted-foreground">{stretchLabel(t, item, unit)}</span>
                  <span>
                    {t(item.side === 'left' ? 'modes.compare.offLineLeft' : 'modes.compare.offLineRight', item.side === 'left' ? 'up to {{n}} {{unit}} to the left' : 'up to {{n}} {{unit}} to the right', {
                      n: lengthIn(Math.abs(item.maxM), unit).toFixed(1),
                      unit: lengthLabel(unit),
                    })}
                  </span>
                </span>
                {item.seconds !== null && (
                  <span className={cn('font-mono tabular-nums', item.seconds > 0.0005 ? 'text-destructive' : item.seconds < -0.0005 ? 'text-green-500' : '')}>{formatGap(item.seconds)} s</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {t('modes.compare.offLineHint', 'Stretches of 30 m or more at least 1.5 m from the ideal line. With a reference, the time is what the lap lost (+) or gained (−) over the stretch.')}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * One lap looked at closely, and optionally against a reference: the numbers, the gap along the track, speed and pedals, where
 * time is lost and gained, and the lap on the map. The laps are already loaded (the Compare screen downloads them from the
 * account); two laps that cannot be compared are refused with the reason, and the lap alone is still shown.
 */
export function LapAnalysis({
  lap: a,
  reference: b,
  findLayout,
  listKeptLayouts,
  linkLayout,
  phone,
  showFinalGap = true,
}: {
  /** Show the phone layout (tabs) whatever the screen; left out, it follows the width of the screen. */
  phone?: boolean;
  /** Write the gap at the finish at the top of the numbers. The Compare screen shows it big in its own header and turns this off while that header is on screen. */
  showFinalGap?: boolean;
  lap: LoadedLap;
  reference?: LoadedLap | null;
  /** Looks for the layout of the track of a lap among the ones Xpeed Companion sent (kept on this device). */
  findLayout?: (game: string, trackName: string, variant?: string | null) => Promise<TrackFile | null>;
  /** The layouts kept on this device, to choose one by hand when none has the lap's track name. */
  listKeptLayouts?: () => Promise<LibraryTrack[]>;
  /** Ties the lap's track name to a kept layout; gives that layout back. */
  linkLayout?: (game: string, trackName: string, variant: string | null, layoutId: string) => Promise<TrackFile | null>;
}) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const [kept, setKept] = useState<{ key: string; layout: TrackFile | null } | null>(null);

  // The layout of the track of the lap being looked at, from the ones Xpeed Companion sent.
  const wanted = { game: layoutGame(a.lap.header.game), name: a.lap.header.track.name, variant: a.lap.header.track.variant ?? null };
  const wantedKey = trackKeyOf(wanted.game, wanted.name, wanted.variant);
  useEffect(() => {
    if (!findLayout) return;
    let live = true;
    findLayout(wanted.game, wanted.name, wanted.variant).then(
      (layout) => live && setKept({ key: wantedKey, layout }),
      () => live && setKept({ key: wantedKey, layout: null }),
    );
    return () => {
      live = false;
    };
    // `wanted` is rebuilt every render; `wantedKey` says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, findLayout]);
  const layout = (kept && kept.key === wantedKey ? kept.layout : null) || null;

  const refusal = b ? incomparableReason(a.lap, b.lap) : null;
  const analysis = useMemo(() => {
    const same = !!b && refusal === null;
    const grid = distanceGrid(same && b ? Math.min(lapLength(a.lap), lapLength(b.lap)) : lapLength(a.lap));
    const ids = ['t', 'speed', 'throttle', 'brake', 'x', 'z'];
    const lap = resampleLap(a.lap, ids, grid);
    const reference = same && b ? resampleLap(b.lap, ids, grid) : null;
    const gap = reference ? gapSeries(lap.t, reference.t) : null;
    return {
      same,
      grid,
      lap,
      reference,
      gap,
      changes: gap ? timeChanges(grid, gap) : null,
      statsA: lapStats(a.lap),
      statsB: b ? lapStats(b.lap) : null,
      // Enough points that the line still follows a corner when the map is zoomed in on it.
      pathA: trackPath(a.lap, 6000),
      pathB: same && b ? trackPath(b.lap, 6000) : null,
    };
  }, [a, b, refusal]);

  // The lap against the game's ideal line, when the layout has one.
  const lineStudy = useMemo(() => {
    if (!layout?.fast) return null;
    const line = { x: layout.fast.x, z: layout.fast.z, closed: layout.header.closed };
    const lap = offsetsFromLine(line, analysis.lap.x, analysis.lap.z);
    const known = lap.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
    if (known.length === 0) return null;
    // A lap that is, half the time, further than a wide road from the line is not on this layout (other coordinates,
    // or another layout under the same name): saying how far it was from the line would be saying nothing.
    if (known[Math.floor(known.length / 2)] > OFF_LAYOUT_M) return { mismatch: true as const };
    const reference = analysis.reference ? offsetsFromLine(line, analysis.reference.x, analysis.reference.z) : null;
    return { mismatch: false as const, lap, reference, stretches: offLineStretches(analysis.grid, lap, analysis.gap) };
  }, [analysis, layout]);

  const [focus, setFocus] = useState<MapFocus | null>(null);
  const mapCard = useRef<HTMLDivElement>(null);
  const showOnMap = (atM: number) => {
    const step = analysis.grid.length > 1 ? analysis.grid[1] - analysis.grid[0] : 1;
    const i = Math.min(analysis.grid.length - 1, Math.max(0, Math.round(atM / step)));
    const [x, z] = [analysis.lap.x[i], analysis.lap.z[i]];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    setFocus((current) => ({ x, z, key: (current?.key ?? 0) + 1 }));
    // On a phone the map is on its own tab (it is mounted there with this focus).
    if (asPhone) setTab('map');
    mapCard.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };
  const canShow = !!analysis.pathA && analysis.lap.x.some(Number.isFinite);

  const unit = distanceUnit as DistanceUnit;
  const finalGap = b ? (a.lap.header.lap.timeMs - b.lap.header.lap.timeMs) / 1000 : null;

  // The corner analysis runs off the render path (a Web Worker); the page shows the numbers at once and the corners when they arrive.
  const mobile = useIsMobile();
  const asPhone = phone ?? mobile;
  const compared = analysis.same && !!b;
  const study = useLapStudy(compared ? a.lap : null, compared && b ? b.lap : null);
  const strip = useMemo(() => (compared && b ? sectorStrip(a.lap, b.lap) : null), [compared, a, b]);
  const lapLengthM = analysis.grid[analysis.grid.length - 1] ?? 0;
  const [tab, setTab] = useState('summary');

  // The stretch the charts and the map are zoomed to (a corner picked in the table or in "where the time went").
  const [zoom, setZoom] = useState<{ corner: number; range: Range; marked: Range } | null>(null);
  const zoomed = useMemo(() => {
    if (!zoom) return null;
    const { fromM, toM } = zoom.range;
    const count = Math.min(700, Math.max(2, Math.ceil(toM - fromM) + 1));
    const grid = Array.from({ length: count }, (_, i) => fromM + ((toM - fromM) * i) / (count - 1));
    const ids = ['t', 'speed', 'throttle', 'brake', 'x', 'z'];
    const lap = resampleLap(a.lap, ids, grid);
    const reference = analysis.same && b ? resampleLap(b.lap, ids, grid) : null;
    // The gap and the distance from the ideal line are smooth: they are read off the whole-lap series at the new distances.
    const along = (values: ArrayLike<number> | null) => (values ? sampleAlong(Float64Array.from(analysis.grid), values, grid) : null);
    const marked: Array<[number, number]> = [];
    grid.forEach((d, i) => {
      if (d >= zoom.marked.fromM && d <= zoom.marked.toM && Number.isFinite(lap.x[i]) && Number.isFinite(lap.z[i])) marked.push([lap.x[i], lap.z[i]]);
    });
    return {
      grid,
      lap,
      reference,
      gap: along(analysis.gap),
      offset: lineStudy && !lineStudy.mismatch ? { lap: along(lineStudy.lap) as number[], reference: along(lineStudy.reference) } : null,
      marked,
    };
  }, [zoom, a, b, analysis, lineStudy]);

  // The map follows the zoom: it shows the corner, with a little road around it.
  useEffect(() => {
    if (!zoomed) return;
    const [xs, zs] = [zoomed.lap.x, zoomed.lap.z].map((values) => values.filter(Number.isFinite));
    if (xs.length === 0 || zs.length === 0) return;
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    setFocus((current) => ({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, span: Math.max(x1 - x0, z1 - z0) * 1.4 + 30, key: (current?.key ?? 0) + 1 }));
  }, [zoomed]);

  const zoomTo = (corner: CornerDelta, range: Range) => {
    setZoom({ corner: corner.index, range, marked: { fromM: corner.startDist, toM: corner.endDist } });
    // On a phone the charts are on another tab: go and look at them.
    if (asPhone) setTab('charts');
  };
  const zoomToIndex = (index: number) => {
    const corner = study.status === 'ready' ? study.value.comparison.corners.find((c) => c.index === index) : undefined;
    if (corner) zoomTo(corner, cornerRange(corner, lapLengthM));
  };
  const showWhole = () => {
    setZoom(null);
    setFocus((current) => ({ x: 0, z: 0, key: (current?.key ?? 0) + 1, reset: true }));
  };

  const metric = (label: string, mine: string, other: string | null, diff: string | null) => (
    <tr key={label} className="border-t border-border">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">{label}</th>
      <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{mine}</td>
      {other !== null && <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">{other}</td>}
      {diff !== null && <td className="whitespace-nowrap py-1.5 text-right font-mono tabular-nums">{diff}</td>}
    </tr>
  );
  const kmh = (ms: number) => `${speedIn(ms, unit).toFixed(1)} ${speedLabel(unit)}`;
  const percent = (share: number) => `${(share * 100).toFixed(1)} %`;
  const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

  const refusalNote = refusal && (
    <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="different-tracks">
      {{
        game: t('modes.compare.refused.game', 'These laps are from different games, so they cannot be compared. Only the lap is shown.'),
        track: t('modes.compare.refused.track', 'These laps are from different tracks, so they cannot be compared. Only the lap is shown.'),
        length: t('modes.compare.refused.length', 'These laps have different lengths (more than 3 % apart), so they are not the same layout and cannot be compared. Only the lap is shown.'),
      }[refusal]}
    </p>
  );

  const numbersCard = (
    <Card className="bg-card border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.compare.summary', 'Numbers')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {showFinalGap && finalGap !== null && analysis.same && (
          <p className="mb-2 text-sm">
            {t('modes.compare.finalGap', 'Gap at the finish')}:{' '}
            <span className={cn('font-mono text-lg font-semibold tabular-nums', finalGap > 0.0005 ? 'text-destructive' : finalGap < -0.0005 ? 'text-green-500' : '')} data-testid="final-gap">
              {formatGap(finalGap)} s
            </span>
          </p>
        )}
        <table className="w-full text-xs sm:text-sm" data-testid="lap-numbers">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th />
              <th scope="col" className="pr-3 text-right font-normal">{t('modes.compare.lap', 'Lap')}</th>
              {b && <th scope="col" className="pr-3 text-right font-normal">{t('modes.compare.reference', 'Reference')}</th>}
              {b && <th scope="col" className="text-right font-normal">{t('modes.compare.difference', 'Difference')}</th>}
            </tr>
          </thead>
          <tbody>
            {metric(
              t('modes.compare.time', 'Lap time'),
              formatLapTime(a.lap.header.lap.timeMs),
              b ? formatLapTime(b.lap.header.lap.timeMs) : null,
              b ? `${formatGap(finalGap ?? 0)} s` : null,
            )}
            {metric(
              t('modes.compare.topSpeed', 'Top speed'),
              kmh(analysis.statsA.topSpeedMs),
              analysis.statsB ? kmh(analysis.statsB.topSpeedMs) : null,
              analysis.statsB ? `${signed(speedIn(analysis.statsA.topSpeedMs - analysis.statsB.topSpeedMs, unit), 1)} ${speedLabel(unit)}` : null,
            )}
            {metric(
              t('modes.compare.avgSpeed', 'Average speed'),
              kmh(analysis.statsA.averageSpeedMs),
              analysis.statsB ? kmh(analysis.statsB.averageSpeedMs) : null,
              analysis.statsB ? `${signed(speedIn(analysis.statsA.averageSpeedMs - analysis.statsB.averageSpeedMs, unit), 1)} ${speedLabel(unit)}` : null,
            )}
            {metric(
              t('modes.compare.fullThrottle', 'Full throttle'),
              percent(analysis.statsA.fullThrottleShare),
              analysis.statsB ? percent(analysis.statsB.fullThrottleShare) : null,
              analysis.statsB ? `${signed((analysis.statsA.fullThrottleShare - analysis.statsB.fullThrottleShare) * 100, 1)} %` : null,
            )}
            {metric(
              t('modes.compare.braking', 'Braking'),
              percent(analysis.statsA.brakingShare),
              analysis.statsB ? percent(analysis.statsB.brakingShare) : null,
              analysis.statsB ? `${signed((analysis.statsA.brakingShare - analysis.statsB.brakingShare) * 100, 1)} %` : null,
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );

  const whereCard = compared ? <WhereTimeWent study={study} unit={unit} onShowCorner={canShow ? zoomToIndex : undefined} /> : null;
  const stripCard = strip ? <SectorStripCard strip={strip} /> : null;
  const cornersCard = compared ? (
    <CornerTable study={study} lapLengthM={lapLengthM} unit={unit} selected={zoom?.corner ?? null} onSelect={zoomTo} onReset={showWhole} />
  ) : null;

  const zoomBar = zoom && (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 p-2 text-sm" data-testid="zoom-bar">
      <span>
        {t('modes.analysis.zoomedTo', 'Zoomed to corner {{corner}} ({{from}}–{{to}} {{unit}})', {
          corner: zoom.corner,
          from: Math.round(lengthIn(zoom.range.fromM, unit)),
          to: Math.round(lengthIn(zoom.range.toM, unit)),
          unit: lengthLabel(unit),
        })}
      </span>
      <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={showWhole} data-testid="zoom-bar-reset">
        {t('modes.analysis.showWhole', 'Show whole lap')}
      </Button>
    </div>
  );

  const layoutNote = lineStudy?.mismatch && (
    <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="layout-mismatch">
      {t('modes.compare.layoutMismatch', 'This lap does not sit on the track layout: most of it is more than 25 m from the ideal line. The layout may be of another version of the track, so the distance from the ideal line is not shown.')}
    </p>
  );

  const charts = (
    <LapCharts
      grid={zoomed?.grid ?? analysis.grid}
      lap={zoomed?.lap ?? analysis.lap}
      reference={zoomed ? zoomed.reference : analysis.reference}
      gap={zoomed ? zoomed.gap : analysis.gap}
      offset={zoomed ? zoomed.offset : lineStudy && !lineStudy.mismatch ? { lap: lineStudy.lap, reference: lineStudy.reference } : null}
      unit={unit}
      range={zoom?.range ?? null}
    />
  );

  const changesCard = analysis.changes && (
    <Card className="bg-card border-border" data-testid="time-changes">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
        <Changes title={t('modes.compare.lostTitle', 'Where the lap loses time')} items={analysis.changes.losses} unit={unit} tone="loss" onShow={canShow ? showOnMap : undefined} />
        <Changes title={t('modes.compare.gainedTitle', 'Where the lap gains time')} items={analysis.changes.gains} unit={unit} tone="gain" onShow={canShow ? showOnMap : undefined} />
      </CardContent>
    </Card>
  );

  const offLine = lineStudy && !lineStudy.mismatch ? <OffLine items={lineStudy.stretches} unit={unit} onShow={showOnMap} /> : null;

  const mapNode = analysis.pathA && (
    <Card className="bg-card border-border">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.compare.mapTitle', 'Track')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div ref={mapCard}>
          <TrackMap lap={analysis.pathA} reference={analysis.pathB} layout={layout} focus={focus} highlight={zoomed?.marked ?? null} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="map-hint">
          {layout
            ? t('modes.compare.mapHintLayout', 'Grey: the road, between its edges. Red: the game’s ideal line. Orange: the pit lane. Yellow: the lap; dashed blue: the reference. Green dot: the start.')
            : t('modes.compare.mapHint', 'Solid: the lap. Dashed: the reference. Green dot: the start. Once Xpeed Companion has sent the track’s layout, the road, its edges and the ideal line are drawn under it.')}
        </p>
        {!layout && wanted && wantedKey && findLayout && kept?.key === wantedKey && (
          <NoLayout
            game={wanted.game}
            track={[wanted.name, wanted.variant].filter(Boolean).join(' · ')}
            listKept={listKeptLayouts}
            onPick={
              linkLayout
                ? (id) =>
                    void linkLayout(wanted.game, wanted.name, wanted.variant, id).then(
                      (picked) => setKept({ key: wantedKey, layout: picked }),
                      () => undefined,
                    )
                : undefined
            }
          />
        )}
        {layout && (
          <p className="text-xs text-muted-foreground">{t('modes.compare.mapZoomHint', 'Zoom in (or double-click the map) to see the lap against the edges and the ideal line; drag to move.')}</p>
        )}
      </CardContent>
    </Card>
  );

  if (!asPhone) {
    return (
      <div className="space-y-4" data-testid="lap-analysis">
        {refusalNote}
        {/* What the comparison says: the numbers, and where the time went; then the sectors and the corners, then the curves, then the track and the stretches. */}
        <div className={cn('grid gap-4', whereCard && 'lg:grid-cols-12')}>
          <div className={cn('min-w-0', whereCard && 'lg:col-span-6')}>{numbersCard}</div>
          {whereCard && <div className="min-w-0 lg:col-span-6">{whereCard}</div>}
        </div>
        {stripCard}
        {cornersCard}
        {zoomBar}
        {layoutNote}
        {charts}
        <div className={cn('grid gap-4', mapNode && (changesCard || offLine) && 'lg:grid-cols-12')}>
          {mapNode && <div className={cn('min-w-0', (changesCard || offLine) && 'lg:col-span-7')}>{mapNode}</div>}
          {(changesCard || offLine) && (
            <div className={cn('min-w-0 space-y-4', mapNode && 'lg:col-span-5')}>
              {changesCard}
              {offLine}
            </div>
          )}
        </div>
      </div>
    );
  }

  // A phone: one thing at a time, in tabs, under the lap selector that stays in view.
  const tabs = [
    { id: 'summary', label: t('modes.analysis.tab.summary', 'Summary') },
    ...(compared ? [{ id: 'corners', label: t('modes.analysis.tab.corners', 'Corners') }] : []),
    { id: 'charts', label: t('modes.analysis.tab.charts', 'Charts') },
    ...(analysis.pathA ? [{ id: 'map', label: t('modes.analysis.tab.map', 'Map') }] : []),
  ];
  const current = tabs.some((item) => item.id === tab) ? tab : 'summary';
  return (
    <Tabs value={current} onValueChange={setTab} className="space-y-3" data-testid="lap-analysis" data-layout="tabs">
      <TabsList className={cn('sticky top-28 z-20 grid h-10 w-full shadow-sm')} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} data-testid="analysis-tabs">
        {tabs.map((item) => (
          <TabsTrigger key={item.id} value={item.id} className="px-1 text-xs" data-testid={`tab-${item.id}`}>{item.label}</TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="summary" className="mt-0 space-y-4">
        {refusalNote}
        {numbersCard}
        {whereCard}
        {stripCard}
      </TabsContent>
      <TabsContent value="corners" className="mt-0 space-y-4">
        {cornersCard}
        {changesCard}
        {offLine}
      </TabsContent>
      <TabsContent value="charts" className="mt-0 space-y-4">
        {zoomBar}
        {layoutNote}
        {charts}
      </TabsContent>
      <TabsContent value="map" className="mt-0 space-y-4">
        {zoomBar}
        {mapNode}
      </TabsContent>
    </Tabs>
  );
}
