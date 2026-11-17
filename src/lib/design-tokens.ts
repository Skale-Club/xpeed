// JS copy of the colour tokens that code needs at runtime (Recharts wants concrete colour strings).
// src/index.css is the source; this mirrors it, and design-tokens.test.ts fails if they drift.

export const COLOR_TOKENS = {
  brand: '54 88% 67%',
  'brand-2': '212 88% 64%',
  'brand-3': '265 72% 70%',
  success: '152 58% 46%',
  warn: '38 92% 58%',
  destructive: '0 75% 60%',
  info: '205 88% 62%',
  'chart-1': '54 88% 67%',
  'chart-2': '212 88% 64%',
  'chart-3': '265 72% 70%',
  'chart-4': '152 58% 46%',
  'chart-5': '38 92% 58%',
  'chart-6': '322 70% 62%',
  'chart-7': '0 75% 60%',
  'chart-8': '243 70% 66%',
  'chart-9': '217 91% 72%',
} as const;

export const tokenColor = (name: keyof typeof COLOR_TOKENS, alpha?: number): string => {
  const v = COLOR_TOKENS[name];
  return alpha === undefined ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
};
