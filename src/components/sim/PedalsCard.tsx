import { useMemo, useRef, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CHART_PALETTE } from '@/lib/chart-palette';
import { PEDAL_COLOUR as COLOUR, pedalRuns, type PedalSeries, type PedalState } from '@/lib/sim/pedals';
import { cn } from '@/lib/utils';

/** One pedal as a bar: how far it is pressed, 0 to 100 %. */
function PedalBar({ label, value, colour, testId }: { label: string; value: number; colour: string; testId: string }) {
  const percent = Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 100) : null;
  return (
    <div className="flex items-center gap-2" data-testid={testId}>
      <span className="w-16 shrink-0 truncate text-muted-foreground">{label}</span>
      <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? 0}>
        <span className="block h-full rounded-full transition-[width] duration-75" style={{ width: `${percent ?? 0}%`, backgroundColor: colour }} />
      </span>
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">{percent === null ? '–' : `${percent} %`}</span>
    </div>
  );
}

/**
 * Beside the big map: what the driver's feet did around the lap. A small map of the same lap drawn in the colour of the pedal in use
 * (green on the throttle, red on the brake, grey on neither), and, for the point picked on either map or with the slider, how far the
 * throttle and the brake were pressed and the speed, for the lap and for the lap it is compared with. Pointing at the small map picks
 * a point too.
 */
export function PedalsCard({ lap, reference, cursorIndex, speedText, onPick, touch = false }: {
  lap: PedalSeries;
  reference?: PedalSeries | null;
  cursorIndex: number | null;
  /** A speed in meters per second as the person reads it ("126 km/h"). */
  speedText: (ms: number) => string;
  onPick?: (index: number) => void;
  /** A phone: the hint says "tap", not "point". */
  touch?: boolean;
}) {
  const { t } = useTranslation();
  const { runs, at } = useMemo(() => pedalRuns(lap), [lap]);
  const frame = useRef<number | null>(null);
  const cursor = cursorIndex === null ? null : at(cursorIndex);

  const point = (event: PointerEvent<SVGSVGElement>) => {
    if (!onPick || (event.pointerType === 'mouse' && event.type === 'pointermove' && event.buttons !== 0)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const side = Math.min(rect.width, rect.height) || 1;
    const x = ((event.clientX - rect.left - (rect.width - side) / 2) / side) * 100;
    const y = ((event.clientY - rect.top - (rect.height - side) / 2) / side) * 100;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      let best = -1;
      let bestDistance = 12 * 12; // No point of the lap within 12 % of the map: nothing was meant.
      for (let i = 0; i < lap.x.length; i++) {
        const p = at(i);
        if (!p) continue;
        const distance = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
      if (best >= 0) onPick(best);
    });
  };

  const rows: Array<{ key: string; label: string; series: PedalSeries }> = [
    { key: 'lap', label: t('modes.compare.lap', 'Lap'), series: lap },
    ...(reference ? [{ key: 'reference', label: t('modes.pedals.compared', 'Compared lap'), series: reference }] : []),
  ];
  const legend: Array<[PedalState, string]> = [
    ['throttle', t('modes.pedals.onThrottle', 'On the throttle')],
    ['brake', t('modes.pedals.onBrake', 'Braking')],
    ['coast', t('modes.pedals.coasting', 'No pedal')],
  ];

  return (
    <Card className="border-border bg-card" data-testid="pedals">
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-semibold">{t('modes.pedals.title', 'Throttle and brake')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        <div className="flex items-center gap-3">
          <svg
            viewBox="0 0 100 100"
            className={cn('h-32 w-32 shrink-0 touch-none rounded-md bg-muted/30', onPick && 'cursor-crosshair')}
            role="img"
            aria-label={t('modes.pedals.mapLabel', 'The lap drawn in the colour of the pedal in use')}
            data-testid="pedal-map"
            onPointerMove={point}
            onPointerDown={point}
          >
            {runs.map((run, index) => (
              <polyline key={index} points={run.points} fill="none" stroke={COLOUR[run.state]} strokeOpacity={run.state === 'coast' ? 0.55 : 1} strokeWidth={run.state === 'coast' ? 2 : 3} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" data-state={run.state} />
            ))}
            {cursor && <circle cx={cursor.x} cy={cursor.y} r={4} fill={CHART_PALETTE.yellow} stroke="hsl(var(--background))" strokeWidth={1.5} vectorEffect="non-scaling-stroke" data-testid="pedal-cursor" />}
          </svg>
          <ul className="min-w-0 space-y-1.5 text-xs" data-testid="pedal-legend">
            {legend.map(([state, label]) => (
              <li key={state} className="flex items-center gap-2">
                <span className="h-1 w-5 shrink-0 rounded-full" style={{ backgroundColor: COLOUR[state], opacity: state === 'coast' ? 0.55 : 1 }} aria-hidden="true" />
                <span className="truncate">{label}</span>
              </li>
            ))}
          </ul>
        </div>

        {cursorIndex === null ? (
          <p className="text-xs text-muted-foreground" data-testid="pedal-hint">
            {touch
              ? t('modes.pedals.hintTouch', 'Tap the lap on the map (or move the slider under it) to see how far each pedal was pressed there.')
              : t('modes.pedals.hint', 'Point at the lap on the map (or move the slider under it) to see how far each pedal was pressed there.')}
          </p>
        ) : (
          <div className="space-y-3 text-xs" data-testid="inspection-values">
            {rows.map(({ key, label, series }) => (
              <div key={key} className="space-y-1.5" data-testid={`pedal-${key}`}>
                <p className="flex items-baseline justify-between gap-2">
                  <span className="font-semibold">{label}</span>
                  <span className="text-muted-foreground">
                    {t('modes.compare.speed', 'Speed')}: <span className="font-mono tabular-nums text-foreground">{Number.isFinite(series.speed[cursorIndex]) ? speedText(series.speed[cursorIndex]) : '–'}</span>
                  </span>
                </p>
                <PedalBar label={t('modes.compare.throttle', 'Throttle')} value={series.throttle[cursorIndex]} colour={COLOUR.throttle} testId={`pedal-${key}-throttle`} />
                <PedalBar label={t('modes.compare.brake', 'Brake')} value={series.brake[cursorIndex]} colour={COLOUR.brake} testId={`pedal-${key}-brake`} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
