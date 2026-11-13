import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, MapPin, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LapCharts } from '@/components/sim/LapCharts';
import { TrackMap, type MapFocus } from '@/components/sim/TrackMap';
import { offLineStretches, offsetsFromLine, type OffLineStretch } from '@/lib/sim/line-offset';
import { useSettings } from '@/contexts/SettingsContext';
import {
  comparable, distanceGrid, formatGap, formatLapTime, gapSeries, lapLength, lapStats, lengthIn, lengthLabel, resampleLap, speedIn,
  speedLabel, timeChanges, trackPath, type DistanceUnit,
} from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';
import { LapReadError, readLapFile } from '@/lib/sim/read-lap-file';
import { readTrackFile } from '@/lib/sim/read-track-file';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { layoutGame, trackKey, trackKeyOf, type TrackFile } from '@/lib/sim/track-file';
import type { LibraryTrack } from '@/lib/sim/track-library';
import { cn } from '@/lib/utils';

export interface LoadedLap {
  id: string;
  name: string;
  lap: LapFile;
  sample?: boolean;
}

const MAX_LAPS = 12;
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
      <p>{t('modes.compare.noLayout', 'No track layout is kept on this device for “{{track}}”. Open its .xtrk file here.', { track })}</p>
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
 * Looking at laps in the browser: open lap files written by Xpeed Companion (or the sample laps), pick one as the
 * lap and one as the reference, and read the gap between them along the track. The files are read here and go
 * nowhere else: no account, no server.
 */
