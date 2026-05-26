// Centralized chart series palette. Recharts (and similar libraries) want
// concrete color strings at runtime, so we can't pass `hsl(var(--token))`
// expressions directly. This module is the single source of truth for those
// concrete values, kept in lockstep with the design tokens in src/index.css.
// If you change a token there, mirror it here.

export const CHART_PALETTE = {
  green:     'hsl(152, 60%, 42%)',   // --chart-green / --success
  amber:     'hsl(38, 92%, 55%)',    // --chart-amber / --warn
  red:       'hsl(0, 72%, 55%)',     // --chart-red / --destructive
  blue:      'hsl(210, 80%, 55%)',   // --chart-blue
  purple:    'hsl(270, 60%, 60%)',   // --chart-purple
  yellow:    'hsl(60, 94%, 49%)',    // --primary (brand)
  pink:      'hsl(322, 70%, 60%)',   // distinct series accent
  indigo:    'hsl(243, 70%, 65%)',   // distinct series accent
  blueLight: 'hsl(217, 91%, 65%)',   // secondary blue for "avg" pairings
} as const;

export type ChartColor = keyof typeof CHART_PALETTE;
