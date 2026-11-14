// A tile with one number: the look of the Overview's tiles (small label over a big tabular value, a quiet line under it) for the screens that show a set of
// numbers about one thing (the filtered sessions, one session).
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type Tone = 'good' | 'bad' | 'accent' | 'plain';
const TONE: Record<Tone, string> = { good: 'text-green-500', bad: 'text-destructive', accent: 'text-primary', plain: '' };

export function StatTile({ label, value, sub, tone = 'plain', mono = false, hint, testId, children }: {
  label: ReactNode;
  value: ReactNode;
  /** The quiet line under the value. */
  sub?: ReactNode;
  tone?: Tone;
  /** Lap times are set in the monospaced face, as everywhere else. */
  mono?: boolean;
  /** What the number means, as a tooltip. */
  hint?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <li className="min-w-0">
      <Card className="h-full space-y-1 bg-card p-3" data-testid={testId} title={hint}>
        <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className={cn('truncate text-xl font-semibold tabular-nums leading-tight', mono && 'font-mono', TONE[tone])} data-testid={testId ? `${testId}-value` : undefined}>{value}</p>
        <p className="min-h-4 truncate text-xs text-muted-foreground" data-testid={testId ? `${testId}-sub` : undefined}>{sub ?? ' '}</p>
        {children}
      </Card>
    </li>
  );
}

/** The grid the tiles sit in: two across on a phone, more as the screen allows. */
export function TileGrid({ children, testId, columns = 'sm:grid-cols-4' }: { children: ReactNode; testId?: string; columns?: string }) {
  return <ul className={cn('grid grid-cols-2 gap-3', columns)} data-testid={testId}>{children}</ul>;
}
