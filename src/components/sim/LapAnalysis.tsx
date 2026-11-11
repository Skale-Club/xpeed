import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Sparkles, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LapCharts } from '@/components/sim/LapCharts';
import { TrackMap } from '@/components/sim/TrackMap';
import { useSettings } from '@/contexts/SettingsContext';
import {
  comparable, distanceGrid, formatGap, formatLapTime, gapSeries, lapLength, lapStats, lengthIn, lengthLabel, resampleLap, speedIn,
  speedLabel, timeChanges, trackPath, type DistanceUnit,
} from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';
import { LapReadError, readLapFile } from '@/lib/sim/read-lap-file';
import { makeSampleLaps } from '@/lib/sim/sample-laps';
import { cn } from '@/lib/utils';

export interface LoadedLap {
  id: string;
  name: string;
  lap: LapFile;
  sample?: boolean;
}

const MAX_LAPS = 12;

function Changes({ title, items, unit, tone }: { title: string; items: Array<{ fromM: number; toM: number; seconds: number }>; unit: DistanceUnit; tone: 'loss' | 'gain' }) {
  const { t } = useTranslation();
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{t('modes.compare.noChanges', 'No stretch of 150 m changes the gap by more than 0.01 s.')}</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {items.map((item) => (
            <li key={item.fromM} className="flex justify-between gap-3">
              <span className="text-muted-foreground">
                {t('modes.compare.stretch', '{{from}}–{{to}} {{unit}}', {
                  from: Math.round(lengthIn(item.fromM, unit)),
                  to: Math.round(lengthIn(item.toM, unit)),
                  unit: lengthLabel(unit),
                })}
              </span>
              <span className={cn('font-mono tabular-nums', tone === 'loss' ? 'text-destructive' : 'text-green-500')}>{formatGap(item.seconds)} s</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Looking at laps in the browser: open lap files written by Xpeed Sim (or the sample laps), pick one as the
 * lap and one as the reference, and read the gap between them along the track. The files are read here and go
 * nowhere else: no account, no server.
 */
export function LapAnalysis({ initialLaps }: { initialLaps?: LoadedLap[] }) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const [laps, setLaps] = useState<LoadedLap[]>(initialLaps ?? []);
  const [aId, setAId] = useState<string | null>(initialLaps?.[0]?.id ?? null);
  const [bId, setBId] = useState<string | null>(initialLaps?.[1]?.id ?? null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

  const addFiles = async (files: File[]) => {
    const room = Math.max(0, MAX_LAPS - laps.length);
    const bad: string[] = [];
    if (files.length > room) bad.push(t('modes.compare.tooMany', 'Only {{count}} laps can be open at once.', { count: MAX_LAPS }));
    const added: LoadedLap[] = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push({ id: `file-${nextId.current++}`, name: file.name, lap: await readLapFile(file) });
      } catch (error) {
        const reason = error instanceof LapReadError ? error.reason : 'unreadable';
        const text = {
          too_big: t('modes.compare.reasons.too_big', 'it is too large to be a lap'),
          not_a_lap: t('modes.compare.reasons.not_a_lap', 'it is not a lap file'),
          unreadable: t('modes.compare.reasons.unreadable', 'it could not be read'),
        }[reason];
        bad.push(t('modes.compare.readError', '{{name}}: {{reason}}', { name: file.name, reason: text }));
      }
    }
    setProblems(bad);
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
  const analysis = useMemo(() => {
    if (!a) return null;
    const same = !!b && comparable(a.lap, b.lap);
    const grid = distanceGrid(same && b ? Math.min(lapLength(a.lap), lapLength(b.lap)) : lapLength(a.lap));
    const ids = ['t', 'speed', 'throttle', 'brake'];
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
      pathA: trackPath(a.lap),
      pathB: same && b ? trackPath(b.lap) : null,
    };
  }, [a, b]);

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
            {t('modes.compare.intro', 'Open lap files written by Xpeed Sim to see them side by side.')} {t('modes.compare.private', 'The files stay in your browser; nothing is uploaded.')}
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
            accept=".gz,.xlap,application/gzip,application/x-gzip,application/octet-stream"
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

          <LapCharts grid={analysis.grid} lap={analysis.lap} reference={analysis.reference} gap={analysis.gap} unit={unit} />

          {analysis.changes && (
            <Card className="bg-card border-border" data-testid="time-changes">
              <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
                <Changes title={t('modes.compare.lostTitle', 'Where the lap loses time')} items={analysis.changes.losses} unit={unit} tone="loss" />
                <Changes title={t('modes.compare.gainedTitle', 'Where the lap gains time')} items={analysis.changes.gains} unit={unit} tone="gain" />
              </CardContent>
            </Card>
          )}

          {analysis.pathA && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-1">
                <CardTitle className="text-sm font-semibold">{t('modes.compare.mapTitle', 'Track')}</CardTitle>
              </CardHeader>
              <CardContent className="pb-3">
                <TrackMap lap={analysis.pathA} reference={analysis.pathB} />
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('modes.compare.mapHint', 'Solid: the lap. Dashed: the reference. Green dot: the start. Drawn from the game’s coordinates, so it may be turned or mirrored.')}
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