export function LapAnalysis({
  initialLaps,
  findLayout,
  onLayoutFile,
  listKeptLayouts,
  linkLayout,
}: {
  initialLaps?: LoadedLap[];
  /** Looks for the layout of the track of a lap among the ones kept on this device (a track layout opened here wins over it). */
  findLayout?: (game: string, trackName: string, variant?: string | null) => Promise<TrackFile | null>;
  /** Called with each track layout file that is opened here, so it can be kept. */
  onLayoutFile?: (file: File, layout: TrackFile) => void;
  /** The layouts kept on this device, to choose one by hand when none has the lap's track name. */
  listKeptLayouts?: () => Promise<LibraryTrack[]>;
  /** Ties the lap's track name to a kept layout; gives that layout back. */
  linkLayout?: (game: string, trackName: string, variant: string | null, layoutId: string) => Promise<TrackFile | null>;
}) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const [laps, setLaps] = useState<LoadedLap[]>(initialLaps ?? []);
  const [aId, setAId] = useState<string | null>(initialLaps?.[0]?.id ?? null);
  const [bId, setBId] = useState<string | null>(initialLaps?.[1]?.id ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  const [opened, setOpened] = useState<TrackFile[]>([]);
  const [kept, setKept] = useState<{ key: string; layout: TrackFile | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const addFiles = async (files: File[]) => {
    const room = Math.max(0, MAX_LAPS - laps.length);
    const bad: string[] = [];
    if (files.length > room) bad.push(t('modes.compare.tooMany', 'Only {{count}} laps can be open at once.', { count: MAX_LAPS }));
    const added: LoadedLap[] = [];
    const layouts: TrackFile[] = [];
    // Track layouts are not counted against the laps that fit, so they are tried whatever the room.
    for (const file of files) {
      if (added.length >= room && !/\.xtrk(\.gz)?$/i.test(file.name)) continue;
      try {
        if (added.length >= room) throw new LapReadError('not_a_lap', 'No room for another lap.');
        added.push({ id: `file-${nextId.current++}`, name: file.name, lap: await readLapFile(file) });
      } catch (error) {
        const reason = error instanceof LapReadError ? error.reason : 'unreadable';
        if (reason === 'not_a_lap') {
          try {
            const layout = await readTrackFile(file);
            layouts.push(layout);
            onLayoutFile?.(file as File, layout);
            continue;
          } catch {
            // Not a track layout either: it is reported below.
          }
        }
        const text = {
          too_big: t('modes.compare.reasons.too_big', 'it is too large to be a lap'),
          not_a_lap: t('modes.compare.reasons.not_a_lap_or_track', 'it is neither a lap nor a track layout file'),
          unreadable: t('modes.compare.reasons.unreadable', 'it could not be read'),
        }[reason];
        bad.push(t('modes.compare.readError', '{{name}}: {{reason}}', { name: file.name, reason: text }));
      }
    }
    setProblems(bad);
    setNotice(null);
    if (layouts.length > 0) {
      setOpened((current) => [...current.filter((c) => !layouts.some((l) => trackKey(l) === trackKey(c))), ...layouts]);
      setNotice(t('modes.compare.layoutAdded', 'Track layout opened: {{tracks}}.', { tracks: layouts.map((l) => l.header.track.title ?? l.header.track.name).join(', ') }));
    }
    if (added.length === 0) return;
    setLaps((current) => [...current, ...added]);
    const first = aId ?? added[0].id;
    setAId(first);
    if (!bId) setBId(added.find((entry) => entry.id !== first)?.id ?? null);
  };

  const addSamples = () => {
    if (laps.some((entry) => entry.sample)) return;
    const [mine, best] = makeSampleLaps();
    setLaps((current) => [
      ...current,
      { id: 'sample-mine', name: t('modes.compare.sampleMine', 'Sample: my lap'), lap: mine, sample: true },
      { id: 'sample-best', name: t('modes.compare.sampleBest', 'Sample: best lap'), lap: best, sample: true },
    ]);
    setAId('sample-mine');
    setBId('sample-best');
    setProblems([]);
  };

  const chooseLap = (id: string) => {
    if (id === aId || (id === bId && !aId)) return;
    if (id === bId) setBId(aId);
    setAId(id);
  };
  const chooseReference = (id: string) => {
    if (id === bId || (id === aId && !bId)) return;
    if (id === aId) setAId(bId);
    setBId(id);
  };
  const remove = (id: string) => {
    setLaps((current) => current.filter((entry) => entry.id !== id));
    if (id === aId) {
      setAId(bId);
      setBId(null);
    } else if (id === bId) setBId(null);
  };
  const clear = () => {
    setLaps([]);
    setAId(null);
    setBId(null);
    setProblems([]);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const a = laps.find((entry) => entry.id === aId) ?? null;
  const b = laps.find((entry) => entry.id === bId) ?? null;

  // The layout of the track of the lap being looked at: one opened here, else one kept on this device.
  const wanted = a ? { game: layoutGame(a.lap.header.game), name: a.lap.header.track.name, variant: a.lap.header.track.variant ?? null } : null;
  const wantedKey = wanted ? trackKeyOf(wanted.game, wanted.name, wanted.variant) : null;
  useEffect(() => {
    if (!wanted || !wantedKey || !findLayout) return;
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
  }, [wantedKey, findLayout, opened]);
  const layout = (wantedKey && opened.find((entry) => trackKey(entry) === wantedKey)) || (kept && kept.key === wantedKey ? kept.layout : null) || null;

  const analysis = useMemo(() => {
    if (!a) return null;
    const same = !!b && comparable(a.lap, b.lap);
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
  }, [a, b]);

  // The lap against the game's ideal line, when the layout has one.
  const lineStudy = useMemo(() => {
    if (!analysis || !layout?.fast) return null;
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
    if (!analysis) return;
    const step = analysis.grid.length > 1 ? analysis.grid[1] - analysis.grid[0] : 1;
    const i = Math.min(analysis.grid.length - 1, Math.max(0, Math.round(atM / step)));
    const [x, z] = [analysis.lap.x[i], analysis.lap.z[i]];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    setFocus((current) => ({ x, z, key: (current?.key ?? 0) + 1 }));
    mapCard.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  };
  const canShow = !!analysis?.pathA && analysis.lap.x.some(Number.isFinite);

  const unit = distanceUnit as DistanceUnit;
  const describe = (entry: LoadedLap) => {
    const { track, car, lap } = entry.lap.header;
    return `${track.name} · ${car.name} · ${t('modes.compare.lapN', 'Lap {{n}}', { n: lap.number })} · ${formatLapTime(lap.timeMs)}`;
  };
  const finalGap = a && b ? (a.lap.header.lap.timeMs - b.lap.header.lap.timeMs) / 1000 : null;

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

  return (
    <div className="space-y-4" data-testid="lap-analysis">
      <Card
        className={cn('bg-card border-border border-dashed transition-colors', dragging && 'border-primary bg-primary/5')}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        data-testid="lap-dropzone"
      >
        <CardContent className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            {t('modes.compare.intro', 'Open lap files written by Xpeed Companion to see them side by side.')} {t('modes.compare.private', 'The files stay in your browser; nothing is uploaded.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => input.current?.click()}>
              <FolderOpen className="mr-2 h-4 w-4" /> {t('modes.compare.open', 'Open lap files')}
            </Button>
            <Button variant="outline" onClick={addSamples} disabled={laps.some((entry) => entry.sample)}>
              <Sparkles className="mr-2 h-4 w-4" /> {t('modes.compare.sample', 'Try with sample laps')}
            </Button>
            {laps.length > 0 && (
              <Button variant="ghost" onClick={clear}>
                <Trash2 className="mr-2 h-4 w-4" /> {t('modes.compare.clear', 'Remove all')}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">{t('modes.compare.drop', 'or drop .xlap.gz files here')}</span>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept=".gz,.xlap,.xtrk,application/gzip,application/x-gzip,application/octet-stream"
            className="sr-only"
            tabIndex={-1}
            aria-label={t('modes.compare.open', 'Open lap files')}
            data-testid="lap-input"
            onChange={(event) => {
              void addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
        </CardContent>
      </Card>

      {notice && (
        <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="layout-notice">
          {notice}
        </p>
      )}

      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {problems.map((problem) => <p key={problem}>{problem}</p>)}
        </div>
      )}

      {laps.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('modes.compare.empty', 'Open one or two lap files to see them here.')}</p>
      ) : (
        <Card className="bg-card border-border">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-semibold">{t('modes.compare.loaded', 'Laps')}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3">
            <ul className="divide-y divide-border" data-testid="lap-list">
              {laps.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                    <p className="truncate text-sm font-medium">{describe(entry)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.name} · {entry.lap.header.lap.valid ? t('modes.compare.valid', 'valid') : t('modes.compare.notValid', 'not valid')}
                      {entry.sample ? ` · ${t('modes.compare.sampleTag', 'sample')}` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant={entry.id === aId ? 'default' : 'outline'} aria-pressed={entry.id === aId} onClick={() => chooseLap(entry.id)}>
                    {t('modes.compare.lap', 'Lap')}
                  </Button>
                  <Button size="sm" variant={entry.id === bId ? 'default' : 'outline'} aria-pressed={entry.id === bId} onClick={() => chooseReference(entry.id)}>
                    {t('modes.compare.reference', 'Reference')}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`${t('modes.compare.remove', 'Remove')} ${entry.name}`} onClick={() => remove(entry.id)}>
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {a && analysis && (
        <>
          {b && !analysis.same && (
            <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="different-tracks">
              {t('modes.compare.differentTracks', 'These laps are from different tracks, or have different lengths, so they cannot be compared.')}
            </p>
          )}
          {!b && laps.length > 1 && <p className="text-sm text-muted-foreground">{t('modes.compare.pickReference', 'Pick a second lap as the reference to compare.')}</p>}

          <Card className="bg-card border-border">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-semibold">{t('modes.compare.summary', 'Numbers')}</CardTitle>
            </CardHeader>
            <CardContent className="pb-3">
              {finalGap !== null && analysis.same && (
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

          {lineStudy?.mismatch && (
            <p role="status" className="rounded-lg border border-border bg-muted/40 p-3 text-sm" data-testid="layout-mismatch">
              {t('modes.compare.layoutMismatch', 'This lap does not sit on the track layout: most of it is more than 25 m from the ideal line. The layout may be of another version of the track, so the distance from the ideal line is not shown.')}
            </p>
          )}

          <LapCharts
            grid={analysis.grid}
            lap={analysis.lap}
            reference={analysis.reference}
            gap={analysis.gap}
            offset={lineStudy && !lineStudy.mismatch ? { lap: lineStudy.lap, reference: lineStudy.reference } : null}
            unit={unit}
          />

          {analysis.changes && (
            <Card className="bg-card border-border" data-testid="time-changes">
              <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
                <Changes title={t('modes.compare.lostTitle', 'Where the lap loses time')} items={analysis.changes.losses} unit={unit} tone="loss" onShow={canShow ? showOnMap : undefined} />
                <Changes title={t('modes.compare.gainedTitle', 'Where the lap gains time')} items={analysis.changes.gains} unit={unit} tone="gain" onShow={canShow ? showOnMap : undefined} />
              </CardContent>
            </Card>
          )}

          {lineStudy && !lineStudy.mismatch && <OffLine items={lineStudy.stretches} unit={unit} onShow={showOnMap} />}

          {analysis.pathA && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-semibold">{t('modes.compare.mapTitle', 'Track')}</CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <div ref={mapCard}>
                  <TrackMap lap={analysis.pathA} reference={analysis.pathB} layout={layout} focus={focus} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground" data-testid="map-hint">
                  {layout
                    ? t('modes.compare.mapHintLayout', 'Grey: the road, between its edges. Red: the game’s ideal line. Orange: the pit lane. Yellow: the lap; dashed blue: the reference. Green dot: the start.')
                    : t('modes.compare.mapHint', 'Solid: the lap. Dashed: the reference. Green dot: the start. Open the track’s layout file (.xtrk) to draw the road, its edges and the ideal line under it.')}
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
          )}
        </>
      )}
    </div>
  );
}
