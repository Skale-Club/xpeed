// The Virtual screens' tile with one number: a thin adapter over the shared `StatTile` / `StatGrid` (ui/stat-tile), keeping the props these screens
// already use (`sub` is the quiet line, `tone` the old good/bad/accent names).
import type { ReactNode } from 'react';
import { StatGrid, StatTile as UiStatTile, type StatTone } from '@/components/ui/stat-tile';
import type { Accent } from '@/lib/chart-theme';

export type Tone = 'good' | 'bad' | 'accent' | 'plain';
const TONE: Record<Tone, StatTone> = { good: 'success', bad: 'critical', accent: 'brand', plain: 'default' };

// Dashboards 2027, phase 3 (owner approved 2026-11-20): the Virtual tiles use the shared `feature` look; `accent` gives a tile its colour.
export function StatTile({ label, value, sub, tone = 'plain', hint, testId, children, accent }: {
  label: ReactNode;
  value: ReactNode;
  /** The quiet line under the value. */
  sub?: ReactNode;
  tone?: Tone;
  /** Lap times are set in the monospaced face, as everywhere else (the shared tile always does). */
  mono?: boolean;
  /** What the number means, as a tooltip. */
  hint?: string;
  testId?: string;
  children?: ReactNode;
  accent?: Accent;
}) {
  return <UiStatTile size="feature" accent={accent} label={label} value={value} hint={sub} tone={TONE[tone]} title={hint} testId={testId} footer={children} />;
}

type GridColumns = NonNullable<Parameters<typeof StatGrid>[0]['columns']>;

/** The grid the tiles sit in: two across on a phone, four from `sm` unless `columns` says otherwise. */
export function TileGrid({ children, testId, columns = { sm: 4, lg: null } }: { children: ReactNode; testId?: string; columns?: GridColumns }) {
  return <StatGrid columns={columns} testId={testId}>{children}</StatGrid>;
}
