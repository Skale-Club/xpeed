// The small pieces the dashboard blocks share: a card with a title, a sparkline, and the quiet "nothing here" line.
import { useMemo, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { sparklinePath } from '@/lib/sim/dashboard';

/** A block of the dashboard: a card with a title (and, on the right, a link or a control). */
export function Panel({ title, action, testId, className = '', children }: { title: ReactNode; action?: ReactNode; testId?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={`bg-card border-border ${className}`} data-testid={testId}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          {action}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** What a block says when it has nothing to show: quiet, one line. */
export function Quiet({ children, testId }: { children: ReactNode; testId?: string }) {
  return <p className="text-sm text-muted-foreground" data-testid={testId}>{children}</p>;
}

/** A tiny line of per-day values; decorative (the tile around it says the numbers). Zero points draw nothing, one point is a dot. */
export function Sparkline({ values, color, width = 120, height = 28 }: { values: readonly number[]; color: string; width?: number; height?: number }) {
  const path = useMemo(() => sparklinePath(values, width, height), [values, width, height]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-testid="sparkline" data-points={path.points}>
      {path.d && <path d={path.d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      {path.last && <circle cx={path.last.x} cy={path.last.y} r={2} fill={color} />}
    </svg>
  );
}
