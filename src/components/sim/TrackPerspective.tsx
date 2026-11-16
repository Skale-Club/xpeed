import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useSettings } from '@/contexts/SettingsContext';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { formatLapTime, lengthIn, lengthLabel, speedIn, speedLabel } from '@/lib/sim/analysis';
import type { LapFile } from '@/lib/sim/lap-file';
import type { TrackFile } from '@/lib/sim/track-file';
import {
  drawPerspective, nearestPerspectiveSample, perspectiveAtTime, perspectiveHeading,
  preparePerspectiveLap, preparePerspectiveRoad,
} from '@/lib/sim/track-perspective';
import type { MapFocus } from './TrackMap';

export interface TrackPerspectiveProps {
  lap: LapFile;
  reference?: LapFile | null;
  layout?: TrackFile | null;
  focus?: MapFocus | null;
  highlight?: Array<[number, number]> | null;
}

/** A local planar view of recorded positions. The camera rotates; the game's world coordinates never do. */
export function TrackPerspective({ lap, reference, layout, focus, highlight }: TrackPerspectiveProps) {
  const { t } = useTranslation();
  const { distanceUnit } = useSettings();
  const id = useId().replace(/:/g, '');
  const host = useRef<HTMLDivElement>(null);
  const model = useMemo(() => preparePerspectiveLap(lap), [lap]);
  const referenceModel = useMemo(() => {
    const norm = (value: string | undefined) => (value ?? '').trim().toLowerCase();
    if (!reference || norm(reference.header.game) !== norm(lap.header.game) || norm(reference.header.track.name) !== norm(lap.header.track.name) || norm(reference.header.track.variant) !== norm(lap.header.track.variant)) return null;
    return preparePerspectiveLap(reference);
  }, [lap, reference]);
  const road = useMemo(() => preparePerspectiveRoad(layout, lap, model), [layout, lap, model]);
  const [time, setTime] = useState(model.startTime);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [tilt, setTilt] = useState(32);
  const [width, setWidth] = useState(736);
  const timeRef = useRef(time);
  timeRef.current = time;

  useEffect(() => {
    setPlaying(false); setTime(model.startTime);
  }, [model, reference, layout]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(280, element.getBoundingClientRect().width || 736));
    resize();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!focus) return;
    setPlaying(false);
    if (focus.reset) { setTime(model.startTime); setZoom(1); return; }
    const point = nearestPerspectiveSample(model, focus.x, focus.z);
    if (point) setTime(point.t);
    // Only an explicit new request moves the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.key, model]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0, origin: number | null = null;
    const from = timeRef.current;
    const tick = (now: number) => {
      if (origin === null) origin = now;
      const next = Math.min(model.endTime, from + Math.max(0, now - origin) / 1000);
      setTime(next);
      if (next >= model.endTime) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, model]);

  const sample = perspectiveAtTime(model, time);
  const heading = sample ? perspectiveHeading(model, sample) : null;
  const drawing = sample && heading ? drawPerspective(model, sample, {
    x: sample.x, z: sample.z, tx: heading[0], tz: heading[1], width, height: 400, zoom, tilt,
  }, road, referenceModel, highlight) : null;
  const hasDuration = model.endTime > model.startTime;
  const play = () => {
    if (playing) { setPlaying(false); return; }
    if (time >= model.endTime) { timeRef.current = model.startTime; setTime(model.startTime); }
    setPlaying(true);
  };
  const metric = (v: number | undefined, convert: (n: number) => number, suffix: string) =>
    v !== undefined && Number.isFinite(v) ? `${Math.round(convert(v))} ${suffix}` : '—';

  return (
    <div ref={host} className="min-w-0" data-testid="track-perspective">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2"><span className="w-5 border-t-[3px]" style={{ borderColor: CHART_PALETTE.yellow }} />{t('modes.perspective.study', 'Study lap')}</span>
        {referenceModel && <span className="inline-flex items-center gap-2"><span className="w-5 border-t-[3px] border-dashed" style={{ borderColor: CHART_PALETTE.blue }} />{t('modes.perspective.reference', 'Reference')}</span>}
      </div>
      <div className="relative h-[400px] overflow-hidden rounded-md bg-muted/10">
        <svg viewBox={`0 0 ${width} 400`} className="h-full w-full text-muted-foreground" role="img" aria-labelledby={`${id}-title ${id}-description`} data-testid="perspective-svg" data-time={time} data-tilt={tilt}>
          <title id={`${id}-title`}>{t('modes.perspective.sceneLabel', 'Track in perspective')}</title>
          <desc id={`${id}-description`}>{t('modes.perspective.description', 'Recorded paths ahead of the car. The car points upward while the track moves. Elevation is not shown.')}</desc>
          <defs>
            <linearGradient id={`${id}-fade`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="400">
              <stop offset="0" stopColor="white" /><stop offset="0.72" stopColor="white" /><stop offset="1" stopColor="white" stopOpacity="0" />
            </linearGradient>
            <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width={width} height="400"><rect width={width} height="400" fill={`url(#${id}-fade)`} /></mask>
          </defs>
          {drawing && <>
            <g mask={`url(#${id}-mask)`} data-testid="perspective-ground">
              {drawing.hasEdges && <g data-testid="perspective-road"><path d={drawing.road} fill="currentColor" fillOpacity="0.18" /><path d={drawing.edges} fill="none" stroke="currentColor" strokeOpacity="0.6" strokeWidth="1" /></g>}
              <path d={drawing.reference} fill="none" stroke={CHART_PALETTE.blue} strokeWidth="3" strokeDasharray="8 5" strokeLinejoin="round" strokeLinecap="round" data-testid="perspective-reference" />
              <path d={drawing.study} fill="none" stroke={CHART_PALETTE.yellow} strokeWidth="3.3" strokeLinejoin="round" strokeLinecap="round" data-testid="perspective-study" />
              {drawing.highlight && <path d={drawing.highlight} fill="none" stroke={CHART_PALETTE.pink} strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" data-testid="perspective-highlight" />}
            </g>
            <path d={`M${drawing.anchor[0]},${drawing.anchor[1] - 19}L${drawing.anchor[0] + 12},${drawing.anchor[1] + 15}L${drawing.anchor[0]},${drawing.anchor[1] + 8}L${drawing.anchor[0] - 12},${drawing.anchor[1] + 15}Z`} fill={CHART_PALETTE.yellow} stroke="hsl(var(--background))" strokeWidth="2.4" data-testid="perspective-car" />
          </>}
        </svg>
        <div className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-110px)] space-y-1 text-xs text-muted-foreground">
          <p>{drawing?.hasEdges ? t('modes.perspective.realEdges', 'Game track edges · planar view') : t('modes.perspective.noEdges', 'Recorded path; road edges unavailable')}</p>
          {drawing && <p>{t('modes.perspective.lookahead', '{{distance}} {{unit}} ahead', { distance: Math.round(lengthIn(drawing.ahead, distanceUnit)), unit: lengthLabel(distanceUnit) })}</p>}
        </div>
        {!drawing && <p className="absolute inset-x-4 top-1/2 text-center text-sm text-muted-foreground">{t('modes.perspective.noPosition', 'Position is unavailable at this moment.')}</p>}
        <p className="pointer-events-none absolute bottom-4 right-3 text-right text-[11px] text-muted-foreground">{t('modes.perspective.heading', 'Car direction ↑')}</p>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>{t('modes.perspective.speed', 'Speed')} <output className="ml-1 font-mono text-foreground">{metric(sample?.speed, v => speedIn(v, distanceUnit), speedLabel(distanceUnit))}</output></span>
        <span>{t('modes.perspective.throttle', 'Throttle')} <output className="ml-1 font-mono text-foreground">{metric(sample?.throttle, v => v * 100, '%')}</output></span>
        <span>{t('modes.perspective.brake', 'Brake')} <output className="ml-1 font-mono text-foreground">{metric(sample?.brake, v => v * 100, '%')}</output></span>
      </div>
      <div className="mt-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        <Button type="button" size="sm" variant="secondary" disabled={!hasDuration || !model.points.length} onClick={play}>{playing ? t('modes.perspective.pause', 'Pause') : time >= model.endTime && hasDuration ? t('modes.perspective.replay', 'Replay') : t('modes.perspective.play', 'Play')}</Button>
        <input type="range" className="min-w-0 w-full accent-primary" min={model.startTime} max={Math.max(model.startTime, model.endTime)} step="0.01" value={Math.min(model.endTime, Math.max(model.startTime, time))} disabled={!hasDuration} aria-label={t('modes.perspective.position', 'Lap playback position')} onChange={e => { setPlaying(false); setTime(Number(e.target.value)); }} />
        <output className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">{formatLapTime(time * 1000)}</output>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 min-[400px]:gap-6">
        <label className="min-w-0 text-xs text-muted-foreground"><span className="mb-1 flex justify-between gap-2"><span>{t('modes.perspective.zoom', 'Zoom')}</span><output>{zoom.toFixed(2)}×</output></span><input className="w-full accent-primary" type="range" min="0.75" max="1.6" step="0.05" value={zoom} aria-label={t('modes.perspective.zoom', 'Zoom')} onChange={e => setZoom(Number(e.target.value))} /></label>
        <label className="min-w-0 text-xs text-muted-foreground"><span className="mb-1 flex justify-between gap-2"><span>{t('modes.perspective.tilt', 'Camera below horizon')}</span><output>{tilt}°</output></span><input className="w-full accent-primary" type="range" min="20" max="55" step="1" value={tilt} aria-label={t('modes.perspective.tilt', 'Camera below horizon')} onChange={e => setTilt(Number(e.target.value))} /></label>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground" aria-live="polite">{playing ? t('modes.perspective.playing', 'Playing at recorded speed') : time >= model.endTime && hasDuration ? t('modes.perspective.finished', 'Lap completed') : t('modes.perspective.paused', 'Paused')}</p>
    </div>
  );
}
