import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { AdvancedFold } from '@/components/ui/advanced-fold';
import { Button } from '@/components/ui/button';
import { OptionSelect } from '@/components/ui/option-select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { lazyChart } from '@/components/LazyChart';

const LapCharts = lazyChart(() => import('@/components/sim/LapCharts').then((m) => ({ default: m.LapCharts })), 'h-96');
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
import { planarLeftSign } from '@/lib/sim/ground-frame';
import {
  distanceGrid, formatGap, formatLapTime, gapSeries, incomparableReason, lapLength, lapStats, lengthIn, lengthLabel, resampleLap, sampleAlong, speedIn,
  speedLabel, timeChanges, trackPath, type DistanceUnit,
} from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';
import { layoutGame, trackKeyOf, type TrackFile } from '@/lib/sim/track-file';
import type { LibraryTrack } from '@/lib/sim/track-library';
import { cn } from '@/lib/utils';
import { SimCarIdentity } from './SimCarIdentity';
import { assertLocalTrackAlignment, layoutInLapFrame, localTrackSurface } from '@/lib/sim/local-track';

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
              <span className={cn('font-mono tabular-nums', tone === 'loss' ? 'text-destructive' : 'text-success')}>{formatGap(item.seconds)} s</span>
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
  const [picked, setPicked] = useState('');
  const pickLabelId = useId();
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
      <p>{t('modes.compare.noLayout', 'No compatible game track geometry is available for “{{track}}” yet. The line shown is your recorded lap.', { track })}</p>
      {onPick && options.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span id={pickLabelId}>{t('modes.compare.useKeptLayout', 'Or use a layout you kept (the game may name the track differently):')}</span>
          <OptionSelect
            size="sm"
            className="w-auto max-w-full"
            aria-labelledby={pickLabelId}
            value={picked}
            onChange={(value) => { if (!value) return; setPicked(value); onPick(value); }}
            placeholder={t('modes.compare.pickLayout', 'Choose a layout')}
            options={options.map((entry) => ({ value: entry.id, label: name(entry) }))}
            data-testid="pick-layout"
          />
        </div>
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
                  <span className={cn('font-mono tabular-nums', item.seconds > 0.0005 ? 'text-destructive' : item.seconds < -0.0005 ? 'text-success' : '')}>{formatGap(item.seconds)} s</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {t('modes.compare.offLineHint', 'Where you left the ideal line, and what it cost (+) or gained (−).')}
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
  const [kept, setKept] = useState<{ key: string; layout: TrackFile | null; failed?: boolean; finder: typeof findLayout } | null>(null);
  const [layoutAttempt, setLayoutAttempt] = useState(0);

  // The layout of the track of the lap being looked at, from the ones Xpeed Companion sent.
  const wanted = { game: layoutGame(a.lap.header.game), name: a.lap.header.track.name, variant: a.lap.header.track.variant ?? null };
  const wantedKey = trackKeyOf(wanted.game, wanted.name, wanted.variant);
  useEffect(() => {
    if (!findLayout) return;
    let live = true;
    findLayout(wanted.game, wanted.name, wanted.variant).then(
      (layout) => live && setKept({ key: wantedKey, layout, finder: findLayout }),
      () => live && setKept({ key: wantedKey, layout: null, failed: true, finder: findLayout }),
    );
    return () => {
      live = false;
    };
    // `wanted` is rebuilt every render; `wantedKey` says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, findLayout, layoutAttempt]);
  const currentKept = kept?.key === wantedKey && kept.finder === findLayout ? kept : null;
  // EVO layouts are stored reflected; a lap recorded in the original frame gets the mirrored copy (the alignment check still decides).
  const keptLayout = currentKept?.layout ?? null;
  const selectedLayout = useMemo(() => (keptLayout ? layoutInLapFrame(keptLayout, a.lap.header) : null), [keptLayout, a.lap.header]);

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

  // Reject the entire incompatible geometry, not only its offset chart/ideal line.
  const layoutMatches = useMemo(() => {
    if (!selectedLayout) return true;
    try { assertLocalTrackAlignment(selectedLayout, analysis.lap.x, analysis.lap.z); return true; }
    catch { return false; }
  }, [selectedLayout, analysis]);
  const layout = layoutMatches ? selectedLayout : null;
  const leftSign = planarLeftSign(a.lap.header);

  const [inspection, setInspection] = useState<{ lap: LapFile; m: number } | null>(null);
  const cursorM = inspection?.lap === a.lap ? inspection.m : null;
  const cursorIndex = cursorM === null ? null : Math.min(analysis.grid.length - 1,
    Math.max(0, Math.round(cursorM / (analysis.grid[1] - analysis.grid[0] || 1))));
  const cursor = cursorIndex === null ? null : { x: analysis.lap.x[cursorIndex], z: analysis.lap.z[cursorIndex] };
  const referenceCursor = cursorIndex === null || !analysis.reference ? null : { x: analysis.reference.x[cursorIndex], z: analysis.reference.z[cursorIndex] };

  // The lap against the game's ideal line, when the layout has one.
  const lineStudy = useMemo(() => {
    if (!layout?.fast || leftSign === null) return null;
    const line = { x: layout.fast.x, z: layout.fast.z, closed: layout.header.closed, leftSign };
    const lap = offsetsFromLine(line, analysis.lap.x, analysis.lap.z);
    const known = lap.filter(Number.isFinite).map(Math.abs).sort((p, q) => p - q);
    if (known.length === 0) return null;
    // A lap that is, half the time, further than a wide road from the line is not on this layout (other coordinates,
    // or another layout under the same name): saying how far it was from the line would be saying nothing.
    if (known[Math.floor(known.length / 2)] > OFF_LAYOUT_M) return { mismatch: true as const };
    const reference = analysis.reference ? offsetsFromLine(line, analysis.reference.x, analysis.reference.z) : null;
    return { mismatch: false as const, lap, reference, stretches: offLineStretches(analysis.grid, lap, analysis.gap) };
  }, [analysis, layout, leftSign]);

  const [focus, setFocus] = useState<MapFocus | null>(null);
  const mapCard = useRef<HTMLDivElement>(null);
  const showOnMap = (atM: number) => {
    const step = analysis.grid.length > 1 ? analysis.grid[1] - analysis.grid[0] : 1;
    const i = Math.min(analysis.grid.length - 1, Math.max(0, Math.round(atM / step)));
    const [x, z] = [analysis.lap.x[i], analysis.lap.z[i]];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    setFocus((current) => ({ x, z, key: (current?.key ?? 0) + 1 }));
    // On a phone the map opens the first tab (it is mounted there with this focus).
    if (asPhone) setTab('summary');
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
      <th scope="row" className="py-1.5 pr-2 text-left font-normal text-muted-foreground sm:pr-3">{label}</th>
      <td className="whitespace-nowrap py-1.5 pr-2 text-right font-mono tabular-nums sm:pr-3">{mine}</td>
      {other !== null && <td className="whitespace-nowrap py-1.5 pr-2 text-right font-mono tabular-nums sm:pr-3">{other}</td>}
      {diff !== null && <td className="whitespace-nowrap py-1.5 text-right font-mono tabular-nums">{diff}</td>}
    </tr>
  );
  const kmh = (ms: number) => `${speedIn(ms, unit).toFixed(1)} ${speedLabel(unit)}`;
  const percent = (share: number) => `${(share * 100).toFixed(1)} %`;
  const signed = (value: number, digits: number) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;

  const refusalNote = refusal && (
    <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="different-tracks">
      {{
        coordinates: t('modes.referenceContext.coordinateRefusal'),
        game: t('modes.compare.refused.game', 'These laps are from different games, so they cannot be compared. Only the lap is shown.'),
        track: t('modes.compare.refused.track', 'These laps are from different tracks, so they cannot be compared. Only the lap is shown.'),
        length: t('modes.compare.refused.length', 'These laps are not on the same track layout, so they cannot be compared. Only the lap is shown.'),
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
            <span className={cn('font-mono text-lg font-semibold tabular-nums', finalGap > 0.0005 ? 'text-destructive' : finalGap < -0.0005 ? 'text-success' : '')} data-testid="final-gap">
              {formatGap(finalGap)} s
            </span>
          </p>
        )}
        <div className="overflow-x-auto">
        <table className="w-full text-xs max-[359px]:text-[11px] sm:text-sm" data-testid="lap-numbers">
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
        </div>
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

  const layoutNote = (!layoutMatches || lineStudy?.mismatch) && (
    <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="layout-mismatch">
      {t('modes.compare.layoutMismatch', 'This map does not match the recorded coordinates. Its geometry and ideal line are hidden.')}
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
      cursorM={cursorM}
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
    <Card className="bg-card border-border" data-testid="lap-map-panel">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.compare.mapTitle', 'Track')}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <div ref={mapCard}>
          <TrackMap lap={analysis.pathA} reference={analysis.pathB} layout={layout} focus={focus} highlight={zoomed?.marked ?? null} cursor={cursor} referenceCursor={referenceCursor} className="h-80 md:h-96" />
        </div>
        <div className="mt-3 space-y-1" data-testid="lap-inspector">
          <label className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('modes.compare.inspectDistance', 'Move along the lap')}</span>
            <output className="font-mono tabular-nums" data-testid="inspection-distance">{Math.round(lengthIn(cursorM ?? 0, unit))} {lengthLabel(unit)}</output>
            <input type="range" min={0} max={lapLengthM} step={analysis.grid[1] - analysis.grid[0] || 1} value={cursorM ?? 0}
              aria-label={t('modes.compare.inspectDistance', 'Move along the lap')}
              className="h-10 w-full accent-primary"
              onChange={(event) => setInspection({ lap: a.lap, m: Number(event.target.value) })} />
          </label>
          {cursorIndex !== null && (
            <div className="space-y-1 text-xs tabular-nums" data-testid="inspection-values">
              {[analysis.lap, ...(analysis.reference ? [analysis.reference] : [])].map((values, index) => (
                <p key={index} className="flex flex-wrap gap-x-4 gap-y-1">
                  <span className="font-semibold">{index === 0 ? t('modes.compare.lap', 'Lap') : t('modes.compare.reference', 'Reference')}</span>
                  {[[t('modes.compare.speed', 'Speed'), speedIn(values.speed[cursorIndex], unit), speedLabel(unit)],
                    [t('modes.compare.throttle', 'Throttle'), values.throttle[cursorIndex] * 100, '%'],
                    [t('modes.compare.brake', 'Brake'), values.brake[cursorIndex] * 100, '%']].map(([label, value, suffix]) => (
                      <span key={String(label)}>{label}: {typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)} ${suffix}` : '–'}</span>
                    ))}
                </p>
              ))}
            </div>
          )}
        </div>
        {layoutNote}
        <p className="mt-1 text-xs text-muted-foreground" data-testid="map-hint">
          {layout
            ? t('modes.compare.localTrack.mapHint', { surface: t(`modes.compare.localTrack.surface_${localTrackSurface(layout)}`) })
            : t('modes.compare.mapHint', 'Solid line: your lap as you drove it. Dashed line: the lap you compare with. Green dot: the start.')}
        </p>
        {findLayout && !currentKept && <p role="status" className="mt-2 text-xs text-muted-foreground">{t('modes.compare.layoutLoading', 'Loading track geometry…')}</p>}
        {currentKept?.failed && (
          <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t('modes.compare.layoutFailed', 'Track geometry could not be loaded.')}</span>
            <Button size="sm" variant="outline" onClick={() => { setKept(null); setLayoutAttempt((value) => value + 1); }}>{t('common.retry', 'Try again')}</Button>
          </div>
        )}
        {!selectedLayout && wanted && wantedKey && findLayout && currentKept && !currentKept.failed && (
          <NoLayout
            game={wanted.game}
            track={[wanted.name, wanted.variant].filter(Boolean).join(' · ')}
            listKept={listKeptLayouts}
            onPick={
              linkLayout
                ? (id) =>
                    void linkLayout(wanted.game, wanted.name, wanted.variant, id).then(
                      (picked) => setKept({ key: wantedKey, layout: picked, finder: findLayout }),
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

  const advancedTitle = t('modes.advanced.lapTitle', 'Advanced: sectors, corners and telemetry');
  const advancedHint = t('modes.advanced.lapHint', 'The detail behind what is above, for when you want to dig in.');

  if (!asPhone) {
    return (
      <div className="space-y-4" data-testid="lap-analysis">
        {refusalNote}
        {/*
          From the top, what anybody reads first (owner, 2026-11-21: XPD-D-SIMPLE-FIRST): the track with the lap drawn on it, and beside it
          where the time went in plain words, the stretches that lose and gain (each shows on the map) and the lap's numbers. The detail
          (sectors, corner by corner, the curves of speed, throttle and brake) is the second level, in the fold under them.
        */}
        <div className={cn('grid gap-4', mapNode && 'lg:grid-cols-12')}>
          {mapNode && <div className="min-w-0 lg:col-span-7">{mapNode}</div>}
          <div className={cn('min-w-0 space-y-4', mapNode && 'lg:col-span-5')}>
            {whereCard}
            {changesCard}
            {numbersCard}
          </div>
        </div>
        <AdvancedFold title={advancedTitle} hint={advancedHint} testId="analysis-advanced">
          {stripCard}
          {cornersCard}
          {offLine}
          {zoomBar}
          {charts}
        </AdvancedFold>
      </div>
    );
  }

  // A phone: one thing at a time, in tabs, under the lap selector that stays in view.
  // The first tab is the first level: the track with the lap, where the time went, the numbers. The other tabs are the detail.
  const tabs = [
    { id: 'summary', label: t('modes.analysis.tab.summary', 'Summary') },
    ...(compared || strip ? [{ id: 'corners', label: t('modes.analysis.tab.corners', 'Corners') }] : []),
    { id: 'charts', label: t('modes.analysis.tab.charts', 'Charts') },
  ];
  const current = tabs.some((item) => item.id === tab) ? tab : 'summary';
  return (
    <Tabs value={current} onValueChange={setTab} className="space-y-3" data-testid="lap-analysis" data-layout="tabs">
      <TabsList className={cn('sticky top-24 z-20 grid h-10 w-full shadow-sm')} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }} data-testid="analysis-tabs">
        {tabs.map((item) => (
          <TabsTrigger key={item.id} value={item.id} className="px-1 text-xs" data-testid={`tab-${item.id}`}>{item.label}</TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="summary" className="mt-0 space-y-4">
        {refusalNote}
        {zoomBar}
        {mapNode}
        {whereCard}
        {changesCard}
        {numbersCard}
      </TabsContent>
      <TabsContent value="corners" className="mt-0 space-y-4">
        {stripCard}
        {cornersCard}
        {offLine}
      </TabsContent>
      <TabsContent value="charts" className="mt-0 space-y-4">
        {zoomBar}
        {layoutNote}
        {charts}
      </TabsContent>
    </Tabs>
  );
}
