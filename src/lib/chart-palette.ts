// Centralized chart series palette. Recharts (and similar libraries) want concrete color strings at runtime,
// so `hsl(var(--token))` can't be passed directly. The values come from COLOR_TOKENS in design-tokens.ts,
// which design-tokens.test.ts keeps in sync with src/index.css (--chart-1 … --chart-9).
import { tokenColor } from './design-tokens';

export const CHART_PALETTE = {
  yellow:    tokenColor('chart-1'),  // brand
  blue:      tokenColor('chart-2'),
  purple:    tokenColor('chart-3'),
  green:     tokenColor('chart-4'),  // success
  amber:     tokenColor('chart-5'),  // warn
  pink:      tokenColor('chart-6'),
  red:       tokenColor('chart-7'),  // destructive
  indigo:    tokenColor('chart-8'),
  blueLight: tokenColor('chart-9'),
} as const;

export type ChartColor = keyof typeof CHART_PALETTE;

// The nine series colours in order; use for charts that colour series by index.
export const CHART_SERIES = [
  CHART_PALETTE.yellow,
  CHART_PALETTE.blue,
  CHART_PALETTE.purple,
  CHART_PALETTE.green,
  CHART_PALETTE.amber,
  CHART_PALETTE.pink,
  CHART_PALETTE.red,
  CHART_PALETTE.indigo,
  CHART_PALETTE.blueLight,
] as const;
