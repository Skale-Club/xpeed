// The small pieces the dashboard blocks share: a card with a title, a sparkline, and the quiet "nothing here" line.
import { useMemo, type ReactNode } from 'react';
import { sparklinePath } from '@/lib/sim/dashboard';

/** A block of the dashboard: the shared `Panel` (a card with a title and, on the right, a link or a control). */
export { Panel } from '@/components/ui/panel';

/** What a block says when it has nothing to show: quiet, one line. */
export function Quiet({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="text-sm text-muted-foreground" data-testid={testId}>{children}</p>;
}

/** The drawing of a sparkline from an already computed path: the one svg both sparklines use (decorative; the numbers around it say it). */
export function SparkSvg({ path, color, width, height, testId }: { path: { d: string; last: { x: number; y: number } | null; points: number }; color: string; width: number; height: number; testId: string }) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid={testId} data-points={path.points}>
      {path.d && <path d={path.d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {path.last && <circle cx={path.last.x} cy={path.last.y} r={2} fill={color} />}
    </svg>
  );
}

/** A tiny line of per-day values; decorative (the tile around it says the numbers). Zero points draw nothing, one point is a dot. */
export function Sparkline({ values, color, width = 120, height = 28 }: { values: readonly number[]; color: string; width?: number; height?: number }) {
  const path = useMemo(() => sparklinePath(values, width, height), [values, width, height]);
  return <SparkSvg path={path} color={color} width={width} height={height} testId="sparkline" />;
}
